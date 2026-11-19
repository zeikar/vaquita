//! Which file a bare name in terminal output names, for the webview's path
//! links: the one file of that name, matched exactly, among the files of the
//! starting folder's repo and the starting folder's own, or none when there is
//! no such file or several. The repo's files are what `git ls-files -z --cached
//! --others --exclude-standard` lists at the toplevel, tracked files and the
//! untracked ones git does not ignore, as git alone knows what it ignores; the
//! starting folder's own file is a stat, so an ignored one counts too, and in a
//! folder outside a repo it is the only one. Like `paths_exist`, this decides
//! the underline and nothing about opening: a click still goes through
//! open_path.rs.
//!
//! The list is read on an ask, never on a timer, and again only on an ask once
//! the last read of that folder ended STALE ago; a watch would be one
//! more thing running while nothing is hovered. Each git run is bounded by
//! LIST_MAX bytes of output and READ_MAX of time, past which it is killed and
//! reaped, and a read that fails publishes nothing: the ask that made it
//! answers not known, a list held from before stays, and the next read waits
//! for STALE like any other. A failure says nothing about how many files share
//! a name, so it is never a no. At most LISTS folders' lists are held, and one
//! read of a folder runs at a time.
//!
//! A name comes from the terminal, so it is checked here (no `/`, no NUL, not
//! `.` or `..`) and then is only a key into git's list and one component joined
//! onto the starting folder for a stat; it is never an argument to git, a shell
//! or a glob. Git runs through changes::git, so no command a repository
//! configures runs, and `rev-parse` and `ls-files` enter no submodule.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Serialize, Serializer};

use crate::{changes, open_path};

/// How old a list may be and still answer. A file created in another folder of
/// the repo links by its name within about this; one in the starting folder
/// links at once, by the stat.
const STALE: Duration = Duration::from_secs(10);

/// What one git run may print: about 80,000 paths. A repo past it links no
/// bare name, rather than holding a list that size.
const LIST_MAX: usize = 4 << 20;

/// How long one git run may take. One that takes longer is of a repo too big
/// to list on a hover, or a git that hangs, and holds one of open_path's few
/// slots while it runs.
const READ_MAX: Duration = Duration::from_secs(2);

/// What one name names.
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    /// The one file, there on disk.
    Path(String),
    /// No such file, or several.
    No,
    /// Cannot be told now: no slot, no list, a stat refused.
    Unknown,
}

impl Serialize for Answer {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Answer::Path(p) => s.serialize_str(p),
            Answer::No => s.serialize_bool(false),
            Answer::Unknown => s.serialize_none(),
        }
    }
}

/// Whether a name can be one file's name. Anything else is not looked up.
fn plain(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\0'])
}

/// The listed paths sharing a last component, as far as an answer needs.
#[derive(Debug, PartialEq)]
enum Files {
    One(PathBuf),
    Shared,
}

/// git's NUL-separated list as each name's files.
fn parse(out: &[u8]) -> HashMap<OsString, Files> {
    let mut files = HashMap::new();
    for record in out.split(|&b| b == 0) {
        // A nested repo is listed as its folder, with a slash.
        if record.is_empty() || record.ends_with(b"/") {
            continue;
        }
        let path = Path::new(OsStr::from_bytes(record));
        let Some(name) = path.file_name() else { continue };
        match files.entry(name.to_owned()) {
            Entry::Vacant(e) => {
                e.insert(Files::One(path.to_path_buf()));
            }
            // An unmerged path is listed once per stage, and is one file.
            Entry::Occupied(mut e) => {
                if *e.get() != Files::One(path.to_path_buf()) {
                    e.insert(Files::Shared);
                }
            }
        }
    }
    files
}

/// Enough for git's reason when it fails.
const STDERR_MAX: u64 = 64 * 1024;

const OVER: &str = "its output went past the cap";
const LATE: &str = "it ran past the deadline";

