//! Codex keeps each conversation as
//! `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`, whose first
//! line is a `session_meta` naming the uuid and the `cwd` that decides where
//! the conversation was. Only the first HEAD_MAX bytes are read, the bound
//! the daemon reads that line with; a first line longer than that is passed
//! over. The rest of the head gives the fallback title: the first message the
//! user typed, a tagged one (Codex's environment context) not counting.
//!
//! The title proper is the thread's name in `~/.codex/session_index.jsonl`,
//! which Codex appends a line to whenever a thread is named. It names threads
//! whose rollouts are gone and misses rollouts that are on disk, so the
//! rollouts decide what is listed and the index only names them. Current
//! Codex writes some 60 KiB or more (instructions, tools) before the first
//! typed message, so the fallback mostly finds nothing and the index carries
//! the names. The time is the rollout's mtime. A `codex exec` rollout is a
//! scripted run, not listed.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{HEAD_MAX, Meta, UNTITLED, clean_title, entries, entries_below, lines, open_regular, shown, valid_id};
use crate::files;

const SESSIONS: &str = ".codex/sessions";
const INDEX: &str = ".codex/session_index.jsonl";
/// A longer index line is passed over unread, not held whole.
const INDEX_LINE_MAX: usize = 64 * 1024;

/// The uuid in a rollout's file name, `rollout-<time>-<uuid>.jsonl`.
fn rollout_id(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    let id = rest.get(rest.len().checked_sub(36)?..)?;
    valid_id(id).then_some(id)
}

/// Each thread's latest name in the index, by id. The index is optional: one
/// that cannot be read is reported, and the rollouts' own first messages
/// title the rows.
pub(super) fn index_titles(home: &Path) -> HashMap<String, String> {
    let path = home.join(INDEX);
    match read_index(&path) {
        Ok(names) => names,
        Err(e) if e.kind() == io::ErrorKind::NotFound => HashMap::new(),
        Err(e) => {
            eprintln!("vaquita: reading {}: {e}", path.display());
            HashMap::new()
        }
    }
}

fn read_index(path: &Path) -> io::Result<HashMap<String, String>> {
    let (f, _) = open_regular(path)?;
    // The whole index is read, as busy repos' lines would push a small
    // repo's names out of a tail. An id's last line is its latest name, as
    // each naming is appended.
    let mut reader = BufReader::new(f);
    let mut latest = HashMap::new();
    let mut line = Vec::new();
    while next_line(&mut reader, &mut line)? {
        let Ok(v) = serde_json::from_slice::<Value>(&line) else { continue };
        let field = |k: &str| v.get(k).and_then(Value::as_str);
        if let (Some(id), Some(name)) = (field("id"), field("thread_name"))
            && valid_id(id)
        {
            latest.insert(id.to_string(), name.to_string());
        }
    }
    Ok(latest)
}

/// The next complete line of r into line, false at the end. A line over
/// INDEX_LINE_MAX is read through and skipped (line left empty), and a last
/// line without its `\n` is still being written, so it is not one.
fn next_line(r: &mut impl BufRead, line: &mut Vec<u8>) -> io::Result<bool> {
    line.clear();
    let mut too_long = false;
    loop {
        let buf = r.fill_buf()?;
        if buf.is_empty() {
            line.clear();
            return Ok(false);
        }
        let (take, done) = match buf.iter().position(|&b| b == b'\n') {
            Some(i) => (i + 1, true),
            None => (buf.len(), false),
        };
        if !too_long {
            if line.len() + take > INDEX_LINE_MAX {
                too_long = true;
                line.clear();
            } else {
                line.extend_from_slice(&buf[..take]);
            }
        }
        r.consume(take);
        if done {
            if too_long {
                line.clear();
            }
            return Ok(true);
        }
    }
}

/// The first text of a user message line that is not a tag.
fn typed(v: &Value) -> Option<&str> {
    let is = |at: &str, want: &str| v.pointer(at).and_then(Value::as_str) == Some(want);
    if !(is("/type", "response_item") && is("/payload/type", "message") && is("/payload/role", "user")) {
        return None;
    }
    v.pointer("/payload/content")?.as_array()?.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).find(|s| shown(s))
}

