//! A repo's past agent conversations, for the sidebar's list of what can be
//! resumed. Claude Code keeps each one as `~/.claude/projects/<dir>/<uuid>.jsonl`,
//! where `<dir>` is the cwd with every character that is not ASCII
//! alphanumeric made `-`. That name is lossy (`/tmp/a-b` and `/tmp/a/b` share
//! it), so it only narrows which folders are opened; the `cwd` written inside
//! the transcript decides where the conversation was. A folder is opened when
//! its name is the root's, or the root's followed by `-` (a subfolder's, or a
//! sibling's that the `cwd` then rules out), for the root as registered and as
//! canonical, since Claude records `/tmp/repo` as `/private/tmp/repo`.
//!
//! Which repo a conversation belongs to is decided here, against the whole
//! registered list and before the cap: the registered repo with the most path
//! components that are a prefix of its canonical cwd, the sidebar's rule. So
//! a repo registered inside the root keeps its conversations out of the
//! root's list and out of its total, and a git worktree outside the folder
//! belongs to no repo.
//!
//! A transcript can be many megabytes, so only its first HEAD_MAX bytes and
//! last TAIL_MAX bytes are read: the head for the first `cwd` (every
//! transcript has one there) and the first typed prompt, the fallback title;
//! the tail for the last `ai-title` line, which Claude appends anew as the
//! title changes. A title last set further from the end than TAIL_MAX is
//! missed and the prompt shown instead. The time is the file's mtime, as a
//! transcript is appended to on every turn and holds no single last time.
//!
//! What was read is cached by path with the file's stamp, so a second show
//! only stats what did not change. Only a successful read is cached: a file
//! that could not be read is left out of that answer and read again on the next.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;

use crate::files::{self, Stamp};

const HEAD_MAX: u64 = 64 * 1024;
const TAIL_MAX: u64 = 64 * 1024;
const CAP: usize = 500;
const TITLE_MAX: usize = 200;
const UNTITLED: &str = "Untitled";
/// The longest project folder name Claude writes uncut.
const CLAUDE_NAME_MAX: usize = 200;
/// Past this many entries the cache drops what the last scan did not see.
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
    /// Before the cap.
    total: usize,
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

/// A path as Claude names its project folder. Claude replaces UTF-16 code
/// units, so a non-ASCII character becomes one `-` per unit, not per byte.
fn loosen(name: &OsStr) -> String {
    let mut out = String::new();
    for c in name.to_string_lossy().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n('-', c.len_utf16()));
        }
    }
    out
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

/// What the user typed in a user line: its content as a string, or the first
/// text part when it has parts (an image is another part, a tool result has
/// none). A slash command or an attachment is written as a tag, not as typed.
fn typed(v: &Value) -> Option<&str> {
    let shown = |s: &&str| !s.trim().is_empty() && !s.trim_start().starts_with('<');
    match v.pointer("/message/content")? {
        Value::String(s) => Some(s.as_str()).filter(shown),
        Value::Array(parts) => parts
            .iter()
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .find(shown),
        _ => None,
    }
}

/// The transcript at path, its stem already a valid id; None when its head
/// has no cwd, as sidechain and tool files have none.
fn claude_meta(path: &Path) -> io::Result<Option<Meta>> {
    // Nonblocking, so a FIFO swapped in since the stat cannot hang the open;
    // a symlink swapped in is not followed.
    let f = OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW).open(path)?;
    let opened = f.metadata()?;
    if !opened.is_file() {
        return Err(io::Error::other("not a regular file"));
    }
    let head = files::head(&f, HEAD_MAX)?;
    let mut cwd = None;
    let mut prompt = None;
    for v in json_lines(&head) {
        if cwd.is_none() {
            cwd = v.get("cwd").and_then(Value::as_str).map(PathBuf::from);
        }
        if prompt.is_none() && v.get("type").and_then(Value::as_str) == Some("user") {
            prompt = typed(&v).and_then(clean_title);
        }
        if cwd.is_some() && prompt.is_some() {
            break;
        }
    }
    let Some(cwd) = cwd else { return Ok(None) };
    // A head shorter than HEAD_MAX is the whole file.
    let tail = if (head.len() as u64) < HEAD_MAX { head } else { read_tail(&f, opened.len(), TAIL_MAX)? };
    let ai_title = json_lines(&tail).rev().find_map(|v| {
        if v.get("type").and_then(Value::as_str) != Some("ai-title") {
            return None;
        }
        Some(v.get("aiTitle").and_then(Value::as_str).and_then(clean_title))
    });
    let id = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let title = ai_title.flatten().or(prompt).unwrap_or_else(|| UNTITLED.to_string());
    Ok(Some(Meta { agent: "claude", id, cwd, title }))
}

