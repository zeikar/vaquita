//! A repo's uncommitted work against HEAD, staged, unstaged and untracked, for
//! the files panel's Changes view. The rows come from `git status
//! --porcelain=v2 -z --untracked-files=all --renames --ignore-submodules=dirty`:
//! the flags, not the repo's `status.*` or `diff.ignoreSubmodules` config,
//! decide what is listed, and `dirty` keeps git out of submodule working trees,
//! whose own config could name a hook, so a submodule is listed only when the
//! commit it is at differs from HEAD's. The counts come from `git diff
//! --numstat -z -M --no-ext-diff --no-textconv --ignore-submodules=dirty HEAD`;
//! an untracked file, or every file of a repo with no commit yet, is counted
//! by reading it when it looks like text and is under files::TEXT_MAX; only a
//! file that is not has no count. Paths are relative to the toplevel git
//! names, which is canonical.
//!
//! No command a repository configures runs. folders::git_in turns off the
//! fsmonitor hook and optional locks; `--no-ext-diff` and `--no-textconv`
//! keep diff drivers out. Optional locks off does not stop `git diff` from
//! refreshing a stat-dirty index, which writes it and runs the
//! `post-index-change` hook a repo's `core.hooksPath` may name (and the watch
//! would see the write as a change), so the diff gets `-c
//! diff.autoRefreshIndex=false`. A status or diff runs the clean filter of a
//! stat-dirty file, so every filter driver a repository's own config (local
//! or worktree scope, includes too) names is emptied with `-c` (git treats an
//! empty command as no filter, and `required=false` keeps that from failing
//! the command); a driver the user's global or system config sets, such as
//! Git LFS's, runs as it does for the user's own git. The cost: a stat-dirty
//! file whose filter only the repo's config sets (git-crypt writes its own
//! there) is listed as changed with its content the same. `--no-lazy-fetch` stops
//! a partial clone from fetching a missing object through the transport the
//! repo configures; a git older than 2.46 refuses the option, which is
//! reported, never retried without it.
//!
//! The letters: untracked is U; a D on either side is D, else R, else A or C
//! is A, else M (a type change too); an unmerged path is C. A path that is
//! both, as after `git rm --cached`, is listed once as its tracked change.
//! With no commit yet, all but D is U. At most CHANGES_CAP rows come back, in
//! git's order, with the total.

use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::Read;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde::Serialize;

use crate::{files, folders};

pub const CHANGES_CAP: usize = 2000;

#[derive(Debug, Serialize)]
pub struct Change {
    /// Relative to the toplevel.
    path: String,
    abs: String,
    status: String,
    added: Option<u64>,
    removed: Option<u64>,
    /// The path a rename came from.
    from: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ChangeList {
    root: String,
    entries: Vec<Change>,
    total: usize,
}

fn git(folder: &Path) -> Result<Command, String> {
    let mut cmd = folders::git_in(folder).ok_or("git is not installed")?;
    cmd.arg("--no-lazy-fetch");
    Ok(cmd)
}

fn run(mut cmd: Command) -> Result<Output, String> {
    cmd.output().map_err(|e| format!("run git: {e}"))
}

/// The error for an exit status the caller does not name.
fn failed(what: &str, out: &Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.code() == Some(129) && stderr.starts_with("unknown option: --no-lazy-fetch") {
        return "Changes needs git 2.46 or later".to_string();
    }
    let reason = stderr.trim();
    if reason.is_empty() {
        format!("{what} failed: {}", out.status)
    } else {
        format!("{what} failed: {reason}")
    }
}

pub(crate) fn toplevel(folder: &Path) -> Result<PathBuf, String> {
    let mut cmd = git(folder)?;
    cmd.args(["rev-parse", "--show-toplevel"]);
    let out = run(cmd)?;
    match out.status.code() {
        Some(0) => Ok(PathBuf::from(std::ffi::OsStr::from_bytes(out.stdout.strip_suffix(b"\n").unwrap_or(&out.stdout)))),
        Some(128) if String::from_utf8_lossy(&out.stderr).contains("not a git repository") => Err("not a git repository".to_string()),
        _ => Err(failed("git rev-parse", &out)),
    }
}

fn has_head(top: &Path) -> Result<bool, String> {
    let mut cmd = git(top)?;
    cmd.args(["rev-parse", "--verify", "-q", "HEAD"]);
    let out = run(cmd)?;
    match out.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(failed("git rev-parse", &out)),
    }
}

