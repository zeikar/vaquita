//! File events for the file tree's expanded folders, which the webview names
//! and re-reads. Only expanded folders are watched, each NonRecursive, so an
//! agent writing deep under one costs a callback notify filters out and no
//! IPC, and with no folder expanded notify runs no thread at all. FSEvents
//! reports canonical paths (/private/tmp/repo/a.ts for a repo registered as
//! /tmp/repo), while the tree's paths are the lexical ones it shows, so each
//! folder is kept as the pair and an event names the lexical folders it
//! concerns: the folder it is, and the folder it is in. The webview replaces
//! the whole set in one call with a generation, and a call older than the last
//! applied is ignored, so a registration still in flight never outlives the
//! teardown that followed it. The pairs have a lock of their own, apart from
//! the watcher's: notify's watch and unwatch join the thread the handler runs
//! on, so a lock held across them that the handler also took would deadlock.
//! notify panics on an FSEvents flag it does not know or a path that is not
//! UTF-8, and a release build aborts on a panic, so when macOS adds flags the
//! notify in use should be checked for them.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

// The crate, not crate::notify, which posts notifications.
use ::notify::event::ModifyKind;
use ::notify::{ErrorKind, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::open_path;

pub const FOLDER_EVENT: &str = "folder-changed";

#[derive(Debug, Clone, PartialEq)]
struct Root {
    canonical: PathBuf,
    lexical: String,
}

#[derive(Default)]
pub struct Watches {
    roots: Arc<Mutex<Vec<Root>>>,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    generation: u64,
    watcher: Option<RecommendedWatcher>,
}

/// A folder that could not be watched because it could not be resolved.
#[derive(Debug, Serialize)]
pub struct Refused {
    path: String,
    error: String,
}

/// The lexical folders an event at `path` concerns: the watched folder it is
/// (deleted or renamed) and the watched folder it is in (an entry added,
/// removed or renamed).
fn to_reload(path: &Path, roots: &[Root]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for r in roots {
        if (r.canonical == path || Some(r.canonical.as_path()) == path.parent()) && !out.contains(&r.lexical) {
            out.push(r.lexical.clone());
        }
    }
    out
}

/// Whether an event can change what a listing shows. A file's contents or
/// metadata cannot, and an agent rewriting a log in an expanded folder would
/// otherwise have the folder re-read all the time. notify makes one event per
/// FSEvents flag, so a create or rename coalesced with a write still comes as
/// its own event. Any and Other are kept, as Other is how a rescan comes. A
/// write to a .gitignore is kept too, as the listing marks what git ignores.
fn changes_listing(event: &Event) -> bool {
    match event.kind {
        EventKind::Access(_) | EventKind::Modify(ModifyKind::Metadata(_)) => false,
        EventKind::Modify(ModifyKind::Data(_)) => event.paths.iter().any(|p| is_gitignore(p)),
        _ => true,
    }
}

fn is_gitignore(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n == ".gitignore")
}

/// The lexical folders an event concerns. A rescan means events were dropped
/// and names only some folder, so every watched folder is read again, as notify
/// requires of a consumer.
fn affected(event: &Event, roots: &[Root]) -> Vec<String> {
    let mut folders: Vec<String> = Vec::new();
    if event.need_rescan() {
        for r in roots {
            if !folders.contains(&r.lexical) {
                folders.push(r.lexical.clone());
            }
        }
        return folders;
    }
    for path in &event.paths {
        for f in to_reload(path, roots) {
            if !folders.contains(&f) {
                folders.push(f);
            }
        }
        // A .gitignore's patterns reach every folder under it, so each one
        // watched there is read again for what it now ignores.
        if is_gitignore(path) && let Some(parent) = path.parent() {
            for r in roots {
                if r.canonical.starts_with(parent) && !folders.contains(&r.lexical) {
                    folders.push(r.lexical.clone());
                }
            }
        }
    }
    folders
}

