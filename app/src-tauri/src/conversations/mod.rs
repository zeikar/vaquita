//! A repo's past agent conversations, for the sidebar's list of what can be
//! resumed: Claude Code's transcripts (claude.rs) and Codex's rollouts
//! (codex.rs), in one list.
//!
//! Which repo a conversation belongs to is decided here, against the whole
//! registered list: the registered repo with the most path components that
//! are a prefix of its canonical cwd, the sidebar's rule. So a repo registered
//! inside the root keeps its conversations out of the root's list, and a git
//! worktree outside the folder belongs to no repo.
//!
//! What was read is cached by path with the file's stamp, so a second show
//! only stats what did not change. Only a successful read is cached: a file
//! that could not be read is left out of that answer and read again on the next.

mod claude;
mod codex;

use std::collections::{HashMap, HashSet};
use std::fs::{File, Metadata, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;

use crate::files::Stamp;

const HEAD_MAX: u64 = 64 * 1024;
const TITLE_MAX: usize = 200;
const UNTITLED: &str = "Untitled";
/// The most cache entries kept that the last scan did not see.
const CACHE_MAX: usize = 4096;

#[derive(Debug, Clone, Serialize)]
pub struct Conversation {
    /// "claude" or "codex".
    agent: &'static str,
    id: String,
    title: String,
    cwd: String,
    /// Unix milliseconds.
    last_active: u64,
}

#[derive(Debug, Serialize)]
pub struct ConversationList {
    entries: Vec<Conversation>,
}

/// What a transcript says about itself, as cached.
#[derive(Debug, Clone)]
struct Meta {
    agent: &'static str,
    id: String,
    cwd: PathBuf,
    title: String,
}

/// None for a file read and found not to be a conversation, so it is not
/// read again until it changes.
type Entries = HashMap<PathBuf, (Stamp, Option<Meta>)>;

#[derive(Default, Clone)]
pub struct Cache(Arc<Mutex<Entries>>);

/// UUID-shaped, as the daemon's convid.ValidID: 8-4-4-4-12 hex digits of
/// either case. The daemon puts the id on a command line to resume it.
fn valid_id(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// The first line of raw as a title, None when nothing shows of it.
fn clean_title(raw: &str) -> Option<String> {
    let line = raw.trim_start().lines().next().unwrap_or_default();
    let spaced: String = line.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let title: String = spaced.trim().chars().take(TITLE_MAX).collect();
    (!title.is_empty()).then_some(title)
}

/// Whether a user's text is what they typed: a tag is written by the agent
/// (a slash command, an attachment, Codex's environment), not by them.
fn shown(s: &str) -> bool {
    !s.trim().is_empty() && !s.trim_start().starts_with('<')
}

/// path opened for reading, when it is a regular file.
fn open_regular(path: &Path) -> io::Result<(File, Metadata)> {
    // Nonblocking, so a FIFO swapped in since the stat cannot hang the open;
    // a symlink swapped in is not followed.
    let f = OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW).open(path)?;
    let opened = f.metadata()?;
    if !opened.is_file() {
        return Err(io::Error::other("not a regular file"));
    }
    Ok((f, opened))
}

/// The registered repos, each canonical when it exists; one that does not
/// owns nothing that exists, but its prefix still beats a shorter one, as in
/// the sidebar.
struct Repos {
    canonical: Vec<(PathBuf, String)>,
}

impl Repos {
    fn new(registered: &[String]) -> Repos {
        let canonical = registered
            .iter()
            .map(|r| (Path::new(r).canonicalize().unwrap_or_else(|_| PathBuf::from(r)), r.clone()))
            .collect();
        Repos { canonical }
    }
}

/// The repo whose components are the longest prefix of cwd's, canonical and
/// as registered: repoOf in groups.ts on canonical paths, the first of equals
/// winning as there.
fn owner<'a>(repos: &'a Repos, cwd: &Path) -> Option<(&'a Path, &'a str)> {
    let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let mut best: Option<(&(PathBuf, String), usize)> = None;
    for repo in repos.canonical.iter().filter(|(c, _)| cwd.starts_with(c)) {
        let n = repo.0.components().count();
        if best.is_none_or(|(_, m)| n > m) {
            best = Some((repo, n));
        }
    }
    best.map(|((c, r), _)| (c.as_path(), r.as_str()))
}