/// The `-c` pairs that empty every filter driver the repository's own config
/// sets.
fn filter_overrides(top: &Path) -> Result<Vec<String>, String> {
    overrides_from(git(top)?)
}

fn overrides_from(mut cmd: Command) -> Result<Vec<String>, String> {
    cmd.args(["config", "--show-scope", "--null", "--get-regexp", r"^filter\..*\.(clean|smudge|process|required)$"]);
    let out = run(cmd)?;
    match out.status.code() {
        Some(0) => {}
        Some(1) => return Ok(Vec::new()),
        _ => return Err(failed("git config", &out)),
    }
    let mut names: Vec<String> = Vec::new();
    // scope\0key\nvalue\0, or scope\0key\0 for a boolean with no value.
    let mut records = out.stdout.split(|&b| b == 0);
    while let Some(scope) = records.next() {
        let Some(record) = records.next() else { break };
        // An unknown scope means the records are out of step; skipping it could
        // leave a repository's own filter running, so it fails instead.
        match scope {
            b"local" | b"worktree" => {}
            b"system" | b"global" | b"command" => continue,
            _ => return Err(format!("git config: unexpected scope {:?}", String::from_utf8_lossy(scope))),
        }
        let key = String::from_utf8_lossy(record.split(|&b| b == b'\n').next().unwrap_or_default()).into_owned();
        let Some(name) = key.strip_prefix("filter.").and_then(|k| k.rsplit_once('.')).map(|(n, _)| n) else { continue };
        // `-c` splits at the first `=`, so such a name could not be emptied.
        if name.contains('=') {
            return Err(format!("a filter driver named {name:?} cannot be turned off"));
        }
        if !names.iter().any(|n| n == name) {
            names.push(name.to_string());
        }
    }
    let mut args = Vec::new();
    for n in names {
        for pair in [format!("filter.{n}.clean="), format!("filter.{n}.smudge="), format!("filter.{n}.process="), format!("filter.{n}.required=false")] {
            args.push("-c".to_string());
            args.push(pair);
        }
    }
    Ok(args)
}

fn letter(xy: &[u8]) -> Option<char> {
    let [x, y] = *xy else { return None };
    Some(if x == b'D' || y == b'D' {
        'D'
    } else if x == b'R' || y == b'R' {
        'R'
    } else if [x, y].iter().any(|&c| c == b'A' || c == b'C') {
        'A'
    } else {
        'M'
    })
}