fn new_watcher(roots: Arc<Mutex<Vec<Root>>>, emit: impl Fn(Vec<String>) + Send + 'static) -> ::notify::Result<RecommendedWatcher> {
    ::notify::recommended_watcher(move |res: ::notify::Result<Event>| match res {
        Ok(event) if !event.need_rescan() && !changes_listing(&event) => {}
        Ok(event) => {
            let folders = affected(&event, &roots.lock().unwrap());
            if !folders.is_empty() {
                emit(folders);
            }
        }
        Err(e) => eprintln!("vaquita: watching folders: {e}"),
    })
}

/// Whether notify's watch failed because the folder is gone, which it
/// reports before it changes its paths.
fn is_not_found(e: &::notify::Error) -> bool {
    match &e.kind {
        ErrorKind::PathNotFound => true,
        ErrorKind::Io(io) => io.kind() == std::io::ErrorKind::NotFound,
        _ => false,
    }
}

/// Makes `folders` the watched set, unless a newer generation was applied.
fn apply(watches: &Watches, generation: u64, folders: Vec<String>, emit: impl Fn(Vec<String>) + Send + 'static) -> Result<Vec<Refused>, String> {
    let mut inner = watches.inner.lock().unwrap();
    // The webview's calls run on threads of their own and can arrive out of
    // order; an older one would bring back folders a newer one took away.
    if generation < inner.generation {
        return Ok(Vec::new());
    }
    inner.generation = generation;
    let mut refused = Vec::new();
    let mut wanted = Vec::new();
    for lexical in folders {
        match std::fs::canonicalize(&lexical) {
            Ok(canonical) => wanted.push(Root { canonical, lexical }),
            Err(e) => refused.push(Refused { path: lexical, error: open_path::io_error(e) }),
        }
    }
    if inner.watcher.is_none() {
        inner.watcher = Some(new_watcher(watches.roots.clone(), emit).map_err(|e| format!("watching folders: {e}"))?);
    }
    let watcher = inner.watcher.as_mut().unwrap();
    let current = watches.roots.lock().unwrap().clone();
    let mut result = Ok(());
    // notify unwatches by canonical path, so a pair leaving while another
    // with the same canonical path comes keeps notify's watch for that one.
    let mut kept = Vec::new();
    for r in current.iter().filter(|r| !wanted.contains(r)) {
        if wanted.iter().any(|w| w.canonical == r.canonical) {
            kept.push(r.canonical.clone());
            watches.roots.lock().unwrap().retain(|x| x != r);
            continue;
        }
        match watcher.unwatch(&r.canonical) {
            Ok(()) => {}
            Err(e) if matches!(e.kind, ErrorKind::WatchNotFound) => {}
            Err(e) => {
                result = Err(format!("unwatching {}: {e}", r.lexical));
                break;
            }
        }
        watches.roots.lock().unwrap().retain(|x| x != r);
    }
    if result.is_ok() {
        for r in wanted {
            if watches.roots.lock().unwrap().contains(&r) {
                continue;
            }
            if !kept.contains(&r.canonical) {
                match watcher.watch(&r.canonical, RecursiveMode::NonRecursive) {
                    Ok(()) => {}
                    // Gone since it was resolved, as in a checkout: notify
                    // added nothing and restarted the stream with the paths it
                    // had, so the rest stay watched and only this one is refused.
                    Err(e) if is_not_found(&e) => {
                        refused.push(Refused { path: r.lexical, error: "no such file".to_string() });
                        continue;
                    }
                    Err(e) => {
                        result = Err(format!("watching {}: {e}", r.lexical));
                        break;
                    }
                }
            }
            watches.roots.lock().unwrap().push(r);
        }
    }
    if let Err(e) = result {
        // Dropping the watcher stops its stream, so nothing is watched,
        // whatever notify kept of its paths, and the next call starts a fresh
        // watcher and registers its whole set: nothing needs rolling back.
        inner.watcher = None;
        watches.roots.lock().unwrap().clear();
        return Err(e);
    }
    Ok(refused)
}

