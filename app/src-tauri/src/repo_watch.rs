//! File events for the Changes view: one recursive watch at a time, of the git
//! toplevel of the repo whose changes show, so an edit anywhere in it can
//! refresh the list. The event names the folder as the webview registered it,
//! while FSEvents reports canonical paths under the toplevel.
//!
//! Under .git only the index, HEAD, the branches (refs/heads) and a reftable
//! repo's tables are kept: a stage, commit, checkout or reset moves one of
//! them, while objects, logs, remote refs and packed-refs change with fetches
//! and gc and say nothing the list shows. Creating or moving a branch writes its
//! loose ref; only deleting a packed branch touches packed-refs alone. A submodule's
//! working tree is dropped, as status runs with `--ignore-submodules=dirty`
//! and check-ignore refuses its paths; what lists it, its commit moving, is
//! kept from its gitdir under .git/modules. The submodules are read once per
//! watch, so one added while the view shows is watched as plain folders.
//!
//! Paths the callback keeps go to a worker thread that gathers them into
//! batches and asks `git check-ignore` once per batch, so a build writing into
//! an ignored folder costs a git run per batch and no IPC. The callback itself
//! runs no git and emits nothing, as it holds FSEvents' thread.
//!
//! Dropping the watcher is the stop: it stops notify's thread and drops the
//! callback, whose sender is the worker's only one, so the worker ends too; a
//! batch the worker is judging then is not emitted, as its live flag was
//! cleared first. As in watch.rs, the webview replaces the watched root in one
//! call with a generation, and a call older than the last applied is ignored,
//! so a watch still in flight never outlives the teardown that followed it.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// The crate, not crate::notify, which posts notifications.
use ::notify::event::{MetadataKind, ModifyKind};
use ::notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::{changes, folders};

pub const REPO_EVENT: &str = "repo-changed";

/// How long a batch gathers paths from its first one. The deadline is fixed,
/// not pushed back by each path, so a build that never pauses cannot hold up
/// the edit gathered with it, and a burst of writes is one check-ignore and at
/// most one event.
const BATCH_MS: u64 = 300;

#[derive(Debug, Clone, PartialEq)]
struct Root {
    canonical: PathBuf,
    lexical: String,
}

#[derive(Default)]
pub struct RepoWatch(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    generation: u64,
    watcher: Option<RecommendedWatcher>,
    root: Option<Root>,
    live: Option<Arc<AtomicBool>>,
}

/// Whether a path inside a git dir is one that moves when the list can.
fn gitdir_kept(parts: &[&OsStr]) -> bool {
    match parts {
        [one] => *one == "index" || *one == "HEAD",
        [first, ..] if *first == "reftable" => true,
        // Adding or lifting an exclusion changes which untracked files are listed.
        [info, exclude] => *info == "info" && *exclude == "exclude",
        [refs, heads, _, ..] => *refs == "refs" && *heads == "heads",
        _ => false,
    }
}

/// Whether a path under .git/modules is a submodule's HEAD or branch. A
/// module's name can hold slashes, so every split is tried; a `logs` folder
/// holds the same names and is not a module's gitdir.
fn module_kept(rest: &[&OsStr]) -> bool {
    (1..rest.len()).any(|i| {
        rest[i - 1] != "logs"
            && match &rest[i..] {
                [head] => *head == "HEAD",
                [refs, heads, _, ..] => *refs == "refs" && *heads == "heads",
                _ => false,
            }
    })
}

/// Whether a path relative to the toplevel can change the list.
fn wanted(rel: &Path, gitlinks: &[PathBuf]) -> bool {
    if gitlinks.iter().any(|g| rel != g && rel.starts_with(g)) {
        return false;
    }
    let parts: Vec<&OsStr> = rel.iter().collect();
    match parts.iter().position(|c| *c == ".git") {
        None => true,
        Some(0) => match &parts[1..] {
            [modules, rest @ ..] if *modules == "modules" => module_kept(rest),
            rest => gitdir_kept(rest),
        },
        // A nested repo's; worth asks git whether it is ignored.
        Some(i) => gitdir_kept(&parts[i + 1..]),
    }
}