/// The transcripts in the project folders named for the root in either form.
/// Only listing the projects folder itself fails; an entry or a project
/// folder that cannot be read is reported and passed over.
fn claude_candidates(home: &Path, root_given: &Path, root_canonical: &Path) -> io::Result<Vec<PathBuf>> {
    let projects = home.join(".claude/projects");
    let dirs = match std::fs::read_dir(&projects) {
        Ok(d) => d,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    // Claude cuts a name past CLAUDE_NAME_MAX and adds `-<hash>`, so a long
    // root's folder, and its subfolders', start with its first
    // CLAUDE_NAME_MAX characters; loosen's output is ASCII, so the byte cut
    // is a character cut.
    let keys = [root_given, root_canonical].map(|r| {
        let mut k = loosen(r.as_os_str());
        k.truncate(CLAUDE_NAME_MAX);
        k
    });
    let mut out = Vec::new();
    for entry in dirs {
        let is_dir = entry.and_then(|e| Ok((e.file_type()?.is_dir(), e)));
        let entry = match is_dir {
            Ok((true, e)) => e,
            Ok((false, _)) => continue,
            Err(e) => {
                eprintln!("vaquita: listing {}: {e}", projects.display());
                continue;
            }
        };
        let name = loosen(&entry.file_name());
        if !keys.iter().any(|k| name.strip_prefix(k.as_str()).is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))) {
            continue;
        }
        let files = match std::fs::read_dir(entry.path()) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("vaquita: listing {}: {e}", entry.path().display());
                continue;
            }
        };
        for file in files {
            let path = match file {
                Ok(f) => f.path(),
                Err(e) => {
                    eprintln!("vaquita: listing {}: {e}", entry.path().display());
                    continue;
                }
            };
            let stem = path.file_stem().and_then(OsStr::to_str).unwrap_or_default();
            if path.extension() == Some(OsStr::new("jsonl")) && valid_id(stem) {
                out.push(path);
            }
        }
    }
    Ok(out)
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

/// Keeps the cache bounded by what the last scan saw. One root with more
/// than CACHE_MAX transcripts makes every other root's entries be read
/// again on their next show; that is accepted.
fn prune(cache: &Cache, seen: &HashSet<PathBuf>) {
    let mut map = cache.0.lock().unwrap();
    if map.len() > CACHE_MAX {
        map.retain(|p, _| seen.contains(p));
    }
}

