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
//!
//! A diff's two sides are HEAD's raw blob, which `cat-file blob` gives with no
//! textconv and no filter, and the file on disk. The path comes from the
//! webview: its part under the toplevel is git's name for the file, and the
//! disk is read only when the file's parent is canonically that folder, so a
//! symlinked folder never leads to another file, in the repo or outside it,
//! and a symlink as the file itself is not followed.

use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::Read;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output};

use serde::Serialize;

use crate::{files, folders, open_path};

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

pub(crate) fn git(folder: &Path) -> Result<Command, String> {
    let mut cmd = folders::git_in(folder).ok_or("git is not installed")?;
    cmd.arg("--no-lazy-fetch");
    Ok(cmd)
}

pub(crate) fn run(mut cmd: Command) -> Result<Output, String> {
    cmd.output().map_err(|e| format!("run git: {e}"))
}

/// The error for an exit status the caller does not name.
pub(crate) fn failed(what: &str, out: &Output) -> String {
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
        // A lossy decode would name a different driver and leave this one running.
        let key = std::str::from_utf8(record.split(|&b| b == b'\n').next().unwrap_or_default()).map_err(|_| "a filter driver with a name that is not UTF-8 cannot be turned off".to_string())?;
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

/// The texts of a diff; None is a side that does not exist.
#[derive(Debug, Serialize)]
pub struct Sides {
    head: Option<String>,
    work: Option<String>,
}

const OUTSIDE: &str = "outside the repo";
const BINARY: &str = "binary";
const SYMLINK: &str = "a symlink";
const SUBMODULE: &str = "a submodule";

/// The path relative to top, which is git's name for it, and where the file
/// is on disk; no location when nothing on disk is that file.
fn located(top: &Path, path: &Path) -> Result<(String, Option<PathBuf>), String> {
    let outside = || OUTSIDE.to_string();
    if !path.is_absolute() {
        return Err(outside());
    }
    let Ok(lexical) = path.strip_prefix(top) else {
        // Reached another way, through a symlinked path to the repo say: the
        // canonical parent names it.
        let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else { return Err(outside()) };
        let real = std::fs::canonicalize(parent).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { outside() } else { open_path::io_error(e) })?;
        let rel = real.strip_prefix(top).map_err(|_| outside())?.join(name);
        let rel = rel.to_str().ok_or("not a UTF-8 path")?.to_string();
        return Ok((rel, Some(real.join(name))));
    };
    let mut parts = Vec::new();
    for c in lexical.components() {
        match c {
            Component::Normal(p) => parts.push(p.to_str().ok_or("not a UTF-8 path")?),
            _ => return Err(outside()),
        }
    }
    if parts.is_empty() {
        return Err(outside());
    }
    let rel = parts.join("/");
    let at = top.join(&rel);
    let (Some(parent), Some(name)) = (at.parent(), at.file_name()) else { return Err(outside()) };
    // The disk side is read only when the parent is canonically itself: a
    // symlinked folder on the way, repo/link/f with link pointing anywhere,
    // names another file than the one git lists, inside the repo or not.
    match std::fs::canonicalize(parent) {
        Ok(real) if real == parent => Ok((rel, Some(real.join(name)))),
        Ok(_) => Ok((rel, None)),
        Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => Ok((rel, None)),
        Err(e) => Err(open_path::io_error(e)),
    }
}

/// HEAD's entry at rel: its mode, type, object id and size (`-` but for a
/// blob); None when HEAD has nothing there.
fn head_entry(top: &Path, rel: &str) -> Result<Option<[String; 4]>, String> {
    let mut cmd = git(top)?;
    cmd.args(["--literal-pathspecs", "ls-tree", "-l", "-z", "--full-tree", "HEAD", "--", rel]);
    let out = run(cmd)?;
    // A tree object missing on the way is a failure here, where `rev-parse
    // HEAD:<path>` would have answered no such path.
    if !out.status.success() {
        return Err(failed("git ls-tree", &out));
    }
    let bad = || "git ls-tree: unexpected output".to_string();
    for record in out.stdout.split(|&b| b == 0).filter(|r| !r.is_empty()) {
        let at = record.iter().position(|&b| b == b'\t').ok_or_else(bad)?;
        if &record[at + 1..] != rel.as_bytes() {
            continue;
        }
        let meta = std::str::from_utf8(&record[..at]).map_err(|_| bad())?;
        let fields: Vec<&str> = meta.split_whitespace().collect();
        let [mode, kind, id, size] = fields[..] else { return Err(bad()) };
        return Ok(Some([mode, kind, id, size].map(str::to_string)));
    }
    Ok(None)
}