/// The paths of `event` that can change the list, relative to `root`; the
/// root itself is the empty path.
fn kept(event: &Event, root: &Path, gitlinks: &[PathBuf]) -> Vec<PathBuf> {
    // A rescan means events were dropped, so the batch must count whatever
    // else it holds.
    if event.need_rescan() {
        return vec![PathBuf::new()];
    }
    match event.kind {
        EventKind::Access(_) => return Vec::new(),
        // The executable bit is a status change; times, ownership and xattrs
        // are not. FSEvents reports a chmod and a touch alike, as Any.
        EventKind::Modify(ModifyKind::Metadata(k)) if !matches!(k, MetadataKind::Permissions | MetadataKind::Any) => return Vec::new(),
        _ => {}
    }
    event.paths.iter().filter_map(|p| p.strip_prefix(root).ok()).filter(|rel| wanted(rel, gitlinks)).map(Path::to_path_buf).collect()
}

/// Whether a batch of paths relative to `top` holds one git does not ignore.
fn worth(top: &Path, batch: &[PathBuf]) -> bool {
    if batch.iter().any(|p| p.iter().next().is_none_or(|c| c == ".git")) {
        return true;
    }
    let names: Vec<String> = batch.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    // A path that is gone is judged by the patterns alone, so a file under a
    // deleted ignored folder stays ignored, while the folder itself, no
    // longer a folder for a `node_modules/` pattern, counts once. A tracked
    // file is never ignored.
    let ignored = folders::ignored_names(top, &names.iter().map(String::as_str).collect::<Vec<_>>());
    names.iter().any(|n| !ignored.contains(n))
}