/// Each listed path with the path a rename came from and its letter.
fn status_entries(top: &Path, overrides: &[String]) -> Result<Vec<(String, Option<String>, char)>, String> {
    let mut cmd = git(top)?;
    cmd.args(overrides).args(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--renames", "--ignore-submodules=dirty"]);
    let out = run(cmd)?;
    if !out.status.success() {
        return Err(failed("git status", &out));
    }
    let lossy = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
    let bad = || "git status: unexpected output".to_string();
    let mut rows = Vec::new();
    let mut records = out.stdout.split(|&b| b == 0).filter(|r| !r.is_empty());
    while let Some(r) = records.next() {
        // Fields before the path: 8 for an ordinary change, 9 for a rename or
        // copy, whose source is the next record, and 10 for an unmerged path.
        let (n, renamed) = match r.first() {
            Some(b'?') => {
                rows.push((lossy(r.strip_prefix(b"? ").ok_or_else(bad)?), None, 'U'));
                continue;
            }
            Some(b'1') => (9, false),
            Some(b'2') => (10, true),
            Some(b'u') => (11, false),
            _ => return Err(bad()),
        };
        let fields: Vec<&[u8]> = r.splitn(n, |&b| b == b' ').collect();
        if fields.len() != n {
            return Err(bad());
        }
        let c = if r[0] == b'u' { 'C' } else { letter(fields[1]).ok_or_else(bad)? };
        let from = if renamed { Some(lossy(records.next().ok_or_else(bad)?)) } else { None };
        rows.push((lossy(fields[n - 1]), from, c));
    }
    // An index entry removed with the file kept is a tracked deletion and an
    // untracked file at once; the deletion is what the user did.
    let tracked: HashSet<String> = rows.iter().filter(|r| r.2 != 'U').map(|r| r.0.clone()).collect();
    rows.retain(|r| r.2 != 'U' || !tracked.contains(&r.0));
    Ok(rows)
}

type Counts = (Option<u64>, Option<u64>);

/// Lines added and removed by path against HEAD, None for a binary file; a
/// rename is under its new path.
fn numstat(top: &Path, head: bool, overrides: &[String]) -> Result<HashMap<String, Counts>, String> {
    if !head {
        return Ok(HashMap::new());
    }
    let mut cmd = git(top)?;
    cmd.args(overrides).args(["-c", "diff.autoRefreshIndex=false", "diff", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty", "HEAD"]);
    let out = run(cmd)?;
    if !out.status.success() {
        return Err(failed("git diff", &out));
    }
    let bad = || "git diff --numstat: unexpected output".to_string();
    let count = |s: &[u8]| -> Result<Option<u64>, String> {
        if s == b"-" {
            return Ok(None);
        }
        std::str::from_utf8(s).ok().and_then(|s| s.parse().ok()).map(Some).ok_or_else(bad)
    };
    let lossy = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
    let mut map = HashMap::new();
    let mut records = out.stdout.split(|&b| b == 0);
    while let Some(r) = records.next() {
        if r.is_empty() {
            continue;
        }
        let fields: Vec<&[u8]> = r.splitn(3, |&b| b == b'\t').collect();
        let [added, removed, path] = fields[..] else { return Err(bad()) };
        let path = if path.is_empty() {
            records.next().ok_or_else(bad)?;
            records.next().ok_or_else(bad)?
        } else {
            path
        };
        map.insert(lossy(path), (count(added)?, count(removed)?));
    }
    Ok(map)
}

/// The lines of a regular file of at most files::TEXT_MAX bytes with no NUL
/// in its first 8 KiB; None for anything else.
fn count_lines(abs: &Path) -> Option<u64> {
    // A link is not followed, so an untracked one never reads a file outside
    // the repo; nonblocking, so a FIFO cannot hang the open.
    let f = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(abs).ok()?;
    let meta = f.metadata().ok()?;
    if !meta.is_file() || meta.len() > files::TEXT_MAX {
        return None;
    }
    let mut bytes = Vec::new();
    f.take(files::TEXT_MAX + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > files::TEXT_MAX || bytes[..bytes.len().min(8 * 1024)].contains(&0) {
        return None;
    }
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count() as u64;
    Some(newlines + u64::from(bytes.last().is_some_and(|&b| b != b'\n')))
}

pub fn list(folder: &Path, cap: usize) -> Result<ChangeList, String> {
    let top = toplevel(folder)?;
    let overrides = filter_overrides(&top)?;
    let mut rows = status_entries(&top, &overrides)?;
    let head = has_head(&top)?;
    let mut counts = numstat(&top, head, &overrides)?;
    let total = rows.len();
    rows.truncate(cap);
    let entries = rows
        .into_iter()
        .map(|(path, from, c)| {
            let abs = top.join(&path);
            // With no commit there is nothing to diff against: all of it is
            // new, but for what was added and then deleted.
            let c = if head || c == 'D' { c } else { 'U' };
            let (added, removed) = if c == 'U' {
                let n = count_lines(&abs);
                (n, n.map(|_| 0))
            } else {
                // A staged rename whose new path is gone from disk is, against
                // HEAD, a deletion of the path it came from; a change that
                // leaves the file as HEAD has it, as one staged and then
                // reverted, has no line at all.
                let hit = counts.remove(&path);
                hit.or_else(|| from.as_ref().and_then(|f| counts.remove(f))).unwrap_or((Some(0), Some(0)))
            };
            Change { path, abs: abs.to_string_lossy().into_owned(), status: c.to_string(), added, removed, from }
        })
        .collect();
    Ok(ChangeList { root: top.to_string_lossy().into_owned(), entries, total })
}

#[tauri::command]
pub async fn git_changes(root: String) -> Result<ChangeList, String> {
    tauri::async_runtime::spawn_blocking(move || list(Path::new(&root), CHANGES_CAP)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open_path::tests::dir;
    use std::os::unix::process::ExitStatusExt;

    fn sh(d: &Path, args: &[&str]) {
        let s = Command::new("git")
            .arg("-C")
            .arg(d)
            .args(["-c", "user.name=check", "-c", "user.email=check@example.com"])
            .args(args)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .stdout(std::process::Stdio::null())
            .status();
        assert!(s.unwrap().success(), "git {args:?}");
    }

    fn repo(name: &str) -> PathBuf {
        let d = dir(name);
        sh(&d, &["init", "-q"]);
        d
    }

    fn commit(d: &Path) {
        sh(d, &["add", "-A"]);
        sh(d, &["commit", "-q", "-m", "c"]);
    }

    /// A script that leaves d/marker behind when git runs it.
    fn marker_script(d: &Path) -> PathBuf {
        let p = d.join("marker.sh");
        std::fs::write(&p, format!("#!/bin/sh\ntouch '{}'\ncat\n", d.join("marker").display())).unwrap();
        std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        p
    }

    type Row<'a> = (&'a str, &'a str, Option<u64>, Option<u64>, Option<&'a str>);

    fn rows(l: &ChangeList) -> Vec<Row<'_>> {
        l.entries.iter().map(|e| (e.path.as_str(), e.status.as_str(), e.added, e.removed, e.from.as_deref())).collect()
    }

    fn top(d: &Path) -> PathBuf {
        std::fs::canonicalize(d).unwrap()
    }

    /// The working tree of the first test, with six changes of every kind.
    fn six_changes(name: &str) -> PathBuf {
        let d = repo(name);
        std::fs::write(d.join("a.txt"), "1\n2\n3\n").unwrap();
        std::fs::write(d.join("b.txt"), "b\n").unwrap();
        std::fs::write(d.join("c.txt"), "c\n").unwrap();
        commit(&d);
        std::fs::write(d.join("a.txt"), "1\nx\n3\ny\n").unwrap();
        std::fs::remove_file(d.join("b.txt")).unwrap();
        sh(&d, &["mv", "c.txt", "e.txt"]);
        std::fs::write(d.join("new.txt"), "n\nm\n").unwrap();
        std::fs::write(d.join("bin.dat"), b"a\0b\n").unwrap();
        std::fs::write(d.join("s.txt"), "s\n").unwrap();
        sh(&d, &["add", "s.txt"]);
        d
    }

    #[test]
    fn every_kind_of_change_is_listed_with_its_counts() {
        let d = six_changes("changes-kinds");
        let l = list(&d, CHANGES_CAP).unwrap();
        // Tracked paths first, then untracked, as git lists them.
        assert_eq!(
            rows(&l),
            [
                ("a.txt", "M", Some(2), Some(1), None),
                ("b.txt", "D", Some(0), Some(1), None),
                ("e.txt", "R", Some(0), Some(0), Some("c.txt")),
                ("s.txt", "A", Some(1), Some(0), None),
                ("bin.dat", "U", None, None, None),
                ("new.txt", "U", Some(2), Some(0), None),
            ]
        );
        assert_eq!(l.total, 6);
        assert_eq!(l.root, top(&d).to_string_lossy());
        assert_eq!(l.entries[0].abs, top(&d).join("a.txt").to_string_lossy());
    }

    #[test]
    fn the_cap_keeps_the_first_and_counts_all() {
        let d = six_changes("changes-cap");
        let l = list(&d, 2).unwrap();
        assert_eq!(l.entries.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), ["a.txt", "b.txt"]);
        assert_eq!(l.total, 6);
    }

    #[test]
    fn a_plain_folder_is_not_a_repository() {
        let d = dir("changes-plain");
        assert_eq!(list(&d, CHANGES_CAP).unwrap_err(), "not a git repository");
    }

    #[test]
    fn the_repo_config_neither_hides_files_nor_runs_a_command() {
        let d = repo("changes-config");
        std::fs::write(d.join("a.txt"), "a\n").unwrap();
        commit(&d);
        let marker = marker_script(&d);
        std::fs::write(d.join(".gitignore"), "marker*\n").unwrap();
        std::fs::write(d.join("a.txt"), "b\n").unwrap();
        std::fs::write(d.join("new.txt"), "n\n").unwrap();
        sh(&d, &["config", "status.showUntrackedFiles", "no"]);
        sh(&d, &["config", "core.fsmonitor", marker.to_str().unwrap()]);
        sh(&d, &["config", "diff.external", marker.to_str().unwrap()]);
        let l = list(&d, CHANGES_CAP).unwrap();
        assert!(!d.join("marker").exists());
        assert_eq!(rows(&l), [("a.txt", "M", Some(1), Some(1), None), (".gitignore", "U", Some(1), Some(0), None), ("new.txt", "U", Some(1), Some(0), None)]);
    }

    #[test]
    fn a_filter_driver_the_repo_sets_is_not_run() {
        let d = repo("changes-filter");
        std::fs::write(d.join("a.txt"), "1\n2\n3\n").unwrap();
        std::fs::write(d.join(".gitignore"), "marker*\n").unwrap();
        commit(&d);
        let marker = marker_script(&d);
        std::fs::write(d.join(".gitattributes"), "*.txt filter=mark\n").unwrap();
        sh(&d, &["config", "filter.mark.clean", marker.to_str().unwrap()]);
        sh(&d, &["config", "filter.mark.process", marker.to_str().unwrap()]);
        sh(&d, &["config", "filter.mark.required", "true"]);
        // Same size, so git hashes the file, and would filter it, to tell.
        std::fs::write(d.join("a.txt"), "1\nX\n3\n").unwrap();
        let l = list(&d, CHANGES_CAP).unwrap();
        assert!(!d.join("marker").exists());
        assert_eq!(rows(&l)[0], ("a.txt", "M", Some(1), Some(1), None));
        let args = filter_overrides(&top(&d)).unwrap();
        let mark: Vec<&str> = args.iter().map(String::as_str).filter(|a| a.starts_with("filter.mark.")).collect();
        assert_eq!(mark, ["filter.mark.clean=", "filter.mark.smudge=", "filter.mark.process=", "filter.mark.required=false"]);
        let at = args.iter().position(|a| a == "filter.mark.clean=").unwrap();
        assert_eq!(args[at - 1], "-c");
    }

    fn driver_names(args: &[String]) -> Vec<&str> {
        let mut names: Vec<&str> = args.iter().filter_map(|a| a.strip_prefix("filter.")?.strip_suffix(".clean=")).collect();
        names.sort();
        names
    }

    #[test]
    fn only_the_filter_drivers_a_repository_sets_are_turned_off() {
        let d = repo("changes-filter-scope");
        let included = d.join("included.cfg");
        std::fs::write(&included, "[filter \"inc\"]\n\tclean = x\n").unwrap();
        sh(&d, &["config", "include.path", included.to_str().unwrap()]);
        sh(&d, &["config", "filter.loc.smudge", "y"]);
        // A user's own driver, as `git lfs install` sets globally, and one
        // name set both globally and by the repo.
        let global = d.join("global.cfg");
        std::fs::write(&global, "[filter \"user\"]\n\tclean = z\n\trequired\n[filter \"loc\"]\n\tclean = z\n").unwrap();
        let mut cmd = git(&top(&d)).unwrap();
        cmd.env("GIT_CONFIG_GLOBAL", &global).env("GIT_CONFIG_NOSYSTEM", "1");
        assert_eq!(driver_names(&overrides_from(cmd).unwrap()), ["inc", "loc"]);
    }

    #[test]
    fn a_filter_name_that_cannot_be_turned_off_fails() {
        let d = repo("changes-filter-eq");
        sh(&d, &["config", "filter.a=b.clean", "true"]);
        assert!(list(&d, CHANGES_CAP).unwrap_err().contains("cannot be turned off"));
    }

    #[test]
    fn with_no_commit_everything_is_new_and_counted() {
        let d = repo("changes-unborn");
        std::fs::write(d.join("a.txt"), "1\n2\n").unwrap();
        std::fs::write(d.join("b.txt"), "1\n2\n3").unwrap();
        std::fs::write(d.join("gone.txt"), "g\n").unwrap();
        sh(&d, &["add", "a.txt", "gone.txt"]);
        std::fs::remove_file(d.join("gone.txt")).unwrap();
        let l = list(&d, CHANGES_CAP).unwrap();
        // Added and then deleted from disk stays a deletion.
        assert_eq!(rows(&l), [("a.txt", "U", Some(2), Some(0), None), ("gone.txt", "D", Some(0), Some(0), None), ("b.txt", "U", Some(3), Some(0), None)]);
    }

    #[test]
    fn a_subfolder_lists_the_whole_repo_from_its_toplevel() {
        let d = six_changes("changes-sub");
        std::fs::create_dir(d.join("src")).unwrap();
        let l = list(&d.join("src"), CHANGES_CAP).unwrap();
        assert_eq!(l.root, top(&d).to_string_lossy());
        assert_eq!(l.entries[0].path, "a.txt");
        assert_eq!(l.total, 6);
    }

    #[test]
    fn listing_neither_rewrites_the_index_nor_runs_its_hook() {
        let d = repo("changes-index");
        std::fs::write(d.join("a.txt"), "a\n").unwrap();
        std::fs::write(d.join(".gitignore"), "marker*\nhooks/\n").unwrap();
        commit(&d);
        let hooks = d.join("hooks");
        std::fs::create_dir(&hooks).unwrap();
        std::os::unix::fs::symlink(marker_script(&d), hooks.join("post-index-change")).unwrap();
        sh(&d, &["config", "core.hooksPath", hooks.to_str().unwrap()]);
        // Stat-dirty with the same bytes, which a refreshing git would write
        // to the index, running the hook.
        let past = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        std::fs::File::options().write(true).open(d.join("a.txt")).unwrap().set_modified(past).unwrap();
        let stamp = || {
            let m = std::fs::metadata(d.join(".git/index")).unwrap();
            (m.modified().unwrap(), m.len())
        };
        let before = stamp();
        let l = list(&d, CHANGES_CAP).unwrap();
        assert!(l.entries.is_empty());
        assert_eq!(stamp(), before);
        assert!(!d.join("marker").exists());
    }

    #[test]
    fn a_path_removed_from_the_index_but_kept_is_one_row() {
        let d = repo("changes-cached");
        std::fs::write(d.join("keep.txt"), "k\n").unwrap();
        commit(&d);
        sh(&d, &["rm", "-q", "--cached", "keep.txt"]);
        assert_eq!(rows(&list(&d, CHANGES_CAP).unwrap()), [("keep.txt", "D", Some(0), Some(1), None)]);
    }

    #[test]
    fn a_tracked_row_git_diff_does_not_list_still_has_counts() {
        let d = repo("changes-unpaired");
        for name in ["a.txt", "c.txt", "m.txt"] {
            std::fs::write(d.join(name), "1\n").unwrap();
        }
        commit(&d);
        // Staged, then reverted on disk: the file is as HEAD has it.
        std::fs::write(d.join("m.txt"), "2\n").unwrap();
        sh(&d, &["add", "m.txt"]);
        std::fs::write(d.join("m.txt"), "1\n").unwrap();
        // A staged rename whose new path is then deleted.
        sh(&d, &["mv", "a.txt", "b.txt"]);
        std::fs::remove_file(d.join("b.txt")).unwrap();
        // A staged copy, then deleted.
        std::fs::copy(d.join("c.txt"), d.join("copy.txt")).unwrap();
        sh(&d, &["add", "copy.txt"]);
        std::fs::remove_file(d.join("copy.txt")).unwrap();
        let l = list(&d, CHANGES_CAP).unwrap();
        assert_eq!(
            rows(&l),
            [("b.txt", "D", Some(0), Some(1), Some("a.txt")), ("copy.txt", "D", Some(0), Some(0), None), ("m.txt", "M", Some(0), Some(0), None)]
        );
    }

    #[test]
    fn a_newline_in_a_name_is_part_of_it() {
        let d = repo("changes-newline");
        std::fs::write(d.join("x\ny.txt"), "a\n").unwrap();
        commit(&d);
        std::fs::write(d.join("x\ny.txt"), "b\n").unwrap();
        std::fs::write(d.join("new\nline.txt"), "n\n").unwrap();
        let l = list(&d, CHANGES_CAP).unwrap();
        assert_eq!(rows(&l), [("x\ny.txt", "M", Some(1), Some(1), None), ("new\nline.txt", "U", Some(1), Some(0), None)]);
    }

    #[test]
    fn a_git_that_fails_is_an_error_not_an_empty_list() {
        let d = repo("changes-broken");
        std::fs::write(d.join("a.txt"), "a\n").unwrap();
        // A HEAD naming an object that is not there; garbage would make the
        // folder no repository at all.
        std::fs::write(d.join(".git/HEAD"), "0123456789012345678901234567890123456789\n").unwrap();
        let e = list(&d, CHANGES_CAP).unwrap_err();
        assert!(e.starts_with("git status failed: ") && e.contains("bad object HEAD"), "{e}");
    }

    #[test]
    fn a_git_too_old_for_no_lazy_fetch_is_named() {
        let out = |code: i32, stderr: &str| Output { status: std::process::ExitStatus::from_raw(code << 8), stdout: Vec::new(), stderr: stderr.as_bytes().to_vec() };
        assert_eq!(failed("git status", &out(129, "unknown option: --no-lazy-fetch\nusage: git [-v | --version]\n")), "Changes needs git 2.46 or later");
        assert_eq!(failed("git status", &out(128, "fatal: bad object HEAD\n")), "git status failed: fatal: bad object HEAD");
    }

    #[test]
    fn a_submodule_is_listed_for_its_commit_and_never_entered() {
        let src = repo("changes-submodule-src");
        std::fs::write(src.join("s.txt"), "s\n").unwrap();
        commit(&src);
        let d = repo("changes-submodule");
        sh(&d, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", src.to_str().unwrap(), "sub"]);
        commit(&d);
        let sub = d.join("sub");
        let marker = marker_script(&d);
        std::fs::write(d.join(".git/info/exclude"), "marker*\n").unwrap();
        sh(&sub, &["config", "core.fsmonitor", marker.to_str().unwrap()]);
        std::fs::write(sub.join("s.txt"), "edited\n").unwrap();
        let l = list(&d, CHANGES_CAP).unwrap();
        assert!(!d.join("marker").exists());
        assert!(rows(&l).is_empty(), "{:?}", rows(&l));
        sh(&sub, &["-c", "core.fsmonitor=false", "commit", "-q", "-a", "-m", "s"]);
        let l = list(&d, CHANGES_CAP).unwrap();
        assert!(!d.join("marker").exists());
        assert_eq!(rows(&l), [("sub", "M", Some(1), Some(1), None)]);
    }
}