#[tauri::command]
pub async fn set_watched(app: AppHandle, generation: u64, folders: Vec<String>) -> Result<Vec<Refused>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let emitter = app.clone();
        let emit = move |folders: Vec<String>| {
            if let Err(e) = emitter.emit_to("main", FOLDER_EVENT, folders) {
                eprintln!("vaquita: sending the changed folders failed: {e}");
            }
        };
        apply(&app.state::<Watches>(), generation, folders, emit)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{RecvTimeoutError, channel};
    use std::time::Duration;

    use crate::open_path::tests::{dir, file};

    fn root(canonical: &str, lexical: &str) -> Root {
        Root { canonical: PathBuf::from(canonical), lexical: lexical.to_string() }
    }

    #[test]
    fn an_entry_names_the_folder_it_is_in() {
        let roots = [root("/x/repo", "/x/repo")];
        assert_eq!(to_reload(Path::new("/x/repo/a.ts"), &roots), ["/x/repo"]);
    }

    #[test]
    fn a_watched_folder_names_itself() {
        let roots = [root("/x/repo/src", "/x/repo/src")];
        assert_eq!(to_reload(Path::new("/x/repo/src"), &roots), ["/x/repo/src"]);
    }

    #[test]
    fn a_watched_folder_in_a_watched_folder_names_both() {
        let roots = [root("/x/repo", "/x/repo"), root("/x/repo/src", "/x/repo/src")];
        assert_eq!(to_reload(Path::new("/x/repo/src"), &roots), ["/x/repo", "/x/repo/src"]);
    }

    #[test]
    fn an_unrelated_path_names_nothing() {
        let roots = [root("/x/repo", "/x/repo"), root("/x/repo/src", "/x/repo/src")];
        assert!(to_reload(Path::new("/x/other/a.ts"), &roots).is_empty());
        assert!(to_reload(Path::new("/x/repo/src/deep/a.ts"), &roots).is_empty());
    }

    #[test]
    fn a_canonical_path_names_the_lexical_folder() {
        let roots = [root("/private/tmp/repo", "/tmp/repo")];
        assert_eq!(to_reload(Path::new("/private/tmp/repo/a.ts"), &roots), ["/tmp/repo"]);
    }

    #[test]
    fn a_rescan_names_every_watched_folder() {
        use ::notify::event::Flag;
        let roots = [root("/x/repo", "/x/repo"), root("/x/repo/src", "/x/repo/src")];
        let event = Event::new(EventKind::Other).add_path(PathBuf::from("/x/repo")).set_flag(Flag::Rescan);
        assert_eq!(affected(&event, &roots), ["/x/repo", "/x/repo/src"]);
        // Without the flag the same event names only the folders it concerns.
        let plain = Event::new(EventKind::Other).add_path(PathBuf::from("/x/repo/src"));
        assert_eq!(affected(&plain, &roots), ["/x/repo", "/x/repo/src"]);
        let plain = Event::new(EventKind::Other).add_path(PathBuf::from("/x/repo/a.ts"));
        assert_eq!(affected(&plain, &roots), ["/x/repo"]);
    }

    #[test]
    fn only_events_that_can_change_a_listing_count() {
        use ::notify::event::{AccessKind, CreateKind, DataChange, MetadataKind, RemoveKind, RenameMode};
        let at = |kind, path: &str| Event::new(kind).add_path(PathBuf::from(path));
        for kind in [
            EventKind::Create(CreateKind::File),
            EventKind::Remove(RemoveKind::Folder),
            EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
            EventKind::Modify(ModifyKind::Any),
            EventKind::Any,
            EventKind::Other,
        ] {
            assert!(changes_listing(&at(kind, "/x/repo/a.ts")), "{kind:?}");
        }
        for kind in [
            EventKind::Access(AccessKind::Any),
            EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any)),
        ] {
            assert!(!changes_listing(&at(kind, "/x/repo/a.ts")), "{kind:?}");
        }
        // A .gitignore's contents decide what the listing marks ignored.
        assert!(changes_listing(&at(EventKind::Modify(ModifyKind::Data(DataChange::Content)), "/x/repo/.gitignore")));
        assert!(!changes_listing(&at(EventKind::Modify(ModifyKind::Data(DataChange::Content)), "/x/repo/a.gitignore")));
        assert!(!changes_listing(&at(EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any)), "/x/repo/.gitignore")));
    }

    #[test]
    fn a_gitignore_names_every_watched_folder_under_it() {
        let roots = [root("/x/repo", "/x/repo"), root("/x/repo/src", "/x/repo/src"), root("/x/repo/src/a", "/x/repo/src/a"), root("/x/other", "/x/other")];
        let event = Event::new(EventKind::Other).add_path(PathBuf::from("/x/repo/src/.gitignore"));
        assert_eq!(affected(&event, &roots), ["/x/repo/src", "/x/repo/src/a"]);
    }

    // A folder removed between its canonicalize and its watch cannot be
    // staged without racing FSEvents, so the errors notify gives for one are
    // checked here instead.
    #[test]
    fn a_folder_gone_before_its_watch_is_told_from_other_failures() {
        assert!(is_not_found(&::notify::Error::path_not_found()));
        assert!(is_not_found(&::notify::Error::io(std::io::Error::from(std::io::ErrorKind::NotFound))));
        assert!(!is_not_found(&::notify::Error::io(std::io::Error::from(std::io::ErrorKind::PermissionDenied))));
        assert!(!is_not_found(&::notify::Error::generic("unable to start FSEvent stream")));
        assert!(!is_not_found(&::notify::Error::watch_not_found()));
    }

    // Neither call watches a folder, so no FSEvents stream starts.
    #[test]
    fn a_call_older_than_the_last_applied_changes_nothing() {
        let watches = Watches::default();
        let d = dir("watch-stale");
        let missing = d.join("missing").to_string_lossy().into_owned();
        assert!(apply(&watches, 2, Vec::new(), |_| {}).unwrap().is_empty());
        // Stale: not even resolved, so the missing folder is not refused and
        // the real one is not watched.
        let stale = apply(&watches, 1, vec![missing.clone(), d.to_string_lossy().into_owned()], |_| {}).unwrap();
        assert!(stale.is_empty());
        assert!(watches.roots.lock().unwrap().is_empty());
        assert_eq!(watches.inner.lock().unwrap().generation, 2);
        // The same generation again is applied.
        let refused = apply(&watches, 2, vec![missing.clone()], |_| {}).unwrap();
        assert_eq!(refused.len(), 1);
        assert_eq!((refused[0].path.as_str(), refused[0].error.as_str()), (missing.as_str(), "no such file"));
    }

    // Needs this Mac's FSEvents, so it is run by hand (`cargo test watch --
    // --ignored`) and never in release.yml, where a flaky test has blocked a
    // release before.
    #[test]
    #[ignore]
    fn fsevents_report_a_watched_folders_entries_and_not_deeper() {
        let d = dir("watch-fsevents");
        // Made before the watch, which reports only what comes after it.
        std::fs::create_dir_all(d.join("a/b")).unwrap();
        let lexical = d.to_string_lossy().into_owned();
        let canonical = std::fs::canonicalize(&d).unwrap();
        let roots = Arc::new(Mutex::new(vec![Root { canonical: canonical.clone(), lexical: lexical.clone() }]));
        let (tx, rx) = channel();
        let mut watcher = new_watcher(roots, move |f| {
            let _ = tx.send(f);
        })
        .unwrap();
        watcher.watch(&canonical, RecursiveMode::NonRecursive).unwrap();
        // The deep file first, so no late event of the near one is taken for it.
        file(&d.join("a/b"), "deep.txt", 0o644);
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)), Err(RecvTimeoutError::Timeout));
        file(&d, "near.txt", 0o644);
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), [lexical]);
    }
}