/// Runs cmd with its output read through cap bytes and no more than deadline
/// waited for it; past either, it is killed and reaped and the error says
/// which.
fn bounded(mut cmd: Command, cap: usize, deadline: Duration) -> Result<Output, String> {
    let end = Instant::now() + deadline;
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("run git: {e}"))?;
    // Each pipe is read on a thread of its own, so a full one never stalls git
    // while the other is waited on. A byte past the cap tells it was reached;
    // stderr past its few bytes is drained and dropped.
    let (out_tx, out_rx) = mpsc::channel();
    let stdout = child.stdout.take().expect("piped");
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out_tx.send(stdout.take(cap as u64 + 1).read_to_end(&mut b).map(|_| b));
    });
    let (err_tx, err_rx) = mpsc::channel();
    let mut stderr = child.stderr.take().expect("piped");
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let r = (&mut stderr).take(STDERR_MAX).read_to_end(&mut b).and_then(|_| std::io::copy(&mut stderr, &mut std::io::sink()));
        let _ = err_tx.send(r.map(|_| b));
    });
    let left = || end.saturating_duration_since(Instant::now());
    let mut collect = || {
        let stdout = match out_rx.recv_timeout(left()) {
            Ok(Ok(b)) if b.len() > cap => return Err(OVER.to_string()),
            Ok(Ok(b)) => b,
            Ok(Err(e)) => return Err(format!("read git: {e}")),
            Err(_) => return Err(LATE.to_string()),
        };
        // git closes its output as it exits, so this waits a moment at most.
        let status = loop {
            if let Some(s) = child.try_wait().map_err(|e| format!("wait for git: {e}"))? {
                break s;
            }
            if left().is_zero() {
                return Err(LATE.to_string());
            }
            std::thread::sleep(Duration::from_millis(2));
        };
        let stderr = match err_rx.recv_timeout(left()) {
            Ok(Ok(b)) => b,
            Ok(Err(e)) => return Err(format!("read git: {e}")),
            Err(_) => return Err(LATE.to_string()),
        };
        Ok(Output { status, stdout, stderr })
    };
    let result = collect();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

/// A repo's list with where the starting folder sits in it.
#[derive(Debug)]
struct List {
    top: PathBuf,
    files: HashMap<OsString, Files>,
    /// The starting folder's canonical path under top, so its own file is
    /// told from a listed one of the same name.
    here: PathBuf,
}

/// What a read that succeeded found.
#[derive(Debug)]
enum Known {
    List(List),
    NoRepo,
}

/// The files of the folder's repo, or why they could not be listed.
fn read(folder: &Path, cap: usize, deadline: Duration) -> Result<Known, String> {
    let mut cmd = changes::git(folder)?;
    cmd.args(["rev-parse", "--show-toplevel"]);
    let top = match changes::toplevel_of(&bounded(cmd, cap, deadline)?) {
        Ok(top) => top,
        Err(e) if e == changes::NOT_A_REPO => return Ok(Known::NoRepo),
        Err(e) => return Err(e),
    };
    // From a subfolder git lists only that subtree.
    let mut cmd = changes::git(&top)?;
    cmd.args(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    let out = bounded(cmd, cap, deadline)?;
    if !out.status.success() {
        return Err(changes::failed("git ls-files", &out));
    }
    // The toplevel git names is canonical, so the folder is made so to place it.
    let canonical = std::fs::canonicalize(folder).map_err(|e| format!("canonicalize: {e}"))?;
    let here = canonical.strip_prefix(&top).map_err(|_| "the folder is not under its toplevel".to_string())?.to_path_buf();
    Ok(Known::List(List { top, files: parse(&out.stdout), here }))
}

/// How many starting folders' lists are held: a few sessions' worth, each up to
/// LIST_MAX of paths.
const LISTS: usize = 4;

/// Per starting folder, the last list read successfully, when its last read
/// ended and whether one is in flight.
#[derive(Default, Clone)]
pub struct Lists(Arc<Mutex<HashMap<PathBuf, Held>>>);

#[derive(Default)]
struct Held {
    known: Option<Arc<Known>>,
    ended: Option<Instant>,
    reading: bool,
}

impl Lists {
    /// The list to answer from, read first with read when the folder's last
    /// read ended at least stale ago or there was none, and none is in flight.
    fn get(&self, folder: &Path, stale: Duration, read: impl FnOnce() -> Result<Known, String>) -> Option<Arc<Known>> {
        {
            let mut held = self.0.lock().unwrap();
            match held.get(folder) {
                Some(h) if h.reading || h.ended.is_some_and(|t| t.elapsed() < stale) => return h.known.clone(),
                Some(_) => {}
                None => {
                    if held.len() >= LISTS {
                        // A read in flight is kept, so its end has its entry.
                        let oldest = held.iter().min_by_key(|(_, h)| (h.reading, h.ended)).map(|(f, _)| f.clone());
                        held.remove(&oldest.expect("held is not empty"));
                    }
                }
            }
            held.entry(folder.to_path_buf()).or_default().reading = true;
        }
        // Ends the read however it ends, a panic too, so the folder is read again.
        let _ending = Ending(self, folder);
        let read = read().map(Arc::new);
        match read {
            Ok(known) => {
                if let Some(h) = self.0.lock().unwrap().get_mut(folder) {
                    h.known = Some(known.clone());
                }
                Some(known)
            }
            Err(e) => {
                eprintln!("vaquita: list the files of {}: {e}", folder.display());
                None
            }
        }
    }
}

struct Ending<'a>(&'a Lists, &'a Path);

impl Drop for Ending<'_> {
    fn drop(&mut self) {
        if let Some(h) = self.0.0.lock().unwrap_or_else(|e| e.into_inner()).get_mut(self.1) {
            h.reading = false;
            h.ended = Some(Instant::now());
        }
    }
}