/// HEAD's text of rel, or of what a staged rename made rel from.
fn head_side(top: &Path, rel: &str) -> Result<Option<String>, String> {
    if !has_head(top)? {
        return Ok(None);
    }
    let mut entry = head_entry(top, rel)?;
    // Only a path HEAD lacks can be a rename's new name, so status runs only
    // then.
    if entry.is_none() {
        let overrides = filter_overrides(top)?;
        let from = status_entries(top, &overrides)?.into_iter().find(|(path, _, _)| path == rel).and_then(|(_, from, _)| from);
        if let Some(from) = from {
            entry = head_entry(top, &from)?;
        }
    }
    let Some([mode, kind, id, size]) = entry else { return Ok(None) };
    match (mode.as_str(), kind.as_str()) {
        (_, "commit") => return Err(SUBMODULE.to_string()),
        // A folder in HEAD is no file to diff.
        (_, "tree") => return Ok(None),
        ("120000", _) => return Err(SYMLINK.to_string()),
        (_, "blob") => {}
        _ => return Err("git ls-tree: unexpected output".to_string()),
    }
    let size: u64 = size.parse().map_err(|_| "git ls-tree: unexpected output")?;
    if size > files::TEXT_MAX {
        return Err(files::TOO_LARGE.to_string());
    }
    // The object that was sized, so a checkout in between cannot pass a
    // larger one; a raw blob, with no textconv and no filter.
    let mut cmd = git(top)?;
    cmd.args(["cat-file", "blob", &id]);
    let out = run(cmd)?;
    if !out.status.success() {
        return Err(failed("git cat-file", &out));
    }
    if out.stdout.contains(&0) {
        return Err(BINARY.to_string());
    }
    String::from_utf8(out.stdout).map(Some).map_err(|_| files::NOT_UTF8.to_string())
}

fn work_side(at: Option<&Path>) -> Result<Option<String>, String> {
    let Some(at) = at else { return Ok(None) };
    match std::fs::symlink_metadata(at) {
        Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => return Ok(None),
        Err(e) => return Err(open_path::io_error(e)),
        Ok(meta) if meta.is_symlink() => return Err(SYMLINK.to_string()),
        // A file replaced by a folder is a deletion of the file.
        Ok(meta) if meta.is_dir() => return Ok(None),
        Ok(_) => {}
    }
    let text = files::read(at)?.text;
    if text.contains('\0') {
        return Err(BINARY.to_string());
    }
    Ok(Some(text))
}

pub fn sides(folder: &Path, path: &Path) -> Result<Sides, String> {
    let top = toplevel(folder)?;
    let (rel, at) = located(&top, path)?;
    Ok(Sides { head: head_side(&top, &rel)?, work: work_side(at.as_deref())? })
}

