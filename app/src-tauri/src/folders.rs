//! The entries of one folder for the file tree, folders first, then by name
//! ignoring case, digit runs by value (f2 before f10). Only `.git` is hidden, a folder or the file a worktree has,
//! as nothing in it is the user's to browse; dotfiles and ignored files show.
//! A symlink is a row, never a branch, whatever it points at: a click sends it
//! through open_path.rs as any file, while expanding it would put one tree's
//! lexical paths over another's real ones and could loop into an ancestor. At
//! most FOLDER_CAP entries come back, with the folder's total, and the cap is
//! applied here so a folder of 100 000 files is one small answer over IPC; the
//! entries kept are the first of the sorted order, so which show is the same
//! on every read.
//!
//! Each entry kept says whether git ignores it, asked of `git check-ignore`
//! once per read: git alone knows the nested .gitignore files, .git/info/exclude
//! and the global excludes file, which a parser here would have to copy. It
//! runs only on the reads the tree makes anyway, never on a timer, and a folder
//! outside a repo, or a Mac without git, lists with nothing ignored.
//!
//! Every git the app runs starts from git_in, with optional locks off: a
//! status or diff would otherwise rewrite a stat-dirty .git/index, which a
//! watch would see as a change and answer with another status, forever.

use std::collections::HashSet;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use serde::Serialize;

use crate::open_path;

pub const FOLDER_CAP: usize = 2000;

#[derive(Debug, Serialize)]
pub struct Entry {
    name: String,
    dir: bool,
    ignored: bool,
}

#[derive(Debug, Serialize)]
pub struct Listing {
    entries: Vec<Entry>,
    total: usize,
    /// The folder with its links resolved: the tree shows lexical paths, but
    /// a tab holds the canonical one of the file it opened.
    canonical: String,
}

/// Case-insensitive order with digit runs compared by value, as the tree's
/// collator orders rows, so the cap cuts the tail of what the tree shows.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let run = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut d = String::new();
                    while let Some(c) = it.next_if(|c| c.is_ascii_digit()) {
                        d.push(c);
                    }
                    d.trim_start_matches('0').to_string()
                };
                let (x, y) = (run(&mut a), run(&mut b));
                let o = x.len().cmp(&y.len()).then_with(|| x.cmp(&y));
                if o.is_ne() {
                    return o;
                }
            }
            (Some(x), Some(y)) => {
                let o = x.to_lowercase().cmp(y.to_lowercase());
                if o.is_ne() {
                    return o;
                }
                a.next();
                b.next();
            }
        }
    }
}

/// The git to run, found once per run: without the command line tools,
/// /usr/bin/git is a stub that asks to install them each time it runs.
fn git() -> Option<&'static str> {
    static GIT: OnceLock<Option<&'static str>> = OnceLock::new();
    *GIT.get_or_init(|| {
        let version = |git: &str| Command::new(git).arg("--version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
        // An app opened from Finder has only the system PATH, whose git is
        // /usr/bin/git, so that is where a PATH without one looks.
        let (git, status) = match version("git") {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => ("/usr/bin/git", version("/usr/bin/git")),
            r => ("git", r),
        };
        status.is_ok_and(|s| s.success()).then_some(git)
    })
}

/// A git command in `folder`, or None when git cannot run.
pub(crate) fn git_in(folder: &Path) -> Option<Command> {
    let mut cmd = Command::new(git()?);
    cmd.arg("--no-optional-locks")
        .arg("-C")
        .arg(folder)
        // Nothing the app runs may run a command the repo configures, so the
        // fsmonitor hook is off.
        .args(["-c", "core.fsmonitor=false"])
        // Set in the app's environment, as by a git hook that started a
        // dev build, these would make git judge another repo's files, or run
        // a program on a diff.
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_EXTERNAL_DIFF")
        // Callers match git's English messages.
        .env("LC_ALL", "C")
        .stderr(Stdio::piped());
    Some(cmd)
}