/// The rollout at path; None when its name is not a rollout's or its first
/// line is not the session_meta of the name's id with a cwd. The index's
/// title is applied by the caller, after the cache, as the index changes
/// while a rollout does not.
pub(super) fn meta(path: &Path) -> io::Result<Option<Meta>> {
    let Some(id) = rollout_id(path.file_name().and_then(OsStr::to_str).unwrap_or_default()) else { return Ok(None) };
    let (f, _) = open_regular(path)?;
    let head = files::head(&f, HEAD_MAX)?;
    // lines leaves out a first line the bound cut.
    let mut rest = lines(&head);
    let Some(first) = rest.next().and_then(|l| serde_json::from_slice::<Value>(l).ok()) else { return Ok(None) };
    if first.get("type").and_then(Value::as_str) != Some("session_meta") || first.pointer("/payload/id").and_then(Value::as_str) != Some(id) {
        return Ok(None);
    }
    // Scripted `codex exec` runs far outnumber interactive ones and would
    // bury them; they are resumable, but nobody opened them.
    if first.pointer("/payload/source").and_then(Value::as_str) == Some("exec") {
        return Ok(None);
    }
    let Some(cwd) = first.pointer("/payload/cwd").and_then(Value::as_str).map(PathBuf::from) else { return Ok(None) };
    let prompt = rest.filter_map(|l| serde_json::from_slice::<Value>(l).ok()).find_map(|v| typed(&v).and_then(clean_title));
    Ok(Some(Meta { agent: "codex", id: id.to_string(), cwd, title: prompt.unwrap_or_else(|| UNTITLED.to_string()) }))
}

fn folders(dir: &Path) -> Vec<PathBuf> {
    entries_below(dir).into_iter().filter_map(|(p, is_dir)| is_dir.then_some(p)).collect()
}

