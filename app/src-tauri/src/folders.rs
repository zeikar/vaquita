//! The entries of one folder for the file tree, folders first, then by name
//! ignoring case. Only `.git` is hidden, a folder or the file a worktree has,
//! as nothing in it is the user's to browse; dotfiles and ignored files show.
//! A symlink is a row, never a branch, whatever it points at: a click sends it
//! through open_path.rs as any file, while expanding it would put one tree's
//! lexical paths over another's real ones and could loop into an ancestor. At
//! most FOLDER_CAP entries come back, with the folder's total, and the cap is
//! applied here so a folder of 100 000 files is one small answer over IPC; the
//! entries kept are the first of the sorted order, so which show is the same
//! on every read.

use std::path::Path;

use serde::Serialize;

use crate::open_path;

pub const FOLDER_CAP: usize = 2000;

#[derive(Debug, Serialize)]
pub struct Entry {
    name: String,
    dir: bool,
}

#[derive(Debug, Serialize)]
pub struct Listing {
    entries: Vec<Entry>,
    total: usize,
    /// The folder with its links resolved: the tree shows lexical paths, but
    /// a tab holds the canonical one of the file it opened.
    canonical: String,
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
        entries.push(Entry { name: entry.file_name().to_string_lossy().into_owned(), dir });
    }
    entries.sort_by_cached_key(|e| (!e.dir, e.name.to_lowercase()));
    let total = entries.len();
    entries.truncate(cap);
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
    fn the_cap_keeps_the_first_and_counts_all() {
        let d = dir("folders-cap");
        for name in ["e", "d", "c", "b", "a"] {
            file(&d, name, 0o644);
        }
        let l = list(&d, 3).unwrap();
        assert_eq!(rows(&l), [("a", false), ("b", false), ("c", false)]);
        assert_eq!(l.total, 5);
    }

    #[test]
    fn a_file_or_a_missing_path_is_not_listed() {
        let d = dir("folders-bad");
        let f = file(&d, "a.txt", 0o644);
        assert_eq!(list(&f, FOLDER_CAP).unwrap_err(), "not a folder");
        assert_eq!(list(&d.join("missing"), FOLDER_CAP).unwrap_err(), "no such file");
    }
}