/// Each name's answer, in order, reading the folder's list when it is due.
fn find(lists: &Lists, folder: &Path, names: &[String], stale: Duration, cap: usize, deadline: Duration) -> Vec<Answer> {
    let known = lists.get(folder, stale, || read(folder, cap, deadline));
    names
        .iter()
        .map(|name| match &known {
            _ if !plain(name) => Answer::No,
            None => Answer::Unknown,
            Some(known) => answer(folder, name, known),
        })
        .collect()
}

/// The one file a plain name names, by a list read successfully.
fn answer(folder: &Path, name: &str, known: &Known) -> Answer {
    let own = folder.join(name);
    let listed = match known {
        Known::NoRepo => None,
        Known::List(l) => match l.files.get(OsStr::new(name)) {
            None => None,
            Some(Files::Shared) => return Answer::No,
            // The starting folder's own file, listed: one file.
            Some(Files::One(p)) if *p == l.here.join(name) => return on_disk(l.top.join(p)),
            Some(Files::One(p)) => Some(l.top.join(p)),
        },
    };
    match (listed, open_path::on_disk(&own)) {
        (_, None) => Answer::Unknown,
        (None, Some(_)) => on_disk(own),
        (Some(_), Some(true)) => Answer::No,
        (Some(p), Some(false)) => on_disk(p),
    }
}

/// The path when the disk has it.
fn on_disk(path: PathBuf) -> Answer {
    match open_path::on_disk(&path) {
        // The webview takes a path as a string; one that is no UTF-8 is not linked.
        Some(true) => path.into_os_string().into_string().map_or(Answer::No, Answer::Path),
        Some(false) => Answer::No,
        None => Answer::Unknown,
    }
}