/// The rollouts in the sessions folder's year, month and day folders. Only
/// listing the sessions folder itself fails.
pub(super) fn rollouts(home: &Path) -> Result<Vec<PathBuf>, String> {
    let sessions = home.join(SESSIONS);
    let years = entries(&sessions).map_err(|e| format!("cannot list {}: {e}", sessions.display()))?;
    let mut out = Vec::new();
    for (year, _) in years.into_iter().filter(|(_, is_dir)| *is_dir) {
        for day in folders(&year).iter().flat_map(|month| folders(month)) {
            for (path, is_dir) in entries_below(&day) {
                if !is_dir && path.file_name().and_then(OsStr::to_str).and_then(rollout_id).is_some() {
                    out.push(path);
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
pub(super) mod tests {
    use super::super::tests::*;
    use super::*;
    use crate::conversations::{Cache, list};
    use std::fs::File;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    fn write_lines(path: &Path, lines: &[&str]) -> PathBuf {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = File::create(path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        path.to_path_buf()
    }

    fn rollout_path(home: &Path, date: &str, time: &str, id: &str) -> PathBuf {
        home.join(SESSIONS).join(date).join(format!("rollout-{time}-{id}.jsonl"))
    }

    fn session_meta(id: &str, cwd: &str) -> String {
        serde_json::json!({"timestamp": "2026-10-24T10:00:00.000Z", "type": "session_meta", "payload": {"id": id, "cwd": cwd, "base_instructions": {"text": "x"}}}).to_string()
    }

    pub(in crate::conversations) fn rollout(home: &Path, date: &str, time: &str, id: &str, cwd: &str, extra: &[&str]) -> PathBuf {
        let first = session_meta(id, cwd);
        let lines: Vec<&str> = [first.as_str()].into_iter().chain(extra.iter().copied()).collect();
        write_lines(&rollout_path(home, date, time, id), &lines)
    }

    pub(in crate::conversations) fn message(role: &str, text: &str) -> String {
        serde_json::json!({"type": "response_item", "payload": {"type": "message", "role": role, "content": [{"type": "input_text", "text": text}]}}).to_string()
    }

    fn index(home: &Path, names: &[(&str, &str, &str)]) -> PathBuf {
        let lines: Vec<String> = names.iter().map(|(id, name, at)| serde_json::json!({"id": id, "thread_name": name, "updated_at": at}).to_string()).collect();
        write_lines(&home.join(INDEX), &lines.iter().map(String::as_str).collect::<Vec<_>>())
    }

    #[test]
    fn a_rollout_in_the_root_takes_its_last_name_in_the_index() {
        let (home, root) = setup("codex-named");
        rollout(&home, "2026/10/24", "2026-10-24T10-00-00", ID_A, &root, &[&message("user", "fix the tests please")]);
        index(&home, &[(ID_A, "Fix tests", "2026-10-24T10:00:00.000000Z"), (ID_A, "Fix the tests", "2026-10-24T11:00:00.000000Z")]);
        let l = run(&home, &root, &[&root], &Cache::default());
        assert_eq!(l.entries.len(), 1);
        let c = &l.entries[0];
        assert_eq!((c.agent, c.id.as_str(), c.title.as_str(), c.cwd.as_str()), ("codex", ID_A, "Fix the tests", root.as_str()));
    }

    #[test]
    fn without_an_index_line_the_first_typed_user_message_is_the_title() {
        let (home, root) = setup("codex-fallback");
        let developer = message("developer", "You are a coding agent");
        let context = message("user", "  <environment_context>\n  <cwd>/tmp/repo</cwd>\n</environment_context>");
        let event = serde_json::json!({"type": "event_msg", "payload": {"type": "task_started"}}).to_string();
        rollout(&home, "2026/10/24", "2026-10-24T10-00-00", ID_A, &root, &[&event, &developer, &context, &message("user", "rename util"), &message("user", "later")]);
        rollout(&home, "2026/10/24", "2026-10-24T10-05-00", ID_B, &root, &[&developer]);
        let l = run(&home, &root, &[&root], &Cache::default());
        let titles = by_id(&l);
        assert_eq!((titles[ID_A], titles[ID_B]), ("rename util", "Untitled"));
    }

    #[test]
    fn a_rollout_elsewhere_or_in_a_nested_repo_is_not_the_roots() {
        let (home, root) = setup("codex-owner");
        let sub = format!("{root}/sub");
        let elsewhere = home.join("elsewhere");
        std::fs::create_dir_all(format!("{sub}/x")).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        rollout(&home, "2026/10/24", "2026-10-24T10-00-00", ID_A, &root, &[&message("user", "in root")]);
        rollout(&home, "2026/10/24", "2026-10-24T10-01-00", ID_B, elsewhere.to_str().unwrap(), &[&message("user", "elsewhere")]);
        rollout(&home, "2026/10/25", "2026-10-25T10-00-00", ID_C, &format!("{sub}/x"), &[&message("user", "in sub")]);
        let cache = Cache::default();
        let l = run(&home, &root, &[&root, &sub], &cache);
        assert_eq!(titles(&l), ["in root"]);
        assert_eq!(titles(&run(&home, &sub, &[&root, &sub], &cache)), ["in sub"]);
    }

    #[test]
    fn a_rollout_that_does_not_start_with_its_own_session_meta_is_skipped() {
        let (home, root) = setup("codex-meta");
        let event = serde_json::json!({"type": "event_msg", "payload": {"type": "task_started"}}).to_string();
        write_lines(&rollout_path(&home, "2026/10/24", "2026-10-24T10-00-00", ID_A), &[&event, &session_meta(ID_A, &root)]);
        write_lines(&rollout_path(&home, "2026/10/24", "2026-10-24T10-01-00", ID_B), &[&session_meta(ID_C, &root)]);
        let no_cwd = serde_json::json!({"type": "session_meta", "payload": {"id": ID_D}}).to_string();
        write_lines(&rollout_path(&home, "2026/10/24", "2026-10-24T10-02-00", ID_D), &[&no_cwd]);
        // A first line past the head is cut, and so not read.
        let mut long = session_meta(ID_E, &root);
        long.insert_str(long.len() - 1, &format!(",\"pad\":\"{}\"", "x".repeat(HEAD_MAX as usize)));
        write_lines(&rollout_path(&home, "2026/10/24", "2026-10-24T10-03-00", ID_E), &[&long]);
        rollout(&home, "2026/10/24", "2026-10-24T10-04-00", ID_F, &root, &[]);
        let l = run(&home, &root, &[&root], &Cache::default());
        assert_eq!(l.entries.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), [ID_F]);
    }

    #[test]
    fn a_codex_exec_rollout_is_not_listed() {
        let (home, root) = setup("codex-exec");
        let with = |id: &str, source: &str| serde_json::json!({"type": "session_meta", "payload": {"id": id, "cwd": root, "originator": "x", "source": source}}).to_string();
        write_lines(&rollout_path(&home, "2026/10/24", "2026-10-24T10-00-00", ID_A), &[&with(ID_A, "exec")]);
        write_lines(&rollout_path(&home, "2026/10/24", "2026-10-24T10-01-00", ID_B), &[&with(ID_B, "cli")]);
        rollout(&home, "2026/10/24", "2026-10-24T10-02-00", ID_C, &root, &[]);
        let mut ids = run(&home, &root, &[&root], &Cache::default()).entries.into_iter().map(|c| c.id).collect::<Vec<_>>();
        ids.sort();
        assert_eq!(ids, [ID_B, ID_C]);
    }

    #[test]
    fn only_rollout_files_three_folders_down_are_read() {
        let (home, root) = setup("codex-names");
        let line = session_meta(ID_A, &root);
        let day = home.join(SESSIONS).join("2026/10/24");
        write_lines(&day.join(format!("rollout-2026-10-24T10-00-00-{ID_A}.jsonl")), &[&line]);
        write_lines(&day.join(format!("rollout-2026-10-24T10-00-00-{ID_A}.json")), &[&line]);
        write_lines(&day.join(format!("session-2026-10-24T10-00-00-{ID_A}.jsonl")), &[&line]);
        write_lines(&day.join("rollout-2026-10-24T10-00-00-저장소.jsonl"), &[&line]);
        write_lines(&home.join(SESSIONS).join(format!("2026/10/rollout-2026-10-24T10-00-00-{ID_A}.jsonl")), &[&line]);
        std::fs::write(home.join(SESSIONS).join("2026/notes"), "").unwrap();
        let rollouts = rollouts(&home).unwrap();
        assert_eq!(rollouts, [day.join(format!("rollout-2026-10-24T10-00-00-{ID_A}.jsonl"))]);
        assert_eq!(run(&home, &root, &[&root], &Cache::default()).entries.len(), 1);
    }

    #[test]
    fn an_index_that_is_missing_or_unreadable_leaves_the_fallback_titles() {
        let (home, root) = setup("codex-index");
        rollout(&home, "2026/10/24", "2026-10-24T10-00-00", ID_A, &root, &[&message("user", "first")]);
        rollout(&home, "2026/10/24", "2026-10-24T10-01-00", ID_B, &root, &[&message("user", "second")]);
        let cache = Cache::default();
        assert_eq!(sorted_titles(&run(&home, &root, &[&root], &cache)), ["first", "second"]);

        let path = index(&home, &[(ID_A, "Named", "2026-10-24T11:00:00.000000Z")]);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let locked = list(&home, &root, std::slice::from_ref(&root), &cache);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let locked = locked.unwrap();
        assert_eq!((by_id(&locked)[ID_A], by_id(&locked)[ID_B], locked.entries.len()), ("first", "second", 2));
        assert_eq!(by_id(&run(&home, &root, &[&root], &cache))[ID_A], "Named");
    }

    #[test]
    fn index_lines_with_a_bad_id_or_shape_are_ignored_and_an_early_name_in_a_large_index_is_found() {
        let (home, _) = setup("codex-index-lines");
        let filler = serde_json::json!({"id": ID_C, "thread_name": "x".repeat(1000), "updated_at": "2026-10-24T09:00:00.000000Z"}).to_string();
        let early = serde_json::json!({"id": ID_D, "thread_name": "Too early", "updated_at": "2026-10-24T09:00:00.000000Z"}).to_string();
        let bad_id = serde_json::json!({"id": "not-an-id", "thread_name": "Bad", "updated_at": "2026-10-24T10:00:00.000000Z"}).to_string();
        let no_name = serde_json::json!({"id": ID_B, "thread_name": 7, "updated_at": "2026-10-24T10:00:00.000000Z"}).to_string();
        let good = serde_json::json!({"id": ID_A, "thread_name": "Good", "updated_at": "2026-10-24T10:00:00.000000Z"}).to_string();
        let lines: Vec<&str> = [early.as_str()].into_iter().chain(std::iter::repeat_n(filler.as_str(), 1100)).chain([bad_id.as_str(), "{not json", no_name.as_str(), good.as_str()]).collect();
        let path = write_lines(&home.join(INDEX), &lines);
        assert!(std::fs::metadata(&path).unwrap().len() > 1024 * 1024);
        let names = index_titles(&home);
        assert_eq!(names.get(ID_A).map(String::as_str), Some("Good"));
        assert_eq!(names.get(ID_D).map(String::as_str), Some("Too early"));
        assert!(!names.contains_key(ID_B) && !names.contains_key("not-an-id"));
    }

    #[test]
    fn an_overlong_index_line_is_skipped_without_losing_the_next() {
        let long = serde_json::json!({"id": ID_C, "thread_name": "x".repeat(INDEX_LINE_MAX)}).to_string();
        let ok = serde_json::json!({"id": ID_A, "thread_name": "Kept"}).to_string();
        let data = format!("{long}\n{ok}\n{ok}");
        let mut r = io::BufReader::with_capacity(16, data.as_bytes());
        let mut line = Vec::new();
        assert!(next_line(&mut r, &mut line).unwrap() && line.is_empty());
        assert!(next_line(&mut r, &mut line).unwrap());
        assert_eq!(line, format!("{ok}\n").as_bytes());
        assert!(!next_line(&mut r, &mut line).unwrap());
    }

    #[test]
    fn a_renamed_thread_shows_its_new_name_with_the_rollout_unchanged() {
        let (home, root) = setup("codex-rename");
        rollout(&home, "2026/10/24", "2026-10-24T10-00-00", ID_A, &root, &[&message("user", "hello")]);
        index(&home, &[(ID_A, "First name", "2026-10-24T10:00:00.000000Z")]);
        let cache = Cache::default();
        assert_eq!(titles(&run(&home, &root, &[&root], &cache)), ["First name"]);
        index(&home, &[(ID_A, "First name", "2026-10-24T10:00:00.000000Z"), (ID_A, "  Second name\nmore", "2026-10-24T12:00:00.000000Z")]);
        assert_eq!(titles(&run(&home, &root, &[&root], &cache)), ["Second name"]);
        index(&home, &[(ID_A, "  ", "2026-10-24T13:00:00.000000Z")]);
        assert_eq!(titles(&run(&home, &root, &[&root], &cache)), ["hello"]);
    }

    #[test]
    fn an_unreadable_rollout_of_another_repo_leaves_the_roots_list_whole_and_is_read_next_time() {
        let (home, root) = setup("codex-locked");
        let other = format!("{root}/other");
        std::fs::create_dir_all(&other).unwrap();
        transcript(&home, &project(&root), ID_A, &[&user(&root, "claude row")]);
        rollout(&home, "2026/10/24", "2026-10-24T10-00-00", ID_B, &root, &[&message("user", "codex row")]);
        let bad = rollout(&home, "2026/10/24", "2026-10-24T10-01-00", ID_C, &other, &[&message("user", "locked")]);
        std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o000)).unwrap();
        let cache = Cache::default();
        let first = list(&home, &root, &[root.clone(), other.clone()], &cache);
        std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(sorted_titles(&first.unwrap()), ["claude row", "codex row"]);
        // With the other repo unregistered, its rollout is the root's.
        let l = run(&home, &root, &[&root], &cache);
        assert_eq!((by_id(&l)[ID_C], l.entries.len()), ("locked", 3));
    }

    #[test]
    fn an_unreadable_sessions_folder_fails_the_list() {
        let (home, root) = setup("codex-sessions");
        rollout(&home, "2026/10/24", "2026-10-24T10-00-00", ID_A, &root, &[]);
        let sessions = home.join(SESSIONS);
        std::fs::set_permissions(&sessions, std::fs::Permissions::from_mode(0o000)).unwrap();
        let r = list(&home, &root, std::slice::from_ref(&root), &Cache::default());
        std::fs::set_permissions(&sessions, std::fs::Permissions::from_mode(0o755)).unwrap();
        let e = r.unwrap_err();
        assert!(e.starts_with("cannot list ") && e.contains(sessions.to_str().unwrap()), "{e}");
    }

    #[test]
    fn a_rollout_name_carries_its_id_before_the_extension() {
        assert_eq!(rollout_id(&format!("rollout-2026-10-24T10-00-00-{ID_A}.jsonl")), Some(ID_A));
        assert_eq!(rollout_id(&format!("rollout-2026-10-24T10-00-00-{ID_A}.json")), None);
        assert_eq!(rollout_id(&format!("other-{ID_A}.jsonl")), None);
        assert_eq!(rollout_id("rollout-short.jsonl"), None);
        assert_eq!(rollout_id(&format!("rollout-a{}.jsonl", "가".repeat(12))), None);
    }
}