/// The names in `names`, entries of `folder`, that git ignores; none when
/// `folder` is not in a repo or git cannot run, as the tree must list a folder
/// whatever git says. A tracked file is not ignored, whatever the patterns.
pub(crate) fn ignored_names(folder: &Path, names: &[&str]) -> HashSet<String> {
    if names.is_empty() {
        return HashSet::new();
    }
    let Some(mut cmd) = git_in(folder) else { return HashSet::new() };
    let child = cmd.args(["check-ignore", "-z", "--stdin"]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn();
    let Ok(mut child) = child else { return HashSet::new() };
    let mut input = Vec::new();
    for n in names {
        // "./" keeps a name like ":(literal)x" from reading as pathspec magic.
        input.extend_from_slice(b"./");
        input.extend_from_slice(n.as_bytes());
        input.push(0);
    }
    // git answers each name as it reads it, so writing all of them before
    // reading could fill both pipes and stall the two ends on each other. A
    // write fails only when git has quit, and then its status says why.
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let out = child.wait_with_output();
    let _ = writer.join();
    // Exit 1 is no name ignored, 128 not a repo or any other failure.
    match out {
        Ok(out) if out.status.success() => {
            out.stdout.split(|&b| b == 0).filter(|n| !n.is_empty()).map(|n| String::from_utf8_lossy(n.strip_prefix(b"./").unwrap_or(n)).into_owned()).collect()
        }
        _ => HashSet::new(),
    }
}

fn list(path: &Path, cap: usize) -> Result<Listing, String> {
    if !std::fs::metadata(path).map_err(open_path::io_error)?.is_dir() {
        return Err("not a folder".to_string());
    }
    let canonical = std::fs::canonicalize(path).map_err(open_path::io_error)?.to_string_lossy().into_owned();
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(path).map_err(open_path::io_error)? {
        let entry = entry.map_err(open_path::io_error)?;
        if entry.file_name() == ".git" {
            continue;
        }
        // file_type does not follow a symlink, so a link is never a branch.
        let dir = entry.file_type().map_err(open_path::io_error)?.is_dir();
        entries.push(Entry { name: entry.file_name().to_string_lossy().into_owned(), dir, ignored: false });
    }
    entries.sort_by(|x, y| y.dir.cmp(&x.dir).then_with(|| natural_cmp(&x.name, &y.name)).then_with(|| x.name.cmp(&y.name)));
    let total = entries.len();
    entries.truncate(cap);
    let ignored = ignored_names(path, &entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>());
    for e in &mut entries {
        e.ignored = ignored.contains(&e.name);
    }
    Ok(Listing { entries, total, canonical })
}

#[tauri::command]
pub async fn read_folder(path: String) -> Result<Listing, String> {
    tauri::async_runtime::spawn_blocking(move || list(Path::new(&path), FOLDER_CAP)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open_path::tests::{dir, file};

    fn rows(l: &Listing) -> Vec<(&str, bool)> {
        l.entries.iter().map(|e| (e.name.as_str(), e.dir)).collect()
    }

    #[test]
    fn folders_come_first_then_names_ignoring_case() {
        let d = dir("folders-order");
        for name in ["c.txt", "B.txt", "a.txt"] {
            file(&d, name, 0o644);
        }
        std::fs::create_dir(d.join("zeta")).unwrap();
        std::fs::create_dir(d.join("Alpha")).unwrap();
        let l = list(&d, FOLDER_CAP).unwrap();
        assert_eq!(rows(&l), [("Alpha", true), ("zeta", true), ("a.txt", false), ("B.txt", false), ("c.txt", false)]);
        assert_eq!(l.total, 5);
    }

    #[test]
    fn the_listing_names_the_canonical_folder() {
        let d = dir("folders-canonical");
        std::fs::create_dir(d.join("real")).unwrap();
        std::os::unix::fs::symlink(d.join("real"), d.join("link")).unwrap();
        let l = list(&d.join("link"), FOLDER_CAP).unwrap();
        assert_eq!(l.canonical, std::fs::canonicalize(d.join("real")).unwrap().to_string_lossy());
    }

    #[test]
    fn git_is_hidden_and_other_dotfiles_show() {
        let d = dir("folders-git");
        std::fs::create_dir(d.join(".git")).unwrap();
        file(&d, ".env", 0o644);
        assert_eq!(rows(&list(&d, FOLDER_CAP).unwrap()), [(".env", false)]);
        // A worktree's .git is a file.
        let w = dir("folders-git-file");
        file(&w, ".git", 0o644);
        let l = list(&w, FOLDER_CAP).unwrap();
        assert!(l.entries.is_empty());
        assert_eq!(l.total, 0);
    }

    #[test]
    fn a_symlink_is_a_row_not_a_folder() {
        let d = dir("folders-link");
        std::fs::create_dir(d.join("real")).unwrap();
        std::os::unix::fs::symlink(d.join("real"), d.join("to-folder")).unwrap();
        std::os::unix::fs::symlink(d.join("missing"), d.join("broken")).unwrap();
        assert_eq!(rows(&list(&d, FOLDER_CAP).unwrap()), [("real", true), ("broken", false), ("to-folder", false)]);
    }

    #[test]
    fn digit_runs_are_ordered_by_value_and_the_cap_cuts_the_tail() {
        let d = dir("folders-natural");
        for n in 1..=12 {
            file(&d, &format!("f{n}"), 0o644);
        }
        let l = list(&d, 10).unwrap();
        let names: Vec<_> = l.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10"]);
        assert_eq!(l.total, 12);
    }

    #[test]
    fn the_cap_keeps_the_first_and_counts_all() {
        let d = dir("folders-cap");
        for name in ["e", "d", "c", "b", "a"] {
            file(&d, name, 0o644);
        }
        let l = list(&d, 3).unwrap();
        assert_eq!(rows(&l), [("a", false), ("b", false), ("c", false)]);
        assert_eq!(l.total, 5);
    }

    fn ignored(l: &Listing) -> Vec<&str> {
        l.entries.iter().filter(|e| e.ignored).map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn what_git_ignores_is_marked() {
        let d = dir("folders-ignored");
        let init = Command::new("git").arg("-C").arg(&d).args(["init", "-q"]).env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").status();
        assert!(init.unwrap().success());
        std::fs::write(d.join(".gitignore"), "dist/\n*.log\n").unwrap();
        std::fs::create_dir(d.join("dist")).unwrap();
        std::fs::create_dir(d.join("src")).unwrap();
        file(&d.join("dist"), "app.js", 0o644);
        // -z, so a newline in a name is part of it.
        for name in ["a.log", "new\nline.log", "b.txt"] {
            file(&d, name, 0o644);
        }
        assert_eq!(ignored(&list(&d, FOLDER_CAP).unwrap()), ["dist", "a.log", "new\nline.log"]);
        // Inside an ignored folder, its entries are ignored too.
        assert_eq!(ignored(&list(&d.join("dist"), FOLDER_CAP).unwrap()), ["app.js"]);
    }

    #[test]
    fn a_repo_hook_is_not_run_and_magic_looking_names_are_literal() {
        let d = dir("folders-hook");
        let git = |args: &[&str]| {
            let s = Command::new("git").arg("-C").arg(&d).args(args).env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").status();
            assert!(s.unwrap().success());
        };
        git(&["init", "-q"]);
        std::fs::write(d.join(".gitignore"), "*.log\n").unwrap();
        file(&d, "tracked.txt", 0o644);
        git(&["add", "tracked.txt"]);
        let marker = d.join("hook-ran");
        let hook = d.join("hook.sh");
        std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        std::fs::set_permissions(&hook, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        git(&["config", "core.fsmonitor", hook.to_str().unwrap()]);
        file(&d, ":(literal)foo", 0o644);
        file(&d, "a.log", 0o644);
        let l = list(&d, FOLDER_CAP).unwrap();
        assert!(!marker.exists());
        assert_eq!(ignored(&l), ["a.log"]);
    }

    #[test]
    fn outside_a_repo_nothing_is_ignored() {
        let d = dir("folders-no-repo");
        std::fs::write(d.join(".gitignore"), "*.log\n").unwrap();
        file(&d, "a.log", 0o644);
        let l = list(&d, FOLDER_CAP).unwrap();
        assert_eq!(rows(&l), [(".gitignore", false), ("a.log", false)]);
        assert!(ignored(&l).is_empty());
    }

    #[test]
    fn a_file_or_a_missing_path_is_not_listed() {
        let d = dir("folders-bad");
        let f = file(&d, "a.txt", 0o644);
        assert_eq!(list(&f, FOLDER_CAP).unwrap_err(), "not a folder");
        assert_eq!(list(&d.join("missing"), FOLDER_CAP).unwrap_err(), "no such file");
    }
}