// One answer per name, in order. With no slot free every answer is null and
// no thread is spawned; the slot is open_path's, so stats and list reads
// together hold no more than its few blocking threads.
#[tauri::command]
pub async fn find_names(lists: tauri::State<'_, Lists>, folder: String, names: Vec<String>) -> Result<Vec<Answer>, String> {
    let Some(slot) = open_path::SLOTS.take() else { return Ok(vec![Answer::Unknown; names.len()]) };
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    let Ok(folder) = open_path::locate(&folder, "", Path::new(&home)) else { return Ok(vec![Answer::No; names.len()]) };
    let lists = lists.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = slot;
        find(&lists, &folder, &names, STALE, LIST_MAX, READ_MAX)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open_path::tests::{dir, file};

    const LONG: Duration = Duration::from_secs(3600);
    const CAP: usize = 1 << 20;
    const TIME: Duration = Duration::from_secs(10);

    fn sh(d: &Path, args: &[&str]) {
        let s = Command::new("git")
            .arg("-C")
            .arg(d)
            .args(args)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .stdout(Stdio::null())
            .status();
        assert!(s.unwrap().success(), "git {args:?}");
    }

    /// A repo whose .gitignore holds `ignore`, with the given files in it, the
    /// ones in `tracked` added to the index.
    fn repo(name: &str, ignore: &str, files: &[&str], tracked: &[&str]) -> PathBuf {
        let d = dir(&format!("names-{name}"));
        sh(&d, &["init", "-q"]);
        std::fs::write(d.join(".gitignore"), ignore).unwrap();
        for f in files {
            let p = d.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            file(p.parent().unwrap(), p.file_name().unwrap().to_str().unwrap(), 0o644);
        }
        for t in tracked {
            sh(&d, &["add", t]);
        }
        d
    }

    fn top(d: &Path) -> PathBuf {
        std::fs::canonicalize(d).unwrap()
    }

    fn path(p: PathBuf) -> Answer {
        Answer::Path(p.into_os_string().into_string().unwrap())
    }

    fn ask(lists: &Lists, folder: &Path, names: &[&str]) -> Vec<Answer> {
        ask_with(lists, folder, names, LONG, CAP, TIME)
    }

    fn ask_with(lists: &Lists, folder: &Path, names: &[&str], stale: Duration, cap: usize, deadline: Duration) -> Vec<Answer> {
        let names: Vec<String> = names.iter().map(|n| n.to_string()).collect();
        find(lists, folder, &names, stale, cap, deadline)
    }

    fn listed(k: Result<Known, String>) -> (PathBuf, Vec<String>) {
        let Ok(Known::List(l)) = k else { panic!("not a list: {k:?}") };
        let mut names: Vec<String> = l.files.keys().map(|k| k.to_string_lossy().into_owned()).collect();
        names.sort();
        (l.here, names)
    }

    #[test]
    fn the_webview_asks_for_names_and_gets_three_answers() {
        let answers = [Answer::Path("/tmp/repo/a.ts".to_string()), Answer::No, Answer::Unknown];
        assert_eq!(serde_json::to_string(&answers).unwrap(), r#"["/tmp/repo/a.ts",false,null]"#);
    }

    #[test]
    fn only_a_plain_name_is_looked_up() {
        for n in ["a.ts", ".env", "a b.ts", "ü.md"] {
            assert!(plain(n), "{n}");
        }
        for n in ["", ".", "..", "a/b.ts", "/a.ts", "a\0.ts"] {
            assert!(!plain(n), "{n:?}");
        }
    }

    #[test]
    fn the_list_is_each_names_one_path_or_shared() {
        let files = parse(b"src/a.ts\0lib/a.ts\0c.ts\0d/c.ts\0x/m.rs\0x/m.rs\0x/m.rs\0nested/\0top.md\0");
        assert_eq!(files.get(OsStr::new("a.ts")), Some(&Files::Shared));
        assert_eq!(files.get(OsStr::new("c.ts")), Some(&Files::Shared));
        assert_eq!(files.get(OsStr::new("m.rs")), Some(&Files::One(PathBuf::from("x/m.rs"))));
        assert_eq!(files.get(OsStr::new("top.md")), Some(&Files::One(PathBuf::from("top.md"))));
        assert_eq!(files.get(OsStr::new("nested")), None);
        assert_eq!(files.len(), 4);
    }

    #[test]
    fn a_bounded_run_gives_its_output() {
        let mut cmd = Command::new("/bin/echo");
        cmd.arg("hi");
        let out = bounded(cmd, 1024, TIME).unwrap();
        assert!(out.status.success());
        assert_eq!(out.stdout, b"hi\n");
    }

    #[test]
    fn a_bounded_run_stops_past_its_cap() {
        let mut cmd = Command::new("/usr/bin/yes");
        cmd.arg("y");
        assert_eq!(bounded(cmd, 1024, TIME).unwrap_err(), OVER);
    }

    #[test]
    fn a_bounded_run_stops_past_its_deadline() {
        let mut cmd = Command::new("/bin/sleep");
        cmd.arg("30");
        let start = Instant::now();
        assert_eq!(bounded(cmd, 1024, Duration::from_millis(100)).unwrap_err(), LATE);
        assert!(start.elapsed() < Duration::from_secs(1), "{:?}", start.elapsed());
    }

    #[test]
    fn the_list_holds_tracked_and_untracked_files_but_no_ignored_one() {
        let d = repo("read", "*.log\n", &["a.ts", "b.ts", "c.log"], &["a.ts"]);
        assert_eq!(listed(read(&d, CAP, TIME)), (PathBuf::new(), vec![".gitignore".to_string(), "a.ts".to_string(), "b.ts".to_string()]));
    }

    #[test]
    fn a_subfolder_reads_the_whole_repos_list() {
        let d = repo("read-sub", "", &["sub/a.ts", "other/b.ts"], &[]);
        let (here, names) = listed(read(&d.join("sub"), CAP, TIME));
        assert_eq!(here, PathBuf::from("sub"));
        assert_eq!(names, [".gitignore", "a.ts", "b.ts"]);
    }

    #[test]
    fn a_folder_outside_a_repo_has_no_repo() {
        assert!(matches!(read(&dir("names-plain"), CAP, TIME), Ok(Known::NoRepo)));
    }

    #[test]
    fn a_read_that_git_fails_or_a_bound_stops_is_an_error() {
        let d = repo("read-bounds", "", &["a.ts"], &[]);
        assert_eq!(read(&d, 4, TIME).unwrap_err(), OVER);
        assert_eq!(read(&d, CAP, Duration::ZERO).unwrap_err(), LATE);
        let mut config = std::fs::OpenOptions::new().append(true).open(d.join(".git/config")).unwrap();
        std::io::Write::write_all(&mut config, b"[[[broken\n").unwrap();
        let e = read(&d, CAP, TIME).unwrap_err();
        assert!(e.contains("bad config line"), "{e}");
    }

    #[test]
    fn reading_runs_no_fsmonitor_hook_the_repo_sets() {
        let d = repo("read-fsmonitor", "marker*\n", &["a.ts"], &["a.ts"]);
        let hook = d.join("marker.sh");
        std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", d.join("marker").display())).unwrap();
        std::fs::set_permissions(&hook, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        sh(&d, &["config", "core.fsmonitor", hook.to_str().unwrap()]);
        listed(read(&d, CAP, TIME));
        assert!(!d.join("marker").exists());
    }

    fn folder(i: usize) -> PathBuf {
        PathBuf::from(format!("/tmp/repo{i}"))
    }

    fn held(lists: &Lists) -> Vec<PathBuf> {
        let mut held: Vec<PathBuf> = lists.0.lock().unwrap().keys().cloned().collect();
        held.sort();
        held
    }

    #[test]
    fn a_fifth_folder_drops_the_one_read_longest_ago() {
        let lists = Lists::default();
        for i in 1..=5 {
            assert!(lists.get(&folder(i), LONG, || Ok(Known::NoRepo)).is_some());
        }
        assert_eq!(held(&lists), (2..=5).map(folder).collect::<Vec<_>>());
    }

    #[test]
    fn a_read_in_flight_is_not_the_one_dropped() {
        let lists = Lists::default();
        let inner = lists.clone();
        lists.get(&folder(1), LONG, || {
            for i in 2..=5 {
                inner.get(&folder(i), LONG, || Ok(Known::NoRepo));
            }
            Ok(Known::NoRepo)
        });
        assert_eq!(held(&lists), [1, 3, 4, 5].map(folder));
    }

    #[test]
    fn a_failed_read_keeps_the_list_held_and_answers_not_known() {
        let lists = Lists::default();
        assert!(lists.get(&folder(1), Duration::ZERO, || Ok(Known::NoRepo)).is_some());
        assert!(lists.get(&folder(1), Duration::ZERO, || Err("no".to_string())).is_none());
        assert!(matches!(lists.get(&folder(1), LONG, || panic!("read again")).as_deref(), Some(Known::NoRepo)));
    }

    #[test]
    fn a_read_in_flight_is_not_started_twice() {
        let lists = Lists::default();
        let inner = lists.clone();
        let got = lists.get(&folder(1), Duration::ZERO, || {
            assert!(inner.get(&folder(1), Duration::ZERO, || panic!("read twice")).is_none());
            Ok(Known::NoRepo)
        });
        assert!(got.is_some());
    }

    #[test]
    fn a_name_one_listed_file_has_names_it() {
        let d = repo("one", "", &["src/lib/util.ts", "src/a.ts", "docs/a.ts"], &["src/a.ts"]);
        let lists = Lists::default();
        assert_eq!(ask(&lists, &d, &["util.ts", "a.ts", "none.ts"]), [path(top(&d).join("src/lib/util.ts")), Answer::No, Answer::No]);
    }

    #[test]
    fn the_starting_folders_own_listed_file_counts_once() {
        let d = repo("own", "", &["a.ts", "sub/b.ts"], &[]);
        let lists = Lists::default();
        assert_eq!(ask(&lists, &d, &["a.ts"]), [path(top(&d).join("a.ts"))]);
        assert_eq!(ask(&lists, &d.join("sub"), &["b.ts"]), [path(top(&d).join("sub/b.ts"))]);
    }

    #[test]
    fn the_starting_folders_file_and_another_of_its_name_are_two() {
        let d = repo("two", "ignored/\n", &["sub/a.ts", "a.ts", "ignored/b.ts", "other/b.ts"], &[]);
        let lists = Lists::default();
        assert_eq!(ask(&lists, &d.join("sub"), &["a.ts"]), [Answer::No]);
        assert_eq!(ask(&lists, &d.join("ignored"), &["b.ts"]), [Answer::No]);
    }

    #[test]
    fn an_ignored_file_only_the_starting_folder_has_is_named() {
        let d = repo("ignored", "*.log\n", &["sub/x.log"], &[]);
        let lists = Lists::default();
        assert_eq!(ask(&lists, &d.join("sub"), &["x.log"]), [path(d.join("sub/x.log"))]);
    }

    #[test]
    fn outside_a_repo_the_starting_folder_alone_counts() {
        let d = dir("names-outside");
        file(&d, "a.ts", 0o644);
        let lists = Lists::default();
        assert_eq!(ask(&lists, &d, &["a.ts", "b.ts"]), [path(d.join("a.ts")), Answer::No]);
    }

    #[test]
    fn in_a_repo_git_fails_on_every_name_is_not_known() {
        let d = repo("broken", "", &["a.ts"], &[]);
        let mut config = std::fs::OpenOptions::new().append(true).open(d.join(".git/config")).unwrap();
        std::io::Write::write_all(&mut config, b"[[[broken\n").unwrap();
        let lists = Lists::default();
        assert_eq!(ask(&lists, &d, &["a.ts", "b.ts"]), [Answer::Unknown, Answer::Unknown]);
    }

    #[test]
    fn a_name_that_is_no_file_name_is_no() {
        let d = repo("shape", "", &["a/b.ts"], &[]);
        let lists = Lists::default();
        assert_eq!(ask(&lists, &d, &["a/b.ts", "..", ""]), [Answer::No, Answer::No, Answer::No]);
    }

    #[test]
    fn a_file_created_since_the_read_links_once_it_is_read_again() {
        let d = repo("created", "", &["a.ts"], &[]);
        let lists = Lists::default();
        assert_eq!(ask(&lists, &d, &["new.ts"]), [Answer::No]);
        std::fs::create_dir(d.join("sub")).unwrap();
        file(&d.join("sub"), "new.ts", 0o644);
        assert_eq!(ask(&lists, &d, &["new.ts"]), [Answer::No]);
        assert_eq!(ask_with(&lists, &d, &["new.ts"], Duration::ZERO, CAP, TIME), [path(top(&d).join("sub/new.ts"))]);
    }

    #[test]
    fn a_listed_file_removed_since_is_no() {
        let d = repo("removed", "", &["sub/a.ts"], &[]);
        let lists = Lists::default();
        assert_eq!(ask(&lists, &d, &["a.ts"]), [path(top(&d).join("sub/a.ts"))]);
        std::fs::remove_file(d.join("sub/a.ts")).unwrap();
        assert_eq!(ask(&lists, &d, &["a.ts"]), [Answer::No]);
    }

    #[test]
    fn a_read_a_bound_stops_is_not_known_and_tried_again() {
        let d = repo("bounds", "", &["sub/a.ts"], &[]);
        let lists = Lists::default();
        assert_eq!(ask_with(&lists, &d, &["a.ts"], LONG, 4, TIME), [Answer::Unknown]);
        assert_eq!(ask_with(&lists, &d, &["a.ts"], Duration::ZERO, CAP, TIME), [path(top(&d).join("sub/a.ts"))]);
        assert_eq!(ask_with(&lists, &d, &["a.ts"], Duration::ZERO, CAP, Duration::ZERO), [Answer::Unknown]);
        assert_eq!(ask(&lists, &d, &["a.ts"]), [path(top(&d).join("sub/a.ts"))]);
    }
}