#[tauri::command]
pub async fn diff_sides(root: String, path: String) -> Result<Sides, String> {
    tauri::async_runtime::spawn_blocking(move || sides(Path::new(&root), Path::new(&path))).await.map_err(|e| e.to_string())?
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
    fn a_filter_name_that_is_not_utf8_fails() {
        use std::io::Write;
        let d = repo("changes-filter-bytes");
        let marker = marker_script(&d);
        std::fs::write(d.join(".gitattributes"), b"*.txt filter=a\xffb\n").unwrap();
        let mut cfg = std::fs::OpenOptions::new().append(true).open(d.join(".git/config")).unwrap();
        cfg.write_all(b"[filter \"a\xffb\"]\n\tclean = ").unwrap();
        cfg.write_all(marker.to_str().unwrap().as_bytes()).unwrap();
        cfg.write_all(b"\n").unwrap();
        assert!(list(&d, CHANGES_CAP).unwrap_err().contains("not UTF-8"));
        assert!(!d.join("marker").exists());
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

    fn texts(s: Sides) -> (Option<String>, Option<String>) {
        (s.head, s.work)
    }

    fn some(t: &str) -> Option<String> {
        Some(t.to_string())
    }

    #[test]
    fn a_diff_has_head_and_disk_for_every_kind_of_change() {
        let d = repo("sides-kinds");
        std::fs::write(d.join("a.txt"), "1\n2\n").unwrap();
        std::fs::write(d.join("b.txt"), "b\n").unwrap();
        std::fs::write(d.join("c.txt"), "c\n").unwrap();
        std::fs::create_dir(d.join("gone")).unwrap();
        std::fs::write(d.join("gone/g.txt"), "g\n").unwrap();
        std::fs::write(d.join("x.txt"), "x\n").unwrap();
        commit(&d);
        std::fs::write(d.join("a.txt"), "1\nx\n").unwrap();
        std::fs::remove_file(d.join("b.txt")).unwrap();
        sh(&d, &["mv", "c.txt", "e.txt"]);
        std::fs::write(d.join("e.txt"), "c\nmore\n").unwrap();
        std::fs::write(d.join("new.txt"), "n\n").unwrap();
        std::fs::remove_dir_all(d.join("gone")).unwrap();
        std::fs::remove_file(d.join("x.txt")).unwrap();
        std::fs::create_dir(d.join("x.txt")).unwrap();
        let t = top(&d);
        assert_eq!(texts(sides(&d, &t.join("a.txt")).unwrap()), (some("1\n2\n"), some("1\nx\n")));
        assert_eq!(texts(sides(&d, &t.join("new.txt")).unwrap()), (None, some("n\n")));
        assert_eq!(texts(sides(&d, &t.join("b.txt")).unwrap()), (some("b\n"), None));
        assert_eq!(texts(sides(&d, &t.join("gone/g.txt")).unwrap()), (some("g\n"), None));
        assert_eq!(texts(sides(&d, &t.join("e.txt")).unwrap()), (some("c\n"), some("c\nmore\n")));
        // A file replaced by a folder is gone as a file.
        assert_eq!(texts(sides(&d, &t.join("x.txt")).unwrap()), (some("x\n"), None));
    }

    #[test]
    fn a_side_that_is_no_text_cannot_be_shown() {
        let d = repo("sides-not-text");
        std::fs::write(d.join("bin.dat"), b"a\0b\n").unwrap();
        std::fs::write(d.join("big.txt"), "x").unwrap();
        std::fs::write(d.join("huge.txt"), "x".repeat(files::TEXT_MAX as usize + 1)).unwrap();
        std::os::unix::fs::symlink("bin.dat", d.join("was-link")).unwrap();
        commit(&d);
        std::fs::write(d.join("bin.dat"), "text now\n").unwrap();
        std::fs::write(d.join("big.txt"), "x".repeat(files::TEXT_MAX as usize + 1)).unwrap();
        std::fs::write(d.join("huge.txt"), "small now\n").unwrap();
        std::os::unix::fs::symlink("big.txt", d.join("link")).unwrap();
        std::fs::remove_file(d.join("was-link")).unwrap();
        std::fs::write(d.join("was-link"), "a file now\n").unwrap();
        let t = top(&d);
        assert_eq!(sides(&d, &t.join("bin.dat")).unwrap_err(), "binary");
        assert_eq!(sides(&d, &t.join("big.txt")).unwrap_err(), "larger than 2 MiB");
        assert_eq!(sides(&d, &t.join("huge.txt")).unwrap_err(), "larger than 2 MiB");
        assert_eq!(sides(&d, &t.join("link")).unwrap_err(), "a symlink");
        // A symlink in HEAD, a file on disk.
        assert_eq!(sides(&d, &t.join("was-link")).unwrap_err(), "a symlink");
    }

    #[test]
    fn a_submodule_is_no_file_to_diff() {
        let src = repo("sides-submodule-src");
        std::fs::write(src.join("s.txt"), "s\n").unwrap();
        commit(&src);
        let d = repo("sides-submodule");
        sh(&d, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", src.to_str().unwrap(), "sub"]);
        commit(&d);
        assert_eq!(sides(&d, &top(&d).join("sub")).unwrap_err(), "a submodule");
    }

    #[test]
    fn a_path_outside_the_toplevel_is_refused() {
        let d = repo("sides-outside");
        std::fs::write(d.join("a.txt"), "a\n").unwrap();
        commit(&d);
        let out = dir("sides-outside-elsewhere");
        std::fs::write(out.join("f"), "secret\n").unwrap();
        std::os::unix::fs::symlink(&out, d.join("link")).unwrap();
        let t = top(&d);
        assert_eq!(sides(&d, &out.join("f")).unwrap_err(), "outside the repo");
        assert_eq!(sides(&d, &t.join("..").join(out.file_name().unwrap()).join("f")).unwrap_err(), "outside the repo");
        assert_eq!(sides(&d, &t.join("gone/../../x")).unwrap_err(), "outside the repo");
        assert_eq!(sides(&d, &t.join("a.txt/..")).unwrap_err(), "outside the repo");
        // Under the repo by its name, outside it in fact: git has no such
        // file, and the outside one is never read.
        assert_eq!(located(&t, &t.join("link/f")).unwrap(), ("link/f".to_string(), None));
        assert_eq!(texts(sides(&d, &t.join("link/f")).unwrap()), (None, None));
    }

    #[test]
    fn a_symlinked_folder_on_the_way_reads_no_other_file() {
        let d = repo("sides-inner-link");
        for f in ["d/f.txt", "e/f.txt"] {
            std::fs::create_dir(d.join(&f[..1])).unwrap();
            std::fs::write(d.join(f), format!("{f}\n")).unwrap();
        }
        commit(&d);
        std::os::unix::fs::symlink("e", d.join("alias")).unwrap();
        // A folder swapped for a link: git lists d/f.txt as deleted, and the
        // disk's d/f.txt is e's file.
        std::fs::remove_dir_all(d.join("d")).unwrap();
        std::os::unix::fs::symlink("e", d.join("d")).unwrap();
        let t = top(&d);
        assert_eq!(located(&t, &t.join("alias/f.txt")).unwrap(), ("alias/f.txt".to_string(), None));
        assert_eq!(located(&t, &t.join("d/f.txt")).unwrap(), ("d/f.txt".to_string(), None));
        assert_eq!(texts(sides(&d, &t.join("d/f.txt")).unwrap()), (some("d/f.txt\n"), None));
        assert_eq!(located(&t, &t.join("e/f.txt")).unwrap(), ("e/f.txt".to_string(), Some(t.join("e/f.txt"))));
    }

    #[test]
    fn a_repo_reached_through_a_symlink_resolves_to_its_real_path() {
        let d = repo("sides-via-link");
        std::fs::write(d.join("a.txt"), "a\n").unwrap();
        commit(&d);
        std::fs::write(d.join("a.txt"), "b\n").unwrap();
        let via = dir("sides-via-link-alias").join("repo");
        std::os::unix::fs::symlink(&d, &via).unwrap();
        assert_eq!(texts(sides(&via, &via.join("a.txt")).unwrap()), (some("a\n"), some("b\n")));
    }

    #[test]
    fn head_is_the_raw_blob_with_no_textconv_run() {
        let d = repo("sides-textconv");
        std::fs::write(d.join(".gitattributes"), "*.txt diff=x\n").unwrap();
        std::fs::write(d.join(".gitignore"), "marker*\n").unwrap();
        std::fs::write(d.join("a.txt"), "raw\n").unwrap();
        commit(&d);
        let marker = marker_script(&d);
        sh(&d, &["config", "diff.x.textconv", marker.to_str().unwrap()]);
        std::fs::write(d.join("a.txt"), "raw too\n").unwrap();
        assert_eq!(texts(sides(&d, &top(&d).join("a.txt")).unwrap()), (some("raw\n"), some("raw too\n")));
        assert!(!d.join("marker").exists());
    }

    #[test]
    fn with_no_commit_there_is_no_head_side() {
        let d = repo("sides-unborn");
        std::fs::write(d.join("a.txt"), "a\n").unwrap();
        sh(&d, &["add", "a.txt"]);
        assert_eq!(texts(sides(&d, &top(&d).join("a.txt")).unwrap()), (None, some("a\n")));
    }

    #[test]
    fn a_git_that_fails_is_an_error_not_a_missing_side() {
        let d = repo("sides-broken");
        std::fs::write(d.join("a.txt"), "a\n").unwrap();
        // As in the list's test: a HEAD naming an object that is not there.
        std::fs::write(d.join(".git/HEAD"), "0123456789012345678901234567890123456789\n").unwrap();
        let e = sides(&d, &top(&d).join("a.txt")).unwrap_err();
        assert!(e.starts_with("git ls-tree failed: ") && e.contains("not a tree object"), "{e}");
    }

    #[test]
    fn a_tree_missing_from_head_is_an_error_not_a_new_file() {
        let d = repo("sides-missing-tree");
        std::fs::create_dir(d.join("sub")).unwrap();
        std::fs::write(d.join("sub/f.txt"), "f\n").unwrap();
        commit(&d);
        std::fs::write(d.join("sub/f.txt"), "g\n").unwrap();
        let out = Command::new("git").arg("-C").arg(&d).args(["rev-parse", "HEAD:sub"]).output().unwrap();
        let id = String::from_utf8(out.stdout).unwrap();
        let id = id.trim();
        std::fs::remove_file(d.join(".git/objects").join(&id[..2]).join(&id[2..])).unwrap();
        let e = sides(&d, &top(&d).join("sub/f.txt")).unwrap_err();
        assert!(e.starts_with("git ls-tree failed: "), "{e}");
    }
}