/// The worker that turns kept paths into events, and the sender it ends with.
fn spawn_worker(top: PathBuf, lexical: String, live: Arc<AtomicBool>, emit: impl Fn(String) + Send + 'static) -> Sender<PathBuf> {
    let (tx, rx) = mpsc::channel::<PathBuf>();
    std::thread::spawn(move || {
        // An Err is the sender gone with the watcher.
        while let Ok(first) = rx.recv() {
            let deadline = Instant::now() + Duration::from_millis(BATCH_MS);
            let mut batch = HashSet::from([first]);
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                match rx.recv_timeout(left) {
                    Ok(p) => {
                        batch.insert(p);
                    }
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            // The watcher may have been replaced while git judged the batch.
            if worth(&top, &batch.into_iter().collect::<Vec<_>>()) && live.load(Ordering::Relaxed) {
                emit(lexical.clone());
            }
        }
    });
    tx
}

fn new_watcher(root: Root, gitlinks: Vec<PathBuf>, live: Arc<AtomicBool>, emit: impl Fn(String) + Send + 'static) -> ::notify::Result<RecommendedWatcher> {
    let tx = spawn_worker(root.canonical.clone(), root.lexical, live, emit);
    let canonical = root.canonical;
    ::notify::recommended_watcher(move |res: ::notify::Result<Event>| match res {
        Ok(event) => {
            for p in kept(&event, &canonical, &gitlinks) {
                // Fails only once the worker is gone, when nothing is wanted.
                let _ = tx.send(p);
            }
        }
        Err(e) => eprintln!("vaquita: watching the repo: {e}"),
    })
}

/// The submodules' paths, relative to `top`: the index's gitlinks.
fn gitlinks(top: &Path) -> Result<Vec<PathBuf>, String> {
    let mut cmd = changes::git(top)?;
    cmd.args(["ls-files", "-z", "--stage"]);
    let out = changes::run(cmd)?;
    if !out.status.success() {
        return Err(changes::failed("git ls-files", &out));
    }
    // Each record is `mode id stage\tpath`.
    Ok(out
        .stdout
        .split(|&b| b == 0)
        .filter(|r| r.starts_with(b"160000 "))
        .filter_map(|r| r.iter().position(|&b| b == b'\t').map(|tab| PathBuf::from(OsStr::from_bytes(&r[tab + 1..]))))
        .collect())
}

/// Makes `root` the watched repo, or watches nothing with None, unless a newer
/// generation was applied.
fn apply(state: &RepoWatch, generation: u64, root: Option<String>, emit: impl Fn(String) + Send + 'static) -> Result<(), String> {
    let mut inner = state.0.lock().unwrap();
    // The webview's calls run on threads of their own and can arrive out of
    // order; an older one would bring back a watch a newer one dropped.
    if generation < inner.generation {
        return Ok(());
    }
    inner.generation = generation;
    if let Some(live) = inner.live.take() {
        live.store(false, Ordering::Relaxed);
    }
    inner.watcher = None;
    inner.root = None;
    let Some(lexical) = root else { return Ok(()) };
    // The list covers the whole repository, so a registered subfolder must
    // not watch less than it lists.
    let canonical = changes::toplevel(Path::new(&lexical))?;
    let links = gitlinks(&canonical)?;
    let root = Root { canonical, lexical };
    let live = Arc::new(AtomicBool::new(true));
    let mut watcher = new_watcher(root.clone(), links, live.clone(), emit).map_err(|e| format!("watching {}: {e}", root.lexical))?;
    watcher.watch(&root.canonical, RecursiveMode::Recursive).map_err(|e| format!("watching {}: {e}", root.lexical))?;
    inner.watcher = Some(watcher);
    inner.root = Some(root);
    inner.live = Some(live);
    Ok(())
}

#[tauri::command]
pub async fn watch_repo(app: AppHandle, generation: u64, root: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let emitter = app.clone();
        let emit = move |root: String| {
            if let Err(e) = emitter.emit_to("main", REPO_EVENT, root) {
                eprintln!("vaquita: sending the changed repo failed: {e}");
            }
        };
        apply(&app.state::<RepoWatch>(), generation, root, emit)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::sync::mpsc::channel;

    use crate::open_path::tests::dir;

    fn sh(d: &Path, args: &[&str]) {
        let s = Command::new("git")
            .arg("-C")
            .arg(d)
            .args(["-c", "user.name=check", "-c", "user.email=check@example.com", "-c", "protocol.file.allow=always"])
            .args(args)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        assert!(s.unwrap().success(), "git {args:?}");
    }

    /// A repo whose .gitignore holds `ignore`, committed.
    fn repo(name: &str, ignore: &str) -> PathBuf {
        let d = dir(name);
        sh(&d, &["init", "-q"]);
        std::fs::write(d.join(".gitignore"), ignore).unwrap();
        sh(&d, &["add", "-A"]);
        sh(&d, &["commit", "-q", "--allow-empty", "-m", "c"]);
        d
    }

    /// `d` with a submodule at deps/sm, committed.
    fn with_submodule(d: &Path, name: &str) {
        let src = repo(name, "");
        sh(d, &["submodule", "add", "-q", src.to_str().unwrap(), "deps/sm"]);
        sh(d, &["commit", "-q", "-m", "sm"]);
    }

    fn at(kind: EventKind, path: &str) -> Event {
        Event::new(kind).add_path(PathBuf::from(path))
    }

    fn rels(paths: &[&str]) -> Vec<PathBuf> {
        paths.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn kept_drops_git_internals_but_not_what_moves_on_a_commit() {
        use ::notify::event::{CreateKind, DataChange};
        let root = Path::new("/x/repo");
        let links = rels(&["deps/sm"]);
        let write = |p: &str| kept(&at(EventKind::Modify(ModifyKind::Data(DataChange::Content)), p), root, &links);
        for p in [
            "src/a.ts",
            ".git/index",
            ".git/HEAD",
            ".git/info/exclude",
            ".git/refs/heads/main.lock",
            ".git/refs/heads/feature/x",
            ".git/reftable/tables.list",
            "sub/.git/index",
            ".git/modules/deps/sm/HEAD",
            ".git/modules/deps/sm/refs/heads/main",
            ".git/modules/a/modules/b/HEAD",
            "deps/sm",
            "deps/smx/a.c",
        ] {
            assert_eq!(write(&format!("/x/repo/{p}")), rels(&[p]), "{p}");
        }
        for p in [
            ".git/objects/ab/cd",
            ".git/refs/remotes/origin/main",
            ".git/refs/tags/v1",
            ".git/packed-refs",
            ".git/ORIG_HEAD",
            ".git/FETCH_HEAD",
            ".git/logs/HEAD",
            ".git/modules/deps/sm/logs/HEAD",
            ".git/modules/deps/sm/logs/refs/heads/main",
            ".git/modules/deps/sm/objects/ab/cd",
            ".git/modules/deps/sm/index",
            ".git/modules/deps/sm/refs/remotes/origin/main",
            "deps/sm/a.c",
            "deps/sm/.git",
            "deps/sm/build/out.o",
        ] {
            assert!(write(&format!("/x/repo/{p}")).is_empty(), "{p}");
        }
        assert!(write("/x/other/a.ts").is_empty());
        assert_eq!(kept(&at(EventKind::Create(CreateKind::File), "/x/repo/new.ts"), root, &links), rels(&["new.ts"]));
    }

    #[test]
    fn kept_counts_a_permission_change_and_not_times_or_access() {
        use ::notify::event::AccessKind;
        let root = Path::new("/x/repo");
        let meta = |k| kept(&at(EventKind::Modify(ModifyKind::Metadata(k)), "/x/repo/src/a.ts"), root, &[]);
        assert!(meta(MetadataKind::WriteTime).is_empty());
        assert!(meta(MetadataKind::Ownership).is_empty());
        assert_eq!(meta(MetadataKind::Permissions), rels(&["src/a.ts"]));
        assert_eq!(meta(MetadataKind::Any), rels(&["src/a.ts"]));
        assert!(kept(&at(EventKind::Access(AccessKind::Any), "/x/repo/src/a.ts"), root, &[]).is_empty());
    }

    #[test]
    fn a_rescan_gives_the_root() {
        use ::notify::event::Flag;
        let event = Event::new(EventKind::Other).add_path(PathBuf::from("/x/repo/.git/objects")).set_flag(Flag::Rescan);
        assert_eq!(kept(&event, Path::new("/x/repo"), &[]), [PathBuf::new()]);
        assert!(worth(Path::new("/nonexistent"), &[PathBuf::new()]));
    }

    #[test]
    fn worth_drops_a_batch_git_ignores() {
        let d = repo("repo-watch-worth", "node_modules/\n*.log\nvendor/\n");
        let marker = d.join("marker");
        let script = d.join("marker.sh");
        std::fs::write(&script, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        sh(&d, &["config", "core.fsmonitor", script.to_str().unwrap()]);
        assert!(!worth(&d, &rels(&["node_modules/pkg/x.js"])));
        assert!(!worth(&d, &rels(&["build.log"])));
        assert!(worth(&d, &rels(&["src/a.ts"])));
        assert!(worth(&d, &rels(&["node_modules/x", ".gitignore"])));
        assert!(worth(&d, &rels(&[".git/index"])));
        assert!(worth(&d, &rels(&["gone/deleted.ts"])));
        // A nested repo's git dir is asked about like any path: a vendored
        // clone under an ignored folder counts for nothing.
        std::fs::create_dir_all(d.join("vendor/lib")).unwrap();
        sh(&d.join("vendor/lib"), &["init", "-q"]);
        std::fs::create_dir_all(d.join("sub")).unwrap();
        sh(&d.join("sub"), &["init", "-q"]);
        assert!(!worth(&d, &rels(&["vendor/lib/.git/index"])));
        assert!(worth(&d, &rels(&["sub/.git/index"])));
        assert!(!marker.exists());
        // git calls .git/index ignored under `*`, so true here means git was
        // never asked.
        let all = repo("repo-watch-all", "*\n");
        assert!(!worth(&all, &rels(&["a.ts"])));
        assert!(worth(&all, &rels(&[".git/index"])));
    }

    #[test]
    fn gitlinks_are_the_submodules() {
        let d = repo("repo-watch-links", "");
        assert!(gitlinks(&d).unwrap().is_empty());
        with_submodule(&d, "repo-watch-links-src");
        assert_eq!(gitlinks(&d).unwrap(), rels(&["deps/sm"]));
    }

    #[test]
    fn a_cleared_live_flag_emits_nothing_and_a_dropped_sender_ends_the_worker() {
        // Not a repo: git answers nothing ignored, so every batch counts.
        let d = dir("repo-watch-live");
        let live = Arc::new(AtomicBool::new(true));
        let (tx, rx) = channel();
        let paths = spawn_worker(d, "/tmp/repo".to_string(), live.clone(), move |r| {
            let _ = tx.send(r);
        });
        paths.send(PathBuf::from("a.ts")).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "/tmp/repo");
        paths.send(PathBuf::from("a.ts")).unwrap();
        live.store(false, Ordering::Relaxed);
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)), Err(RecvTimeoutError::Timeout));
        drop(paths);
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)), Err(RecvTimeoutError::Disconnected));
    }

    // Starts an FSEvents stream, so that stopping it is what releases the
    // callback; it waits for no event.
    #[test]
    fn dropping_the_watcher_ends_the_worker() {
        let d = std::fs::canonicalize(dir("repo-watch-drop")).unwrap();
        let (tx, rx) = channel::<()>();
        // The emit closure, holding tx, lives as long as the worker does.
        let root = Root { canonical: d.clone(), lexical: d.to_string_lossy().into_owned() };
        let mut watcher = new_watcher(root, Vec::new(), Arc::new(AtomicBool::new(true)), move |_| {
            let _ = tx.send(());
        })
        .unwrap();
        watcher.watch(&d, RecursiveMode::Recursive).unwrap();
        drop(watcher);
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)), Err(RecvTimeoutError::Disconnected));
    }

    fn root_of(state: &RepoWatch) -> Option<Root> {
        state.0.lock().unwrap().root.clone()
    }

    fn watching(state: &RepoWatch) -> bool {
        state.0.lock().unwrap().watcher.is_some()
    }

    // Starts an FSEvents stream; it waits for no event.
    #[test]
    fn apply_watches_the_toplevel_and_names_the_folder_given() {
        let d = repo("repo-watch-apply", "");
        std::fs::create_dir_all(d.join("sub")).unwrap();
        let sub = d.join("sub").to_string_lossy().into_owned();
        let state = RepoWatch::default();
        apply(&state, 2, Some(sub.clone()), |_| {}).unwrap();
        let top = std::fs::canonicalize(&d).unwrap();
        let want = Root { canonical: top, lexical: sub.clone() };
        assert_eq!(root_of(&state), Some(want.clone()));
        assert!(watching(&state));
        let live = state.0.lock().unwrap().live.clone().unwrap();
        assert!(live.load(Ordering::Relaxed));
        // Older: neither a teardown nor another root is applied.
        apply(&state, 1, None, |_| {}).unwrap();
        apply(&state, 1, Some(d.to_string_lossy().into_owned()), |_| {}).unwrap();
        assert_eq!(root_of(&state), Some(want));
        assert!(watching(&state));
        assert_eq!(state.0.lock().unwrap().generation, 2);
        apply(&state, 3, None, |_| {}).unwrap();
        assert_eq!(root_of(&state), None);
        assert!(!watching(&state));
        assert!(!live.load(Ordering::Relaxed));
    }

    // Starts an FSEvents stream for the good root; it waits for no event.
    #[test]
    fn a_root_that_cannot_be_watched_is_an_error_and_watches_nothing() {
        let d = repo("repo-watch-refused", "");
        let plain = dir("repo-watch-plain");
        let state = RepoWatch::default();
        apply(&state, 1, Some(d.to_string_lossy().into_owned()), |_| {}).unwrap();
        let missing = plain.join("missing").to_string_lossy().into_owned();
        assert!(apply(&state, 2, Some(missing), |_| {}).is_err());
        assert!(!watching(&state));
        assert_eq!(root_of(&state), None);
        apply(&state, 3, Some(d.to_string_lossy().into_owned()), |_| {}).unwrap();
        assert_eq!(apply(&state, 4, Some(plain.to_string_lossy().into_owned()), |_| {}), Err("not a git repository".to_string()));
        assert!(!watching(&state));
        assert_eq!(root_of(&state), None);
        // An index git cannot read: no submodules known is no watch.
        let broken = repo("repo-watch-broken", "");
        std::fs::write(broken.join(".git/index"), "garbage").unwrap();
        let err = apply(&state, 5, Some(broken.to_string_lossy().into_owned()), |_| {}).unwrap_err();
        assert!(err.starts_with("git ls-files failed: "), "{err}");
        assert!(!watching(&state));
        assert_eq!(root_of(&state), None);
    }

    /// Takes events until none comes for a second, so a late one of an
    /// earlier write is not taken for the next.
    fn drain(rx: &mpsc::Receiver<String>) {
        while rx.recv_timeout(Duration::from_secs(1)).is_ok() {}
    }

    // Needs this Mac's FSEvents, so it is run by hand (`cargo test repo_watch
    // -- --ignored`) and never in release.yml, where a flaky test has blocked
    // a release before.
    #[test]
    #[ignore]
    fn fsevents_report_the_whole_repo_and_not_what_git_ignores() {
        let d = repo("repo-watch-fsevents", "node_modules/\n");
        with_submodule(&d, "repo-watch-fsevents-src");
        // Made before the watch, which reports only what comes after it.
        std::fs::create_dir_all(d.join("sub/a/b")).unwrap();
        std::fs::create_dir_all(d.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(d.join(".git/objects/ab")).unwrap();
        let sub = d.join("sub").to_string_lossy().into_owned();
        let state = RepoWatch::default();
        let (tx, rx) = channel();
        apply(&state, 1, Some(sub.clone()), move |r| {
            let _ = tx.send(r);
        })
        .unwrap();
        let none = Err(RecvTimeoutError::Timeout);
        // What must yield nothing first, so no late event of a counted write
        // is taken for it.
        std::fs::write(d.join(".git/objects/ab/cd"), "x").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)), none);
        std::fs::write(d.join("node_modules/pkg/x.js"), "x").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)), none);
        std::fs::write(d.join("deps/sm/edit.c"), "x").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)), none);
        // A commit inside the submodule moves the commit the repo lists.
        sh(&d.join("deps/sm"), &["commit", "-q", "--allow-empty", "-m", "c"]);
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), sub);
        drain(&rx);
        std::fs::write(d.join("sub/a/b/deep.ts"), "x").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), sub);
        drain(&rx);
        std::fs::write(d.join("beside.ts"), "x").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), sub);
        drain(&rx);
        // An ignored folder written every 50 ms does not hold back the source
        // edit made with it.
        let noisy = d.join("node_modules/pkg");
        let writer = std::thread::spawn(move || {
            for i in 0..40 {
                std::fs::write(noisy.join(format!("{i}.js")), "x").unwrap();
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        std::fs::write(d.join("sub/edit.ts"), "x").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), sub);
        writer.join().unwrap();
        // The teardown ends the worker, which held the emit closure.
        apply(&state, 2, None, |_| {}).unwrap();
        drain(&rx);
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)), Err(RecvTimeoutError::Disconnected));
    }
}