/// The root's conversations, newest first, at most CAP of them. repos is the
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
    let candidates = claude_candidates(home, Path::new(root), &root_canonical)
        .map_err(|e| format!("cannot list {}: {e}", home.join(".claude/projects").display()))?;
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for path in candidates {
        let found = cached(cache, &path, claude_meta);
        seen.insert(path);
        let Some((stamp, meta)) = found else { continue };
        if owner(&repos, &meta.cwd).map(|(c, _)| c) != Some(root_canonical.as_path()) {
            continue;
        }
        entries.push(Conversation {
            agent: meta.agent,
            id: meta.id,
            title: meta.title,
            cwd: meta.cwd.to_string_lossy().into_owned(),
            last_active: stamp.unix_ms(),
        });
    }
    prune(cache, &seen);
    entries.sort_by(|a, b| b.last_active.cmp(&a.last_active).then_with(|| a.id.cmp(&b.id)));
    let total = entries.len();
    entries.truncate(CAP);
    Ok(ConversationList { entries, total })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open_path::tests::dir;
    use std::io::Write;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::time::{Duration, SystemTime};

    const ID_A: &str = "0b6f3c1e-2a4d-4c8b-9e1f-7a2b3c4d5e6f";
    const ID_B: &str = "1c7e4d2f-3b5e-4d9c-8f20-8b3c4d5e6f70";
    const ID_C: &str = "2d8f5e30-4c6f-4ea0-9031-9c4d5e6f7081";
    const ID_D: &str = "3e906f41-5d70-4fb1-a142-ad5e6f708192";
    const ID_E: &str = "4fa17052-6e81-40c2-b253-be6f708192a3";
    const ID_F: &str = "50b28163-7f92-41d3-8364-cf708192a3b4";

    fn id(i: usize) -> String {
        format!("{i:08x}-0000-4000-8000-{i:012x}")
    }

    /// A home with a repo folder in it, the root as given; the temp folder
    /// sits behind /var, a symlink, so the given root is not canonical.
    fn setup(name: &str) -> (PathBuf, String) {
        let home = dir(&format!("conv-{name}"));
        let root = home.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        (home, root.to_str().unwrap().to_string())
    }

    fn project(root: &str) -> String {
        loosen(OsStr::new(root))
    }

    fn transcript(home: &Path, dir_name: &str, id: &str, lines: &[&str]) -> PathBuf {
        let d = home.join(".claude/projects").join(dir_name);
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join(format!("{id}.jsonl"));
        let mut f = File::create(&p).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        p
    }

    fn user(cwd: &str, text: &str) -> String {
        serde_json::json!({"type": "user", "cwd": cwd, "message": {"role": "user", "content": text}}).to_string()
    }

    fn ai_title(title: &str) -> String {
        serde_json::json!({"type": "ai-title", "aiTitle": title}).to_string()
    }

    fn run(home: &Path, root: &str, repos: &[&str], cache: &Cache) -> ConversationList {
        let repos: Vec<String> = repos.iter().map(|r| r.to_string()).collect();
        list(home, root, &repos, cache).unwrap()
    }

    fn titles(l: &ConversationList) -> Vec<&str> {
        l.entries.iter().map(|c| c.title.as_str()).collect()
    }

    fn set_mtime(p: &Path, secs: u64) {
        let f = File::options().write(true).open(p).unwrap();
        f.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(secs)).unwrap();
    }

    #[test]
    fn a_transcript_in_the_roots_project_folder_is_listed_with_its_last_ai_title() {
        let (home, root) = setup("basic");
        let last_prompt = serde_json::json!({"type": "last-prompt", "lastPrompt": "hi there"}).to_string();
        transcript(&home, &project(&root), ID_A, &[&last_prompt, &user(&root, "hi there"), &ai_title("Login form"), &ai_title("Fix the login form")]);
        let l = run(&home, &root, &[&root], &Cache::default());
        assert_eq!(l.total, 1);
        let c = &l.entries[0];
        assert_eq!((c.agent, c.id.as_str(), c.title.as_str(), c.cwd.as_str()), ("claude", ID_A, "Fix the login form", root.as_str()));
    }

    #[test]
    fn a_subfolder_is_listed_and_a_sibling_sharing_the_prefix_is_not() {
        let (home, root) = setup("sub");
        let sub = format!("{root}/src");
        let other = format!("{root}-other");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        transcript(&home, &format!("{}-src", project(&root)), ID_A, &[&user(&sub, "in src")]);
        transcript(&home, &format!("{}-other", project(&root)), ID_B, &[&user(&other, "elsewhere")]);
        let l = run(&home, &root, &[&root], &Cache::default());
        assert_eq!(titles(&l), ["in src"]);
        assert_eq!(l.entries[0].cwd, sub);
    }

    #[test]
    fn without_an_ai_title_the_first_typed_prompt_is_the_title() {
        let (home, root) = setup("prompt");
        let p = project(&root);
        transcript(&home, &p, ID_A, &[&user(&root, "plain prompt")]);
        transcript(&home, &p, ID_B, &[&user(&root, "<command-name>/clear</command-name>"), &user(&root, "after the clear")]);
        transcript(&home, &p, ID_C, &[&serde_json::json!({"type": "system", "cwd": root}).to_string()]);
        let mut got = titles(&run(&home, &root, &[&root], &Cache::default())).into_iter().map(String::from).collect::<Vec<_>>();
        got.sort();
        assert_eq!(got, ["Untitled", "after the clear", "plain prompt"]);
    }

    #[test]
    fn only_uuid_named_jsonl_files_with_a_cwd_are_conversations() {
        let (home, root) = setup("ignored");
        let p = project(&root);
        let line = user(&root, "real");
        let d = transcript(&home, &p, ID_A, &[&line]).parent().unwrap().to_path_buf();
        std::fs::write(d.join("notes.jsonl"), format!("{line}\n")).unwrap();
        std::fs::write(d.join(format!("{ID_B}.json")), format!("{line}\n")).unwrap();
        transcript(&home, &format!("{p}/memory"), ID_C, &[&line]);
        transcript(&home, &p, ID_D, &[&serde_json::json!({"type": "user", "message": {"content": "no cwd"}}).to_string()]);
        let l = run(&home, &root, &[&root], &Cache::default());
        assert_eq!(l.entries.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), [ID_A]);
    }

    #[test]
    fn the_title_comes_from_the_last_64_kib_only() {
        let (home, root) = setup("big");
        let p = project(&root);
        let filler_line = serde_json::json!({"type": "assistant", "message": {"content": "x".repeat(1000)}}).to_string();
        let filler: Vec<&str> = std::iter::repeat_n(filler_line.as_str(), 190).collect();
        let first = user(&root, "the prompt");
        let title = ai_title("Late title");
        let at_end: Vec<&str> = [first.as_str()].into_iter().chain(filler.iter().copied()).chain([title.as_str()]).collect();
        let at_start: Vec<&str> = [first.as_str(), title.as_str()].into_iter().chain(filler.iter().copied()).collect();
        let a = transcript(&home, &p, ID_A, &at_end);
        transcript(&home, &p, ID_B, &at_start);
        assert!(std::fs::metadata(&a).unwrap().len() > 190 * 1024);
        let l = run(&home, &root, &[&root], &Cache::default());
        let by_id: HashMap<&str, &str> = l.entries.iter().map(|c| (c.id.as_str(), c.title.as_str())).collect();
        assert_eq!(by_id[ID_A], "Late title");
        assert_eq!(by_id[ID_B], "the prompt");
    }

    #[test]
    fn a_root_given_through_a_symlink_finds_the_canonical_project_folder() {
        let (home, real) = setup("link");
        let link = home.join("link");
        symlink(&real, &link).unwrap();
        let canonical = Path::new(&real).canonicalize().unwrap();
        let canonical = canonical.to_str().unwrap();
        transcript(&home, &project(canonical), ID_A, &[&user(canonical, "via the link")]);
        let link = link.to_str().unwrap();
        let l = run(&home, link, &[link], &Cache::default());
        assert_eq!(titles(&l), ["via the link"]);
        assert_eq!(l.entries[0].cwd, canonical);
    }

    #[test]
    fn a_root_whose_folder_name_claude_cut_is_found() {
        let (home, short) = setup("long");
        let root = format!("{short}/{}", "a".repeat(220));
        std::fs::create_dir_all(&root).unwrap();
        let cut = format!("{}-1x2y3z", &project(&root)[..CLAUDE_NAME_MAX]);
        transcript(&home, &cut, ID_A, &[&user(&root, "long path")]);
        assert_eq!(titles(&run(&home, &root, &[&root], &Cache::default())), ["long path"]);
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
        assert_eq!((titles(&l), l.total), (vec!["in root"], 1));

        let dir_name = format!("{}-sub", project(&root));
        for i in 0..CAP {
            transcript(&home, &dir_name, &id(i), &[&user(&sub, "many")]);
        }
        let l = run(&home, &root, &[&root, &sub], &cache);
        assert_eq!((titles(&l), l.total), (vec!["in root"], 1));
    }

    #[test]
    fn newest_first_and_at_most_cap_with_the_total() {
        let (home, root) = setup("order");
        let p = project(&root);
        for (i, (id, secs)) in [(ID_A, 2_000), (ID_B, 3_000), (ID_C, 1_000)].into_iter().enumerate() {
            let f = transcript(&home, &p, id, &[&user(&root, &format!("t{i}"))]);
            set_mtime(&f, secs);
        }
        let l = run(&home, &root, &[&root], &Cache::default());
        assert_eq!(l.entries.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), [ID_B, ID_A, ID_C]);
        assert_eq!(l.entries[0].last_active, 3_000_000);

        for i in 0..CAP {
            let f = transcript(&home, &p, &id(i), &[&user(&root, "many")]);
            set_mtime(&f, 10_000 + i as u64);
        }
        let l = run(&home, &root, &[&root], &Cache::default());
        assert_eq!((l.entries.len(), l.total), (CAP, CAP + 3));
        assert_eq!(l.entries[0].id, id(CAP - 1));
        assert!(!l.entries.iter().any(|c| c.id == ID_C));
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
    fn an_unreadable_file_is_left_out_and_read_next_time_but_an_unreadable_projects_folder_fails() {
        let (home, root) = setup("unreadable");
        let p = project(&root);
        transcript(&home, &p, ID_E, &[&user(&root, "readable")]);
        let bad = transcript(&home, &p, ID_F, &[&user(&root, "locked")]);
        std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o000)).unwrap();
        let cache = Cache::default();
        let first = list(&home, &root, std::slice::from_ref(&root), &cache);
        std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(titles(&first.unwrap()), ["readable"]);
        let mut both = titles(&run(&home, &root, &[&root], &cache)).into_iter().map(String::from).collect::<Vec<_>>();
        both.sort();
        assert_eq!(both, ["locked", "readable"]);

        let projects = home.join(".claude/projects");
        std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o000)).unwrap();
        let r = list(&home, &root, std::slice::from_ref(&root), &cache);
        std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755)).unwrap();
        let e = r.unwrap_err();
        assert!(e.starts_with("cannot list ") && e.contains(projects.to_str().unwrap()), "{e}");
    }

    #[test]
    fn a_home_without_claude_has_no_conversations() {
        let (home, root) = setup("empty");
        let l = run(&home, &root, &[&root], &Cache::default());
        assert_eq!((l.entries.len(), l.total), (0, 0));
    }

    #[test]
    fn an_ai_title_exactly_tail_max_long_at_the_end_is_found() {
        let (home, root) = setup("exact");
        let filler_line = serde_json::json!({"type": "assistant", "message": {"content": "x".repeat(1000)}}).to_string();
        let mut title = ai_title("Exact fit");
        // Padded so that, with its newline, the line is the last TAIL_MAX bytes.
        let pad = TAIL_MAX as usize - title.len() - 1 - ",\"pad\":\"\"".len();
        title.insert_str(title.len() - 1, &format!(",\"pad\":\"{}\"", " ".repeat(pad)));
        assert_eq!(title.len() + 1, TAIL_MAX as usize);
        let first = user(&root, "the prompt");
        let lines: Vec<&str> = [first.as_str()].into_iter().chain(std::iter::repeat_n(filler_line.as_str(), 100)).chain([title.as_str()]).collect();
        transcript(&home, &project(&root), ID_A, &lines);
        assert_eq!(titles(&run(&home, &root, &[&root], &Cache::default())), ["Exact fit"]);
    }

    #[test]
    fn a_prompt_with_parts_or_leading_space_and_a_blank_ai_title_are_handled() {
        let (home, root) = setup("parts");
        let p = project(&root);
        let parts = serde_json::json!({"type": "user", "cwd": root, "message": {"content": [
            {"type": "image", "source": {}},
            {"type": "text", "text": "  <ide_opened_file>x</ide_opened_file>"},
            {"type": "text", "text": "  describe this image  "},
        ]}})
        .to_string();
        let tool = serde_json::json!({"type": "user", "cwd": root, "message": {"content": [{"type": "tool_result", "content": "ok"}]}}).to_string();
        transcript(&home, &p, ID_A, &[&tool, &parts]);
        transcript(&home, &p, ID_B, &[&user(&root, "  \n <command-name>/clear</command-name>"), &user(&root, "  spaced  ")]);
        transcript(&home, &p, ID_C, &[&user(&root, "from the prompt"), &ai_title("Old"), &ai_title("  ")]);
        let l = run(&home, &root, &[&root], &Cache::default());
        let by_id: HashMap<&str, &str> = l.entries.iter().map(|c| (c.id.as_str(), c.title.as_str())).collect();
        assert_eq!(by_id[ID_A], "describe this image");
        assert_eq!(by_id[ID_B], "spaced");
        assert_eq!(by_id[ID_C], "from the prompt");
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
    fn loosen_makes_each_utf16_unit_that_is_not_alphanumeric_a_dash() {
        assert_eq!(loosen(OsStr::new("/tmp/my_repo.v2")), "-tmp-my-repo-v2");
        assert_eq!(loosen(OsStr::new("/tmp/저장소")), "-tmp----");
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