/// At most the last max bytes of f, from the first line that starts in them.
/// The byte before them is read too, so a line starting right at the cut is kept.
fn read_tail(mut f: &File, len: u64, max: u64) -> io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    if len <= max {
        f.seek(SeekFrom::Start(0))?;
        f.take(max).read_to_end(&mut buf)?;
        return Ok(buf);
    }
    f.seek(SeekFrom::Start(len - max - 1))?;
    f.take(max + 1).read_to_end(&mut buf)?;
    let from = buf.iter().position(|&b| b == b'\n').map_or(buf.len(), |i| i + 1);
    buf.drain(..from);
    Ok(buf)
}

/// The complete lines of bytes; what follows the last `\n` is a line still
/// being written, or one a bounded read cut.
fn lines(bytes: &[u8]) -> impl DoubleEndedIterator<Item = &[u8]> {
    let end = bytes.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    bytes[..end].split_inclusive(|&b| b == b'\n').map(|l| &l[..l.len() - 1])
}

fn json_lines(bytes: &[u8]) -> impl DoubleEndedIterator<Item = Value> {
    lines(bytes).filter_map(|l| serde_json::from_slice::<Value>(l).ok())
}

/// What dir holds, with whether each is a folder; nothing when dir does not
/// exist. Only listing dir itself fails; an entry that cannot be read is
/// reported and passed over.
fn entries(dir: &Path) -> io::Result<Vec<(PathBuf, bool)>> {
    let listed = match std::fs::read_dir(dir) {
        Ok(l) => l,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    Ok(listed
        .filter_map(|entry| match entry.and_then(|e| Ok((e.path(), e.file_type()?.is_dir()))) {
            Ok(found) => Some(found),
            Err(e) => {
                eprintln!("vaquita: listing {}: {e}", dir.display());
                None
            }
        })
        .collect())
}

/// entries of a folder below the one that decides the answer: one that
/// cannot be listed is reported and passed over.
fn entries_below(dir: &Path) -> Vec<(PathBuf, bool)> {
    entries(dir).unwrap_or_else(|e| {
        eprintln!("vaquita: listing {}: {e}", dir.display());
        Vec::new()
    })
}

/// What path holds, from the cache when its stamp is unchanged. A file that
/// cannot be read is left out and tried again next time, never failing the
/// list: every rollout is read for every root, so one bad file of any repo
/// would otherwise break them all.
fn cached<F>(cache: &Cache, path: &Path, read: F) -> Option<(Stamp, Meta)>
where
    F: FnOnce(&Path) -> io::Result<Option<Meta>>,
{
    let stamp = match std::fs::symlink_metadata(path).and_then(|m| if m.is_file() { Stamp::of(&m).map(Some) } else { Ok(None) }) {
        Ok(Some(s)) => s,
        Ok(None) => return None,
        // Gone since it was listed.
        Err(e) if e.kind() == io::ErrorKind::NotFound => return None,
        Err(e) => {
            eprintln!("vaquita: reading {}: {e}", path.display());
            return None;
        }
    };
    if let Some((s, meta)) = cache.0.lock().unwrap().get(path)
        && *s == stamp
    {
        return meta.clone().map(|m| (stamp, m));
    }
    // The lock is not held across the read.
    match read(path) {
        Ok(meta) => {
            cache.0.lock().unwrap().insert(path.to_path_buf(), (stamp, meta.clone()));
            meta.map(|m| (stamp, m))
        }
        Err(e) => {
            eprintln!("vaquita: reading {}: {e}", path.display());
            None
        }
    }
}

/// Keeps the entries the last scan did not see bounded by CACHE_MAX. Every
/// rollout is seen by every scan, so bounding the whole cache would drop
/// the other roots' transcripts on every show once there are many.
fn prune(cache: &Cache, seen: &HashSet<PathBuf>) {
    let mut map = cache.0.lock().unwrap();
    if map.len() > seen.len() + CACHE_MAX {
        map.retain(|p, _| seen.contains(p));
    }
}

/// The root's conversations, newest first, all of them: the view filters by
/// title over this list, so a cut here would make the oldest unreachable. repos is the
/// whole registered list; the root is added when a list that raced a repo
/// change lacks it. A conversation is the root's when its owner is the same
/// folder, so the root's list is whole even when another spelling of it,
/// registered earlier, is the owner by name.
pub fn list(home: &Path, root: &str, repos: &[String], cache: &Cache) -> Result<ConversationList, String> {
    let root_canonical = Path::new(root).canonicalize().map_err(|e| format!("cannot read {root}: {e}"))?;
    let mut registered = repos.to_vec();
    if !registered.iter().any(|r| r == root) {
        registered.push(root.to_string());
    }
    let repos = Repos::new(&registered);
    let claude = claude::candidates(home, Path::new(root), &root_canonical)?;
    let codex = codex::rollouts(home)?;
    type Reader = fn(&Path) -> io::Result<Option<Meta>>;
    let readers = claude.into_iter().map(|p| (p, claude::meta as Reader)).chain(codex.into_iter().map(|p| (p, codex::meta as Reader)));
    // Read only when the root has a Codex conversation to name.
    let mut titles = None;
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for (path, read) in readers {
        let found = cached(cache, &path, read);
        seen.insert(path);
        let Some((stamp, meta)) = found else { continue };
        if owner(&repos, &meta.cwd).map(|(c, _)| c) != Some(root_canonical.as_path()) {
            continue;
        }
        // The index is applied after the cache, as it changes while a rollout does not.
        let named = if meta.agent == "codex" { titles.get_or_insert_with(|| codex::index_titles(home)).get(&meta.id).and_then(|t| clean_title(t)) } else { None };
        entries.push(Conversation {
            agent: meta.agent,
            id: meta.id,
            title: named.unwrap_or(meta.title),
            cwd: in_roots_spelling(root, &root_canonical, &meta.cwd),
            last_active: stamp.unix_ms(),
        });
    }
    prune(cache, &seen);
    entries.sort_by(|a, b| b.last_active.cmp(&a.last_active).then_with(|| a.id.cmp(&b.id)));
    Ok(ConversationList { entries })
}

/// cwd under the root's registered spelling: the sidebar groups sessions by
/// literal path, so a resume in a transcript's other spelling of the folder
/// (/private/tmp/repo for /tmp/repo) would land outside the repo. A cwd that
/// is not under the canonical root is kept as given.
fn in_roots_spelling(root: &str, root_canonical: &Path, cwd: &Path) -> String {
    let canonical = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    match canonical.strip_prefix(root_canonical) {
        Ok(rest) if rest.as_os_str().is_empty() => root.to_string(),
        Ok(rest) => Path::new(root).join(rest).to_string_lossy().into_owned(),
        Err(_) => cwd.to_string_lossy().into_owned(),
    }
}

#[tauri::command]
pub async fn past_conversations(cache: tauri::State<'_, Cache>, root: String, repos: Vec<String>) -> Result<ConversationList, String> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
        list(Path::new(&home), &root, &repos, &cache)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::codex::tests::{message, rollout};
    use super::*;
    use std::ffi::OsStr;
    use crate::open_path::tests::dir;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, SystemTime};

    pub(super) const ID_A: &str = "0b6f3c1e-2a4d-4c8b-9e1f-7a2b3c4d5e6f";
    pub(super) const ID_B: &str = "1c7e4d2f-3b5e-4d9c-8f20-8b3c4d5e6f70";
    pub(super) const ID_C: &str = "2d8f5e30-4c6f-4ea0-9031-9c4d5e6f7081";
    pub(super) const ID_D: &str = "3e906f41-5d70-4fb1-a142-ad5e6f708192";
    pub(super) const ID_E: &str = "4fa17052-6e81-40c2-b253-be6f708192a3";
    pub(super) const ID_F: &str = "50b28163-7f92-41d3-8364-cf708192a3b4";

    pub(super) fn id(i: usize) -> String {
        format!("{i:08x}-0000-4000-8000-{i:012x}")
    }

    /// A home with a repo folder in it, the root as given; the temp folder
    /// sits behind /var, a symlink, so the given root is not canonical.
    pub(super) fn setup(name: &str) -> (PathBuf, String) {
        let home = dir(&format!("conv-{name}"));
        let root = home.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        (home, root.to_str().unwrap().to_string())
    }

    pub(super) fn project(root: &str) -> String {
        claude::loosen(OsStr::new(root))
    }

    pub(super) fn transcript(home: &Path, dir_name: &str, id: &str, lines: &[&str]) -> PathBuf {
        let d = home.join(".claude/projects").join(dir_name);
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join(format!("{id}.jsonl"));
        let mut f = File::create(&p).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        p
    }

    pub(super) fn user(cwd: &str, text: &str) -> String {
        serde_json::json!({"type": "user", "cwd": cwd, "message": {"role": "user", "content": text}}).to_string()
    }

    pub(super) fn ai_title(title: &str) -> String {
        serde_json::json!({"type": "ai-title", "aiTitle": title}).to_string()
    }

    pub(super) fn run(home: &Path, root: &str, repos: &[&str], cache: &Cache) -> ConversationList {
        let repos: Vec<String> = repos.iter().map(|r| r.to_string()).collect();
        list(home, root, &repos, cache).unwrap()
    }

    pub(super) fn titles(l: &ConversationList) -> Vec<&str> {
        l.entries.iter().map(|c| c.title.as_str()).collect()
    }

    pub(super) fn sorted_titles(l: &ConversationList) -> Vec<String> {
        let mut t: Vec<String> = titles(l).into_iter().map(String::from).collect();
        t.sort();
        t
    }

    pub(super) fn by_id(l: &ConversationList) -> HashMap<&str, &str> {
        l.entries.iter().map(|c| (c.id.as_str(), c.title.as_str())).collect()
    }

    pub(super) fn set_mtime(p: &Path, secs: u64) {
        let f = File::options().write(true).open(p).unwrap();
        f.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(secs)).unwrap();
    }

    #[test]
    fn a_nested_repos_conversations_are_its_own_and_not_counted_for_the_parent() {
        let (home, root) = setup("nested");
        let sub = format!("{root}/sub");
        std::fs::create_dir_all(format!("{sub}/x")).unwrap();
        transcript(&home, &format!("{}-sub-x", project(&root)), ID_A, &[&user(&format!("{sub}/x"), "in sub")]);
        transcript(&home, &project(&root), ID_B, &[&user(&root, "in root")]);
        let cache = Cache::default();
        let l = run(&home, &root, &[&root, &sub], &cache);
        assert_eq!(titles(&l), ["in root"]);

        let dir_name = format!("{}-sub", project(&root));
        for i in 0..3 {
            transcript(&home, &dir_name, &id(i), &[&user(&sub, "many")]);
        }
        let l = run(&home, &root, &[&root, &sub], &cache);
        assert_eq!(titles(&l), ["in root"]);
    }

    #[test]
    fn newest_first_and_every_row_is_returned() {
        let (home, root) = setup("order");
        let p = project(&root);
        for (i, (id, secs)) in [(ID_A, 2_000), (ID_B, 3_000), (ID_C, 1_000)].into_iter().enumerate() {
            let f = transcript(&home, &p, id, &[&user(&root, &format!("t{i}"))]);
            set_mtime(&f, secs);
        }
        let l = run(&home, &root, &[&root], &Cache::default());
        assert_eq!(l.entries.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), [ID_B, ID_A, ID_C]);
        assert_eq!(l.entries[0].last_active, 3_000_000);

        for i in 0..600 {
            let f = transcript(&home, &p, &id(i), &[&user(&root, "many")]);
            set_mtime(&f, 10_000 + i as u64);
        }
        let l = run(&home, &root, &[&root], &Cache::default());
        assert_eq!(l.entries.len(), 603);
        assert_eq!(l.entries[0].id, id(599));
        assert_eq!(l.entries[602].id, ID_C);
    }

    #[test]
    fn claude_and_codex_rows_share_one_order_by_last_active() {
        let (home, root) = setup("mixed");
        set_mtime(&transcript(&home, &project(&root), ID_A, &[&user(&root, "claude one")]), 2_000);
        set_mtime(&rollout(&home, "2026/10/24", "2026-10-24T10-00-00", ID_B, &root, &[&message("user", "codex new")]), 3_000);
        set_mtime(&rollout(&home, "2026/10/23", "2026-10-23T10-00-00", ID_C, &root, &[&message("user", "codex old")]), 1_000);
        let l = run(&home, &root, &[&root], &Cache::default());
        assert_eq!(l.entries.iter().map(|c| (c.agent, c.title.as_str())).collect::<Vec<_>>(), [("codex", "codex new"), ("claude", "claude one"), ("codex", "codex old")]);
    }

    #[test]
    fn prune_bounds_only_what_the_scan_did_not_see() {
        let d = dir("conv-prune");
        let f = d.join("f");
        std::fs::write(&f, "").unwrap();
        let stamp = Stamp::of(&std::fs::metadata(&f).unwrap()).unwrap();
        let cache = Cache::default();
        let path = |i: usize| PathBuf::from(format!("/tmp/repo/{i}"));
        let seen: HashSet<PathBuf> = (0..CACHE_MAX + 10).map(path).collect();
        let fill = |n: usize| {
            let mut map = cache.0.lock().unwrap();
            for i in 0..n {
                map.insert(path(i), (stamp, None));
            }
        };
        // Every seen entry and CACHE_MAX unseen ones are kept.
        fill(seen.len() + CACHE_MAX);
        prune(&cache, &seen);
        assert_eq!(cache.0.lock().unwrap().len(), seen.len() + CACHE_MAX);
        fill(seen.len() + CACHE_MAX + 1);
        prune(&cache, &seen);
        assert_eq!(cache.0.lock().unwrap().len(), seen.len());
    }

    #[test]
    fn an_unchanged_file_is_not_read_again_and_a_changed_one_is() {
        let (home, root) = setup("cache");
        let f = transcript(&home, &project(&root), ID_A, &[&user(&root, "hi"), &ai_title("First")]);
        let cache = Cache::default();
        assert_eq!(titles(&run(&home, &root, &[&root], &cache)), ["First"]);
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o000)).unwrap();
        let again = list(&home, &root, std::slice::from_ref(&root), &cache);
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(titles(&again.unwrap()), ["First"]);
        writeln!(File::options().append(true).open(&f).unwrap(), "{}", ai_title("Second")).unwrap();
        assert_eq!(titles(&run(&home, &root, &[&root], &cache)), ["Second"]);
    }

    #[test]
    fn a_root_that_does_not_exist_is_an_error() {
        let (home, root) = setup("gone");
        let gone = format!("{root}/gone");
        let e = list(&home, &gone, std::slice::from_ref(&gone), &Cache::default()).unwrap_err();
        assert!(e.starts_with(&format!("cannot read {gone}: ")), "{e}");
    }

    #[test]
    fn titles_are_one_clean_line_of_at_most_200_characters() {
        assert_eq!(clean_title("  Fix\x07 it\nsecond line").as_deref(), Some("Fix  it"));
        let long = "가".repeat(300);
        assert_eq!(clean_title(&long), Some("가".repeat(200)));
        assert_eq!(clean_title(""), None);
        assert_eq!(clean_title(" \n "), None);
    }

    #[test]
    fn ids_are_uuid_shaped_in_either_case() {
        assert!(valid_id(ID_A));
        assert!(valid_id(&ID_A.to_uppercase()));
        assert!(!valid_id("notes"));
        assert!(!valid_id(&ID_A.replace('-', "_")));
        assert!(!valid_id(&format!("{ID_A}0")));
    }

    #[test]
    fn the_owner_is_the_registered_repo_with_the_longest_whole_component_prefix() {
        let d = dir("conv-owner");
        for sub in ["repo/sub/x", "repo-feature", "elsewhere"] {
            std::fs::create_dir_all(d.join(sub)).unwrap();
        }
        let at = |p: &str| d.join(p).to_str().unwrap().to_string();
        let repos = Repos::new(&[at("repo"), at("repo/sub")]);
        let named = |cwd: &Path| owner(&repos, cwd).map(|(_, r)| r.to_string());
        assert_eq!(named(&d.join("repo-feature")), None);
        assert_eq!(named(&d.join("repo/sub/x")), Some(at("repo/sub")));
        assert_eq!(named(&d.join("repo")), Some(at("repo")));
        assert_eq!(named(&d.join("elsewhere")), None);
        // Canonical on one side and not the other still meet.
        let canonical = d.join("repo").canonicalize().unwrap();
        assert_eq!(named(&canonical), Some(at("repo")));
        // Of two spellings of one folder the first registered wins, as in repoOf.
        let spelled = canonical.to_str().unwrap().to_string();
        let both = Repos::new(&[spelled.clone(), at("repo")]);
        assert_eq!(owner(&both, &d.join("repo/sub")).map(|(_, r)| r), Some(spelled.as_str()));
    }

    #[test]
    fn either_spelling_of_a_folder_registered_twice_lists_its_conversations() {
        let (home, root) = setup("spellings");
        let canonical = Path::new(&root).canonicalize().unwrap().to_str().unwrap().to_string();
        transcript(&home, &project(&canonical), ID_A, &[&user(&canonical, "here")]);
        let cache = Cache::default();
        assert_eq!(titles(&run(&home, &root, &[&canonical, &root], &cache)), ["here"]);
        assert_eq!(titles(&run(&home, &canonical, &[&canonical, &root], &cache)), ["here"]);
    }

    #[test]
    fn a_cwd_is_given_in_the_roots_registered_spelling() {
        let (_, root) = setup("spelling");
        std::fs::create_dir_all(format!("{root}/src")).unwrap();
        let canonical = Path::new(&root).canonicalize().unwrap();
        assert_ne!(canonical.to_str().unwrap(), root);
        let at = |cwd: &Path| in_roots_spelling(&root, &canonical, cwd);
        assert_eq!(at(&canonical), root);
        assert_eq!(at(&canonical.join("src")), format!("{root}/src"));
        // Not on disk: the rest is carried over, or the cwd kept when outside.
        assert_eq!(at(&canonical.join("gone")), format!("{root}/gone"));
        assert_eq!(at(Path::new("/tmp/elsewhere")), "/tmp/elsewhere");
    }

    #[test]
    fn a_listed_conversation_resumes_under_the_registered_spelling() {
        let (home, root) = setup("spelling-list");
        let canonical = Path::new(&root).canonicalize().unwrap().to_str().unwrap().to_string();
        transcript(&home, &project(&canonical), ID_A, &[&user(&canonical, "here")]);
        let l = run(&home, &root, &[&root], &Cache::default());
        assert_eq!(l.entries[0].cwd, root);
    }

    #[test]
    fn the_tail_keeps_a_line_that_starts_right_at_the_cut() {
        let d = dir("conv-tail");
        let p = d.join("t");
        std::fs::write(&p, "AAAA\nBBBB\n").unwrap();
        let f = File::open(&p).unwrap();
        assert_eq!(read_tail(&f, 10, 5).unwrap(), b"BBBB\n");
        assert_eq!(read_tail(&f, 10, 4).unwrap(), b"");
        assert_eq!(read_tail(&f, 10, 10).unwrap(), b"AAAA\nBBBB\n");
    }

    #[test]
    fn lines_leave_out_a_cut_last_line() {
        assert_eq!(lines(b"a\nb\nc").collect::<Vec<_>>(), [b"a", b"b"]);
        assert_eq!(lines(b"a\n").collect::<Vec<_>>(), [b"a"]);
        assert_eq!(lines(b"cut").count(), 0);
        assert_eq!(lines(b"").count(), 0);
    }
}
