//! Claude Code keeps each conversation as `~/.claude/projects/<dir>/<uuid>.jsonl`,
//! where `<dir>` is the cwd with every character that is not ASCII
//! alphanumeric made `-`. That name is lossy (`/tmp/a-b` and `/tmp/a/b` share
//! it), so it only narrows which folders are opened; the `cwd` written inside
//! the transcript decides where the conversation was. A folder is opened when
//! its name is the root's, or the root's followed by `-` (a subfolder's, or a
//! sibling's that the `cwd` then rules out), for the root as registered and as
//! canonical, since Claude records `/tmp/repo` as `/private/tmp/repo`.
//!
//! A transcript can be many megabytes, so only its first HEAD_MAX bytes and
//! last TAIL_MAX bytes are read: the head for the first `cwd` (every
//! transcript has one there) and the first typed prompt, the fallback title;
//! the tail for the last `ai-title` line, which Claude appends anew as the
//! title changes. A title last set further from the end than TAIL_MAX is
//! missed and the prompt shown instead. The time is the file's mtime, as a
//! transcript is appended to on every turn and holds no single last time.
//! A transcript whose `entrypoint` is the SDK's is a scripted run, not listed.

use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{HEAD_MAX, Meta, UNTITLED, clean_title, entries, entries_below, json_lines, open_regular, read_tail, shown, valid_id};
use crate::files;

const TAIL_MAX: u64 = 64 * 1024;
/// The longest project folder name Claude writes uncut.
const CLAUDE_NAME_MAX: usize = 200;

/// A path as Claude names its project folder. Claude replaces UTF-16 code
/// units, so a non-ASCII character becomes one `-` per unit, not per byte.
pub(super) fn loosen(name: &OsStr) -> String {
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

/// What the user typed in a user line: its content as a string, or the first
/// text part when it has parts (an image is another part, a tool result has
/// none). A slash command or an attachment is written as a tag, not as typed.
fn typed(v: &Value) -> Option<&str> {
    match v.pointer("/message/content")? {
        Value::String(s) => Some(s.as_str()).filter(|s| shown(s)),
        Value::Array(parts) => parts
            .iter()
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .find(|s| shown(s)),
        _ => None,
    }
}

/// The transcript at path, its stem already a valid id; None when its head
/// has no cwd, as sidechain and tool files have none.
pub(super) fn meta(path: &Path) -> io::Result<Option<Meta>> {
    let (f, opened) = open_regular(path)?;
    let head = files::head(&f, HEAD_MAX)?;
    let mut cwd = None;
    let mut prompt = None;
    let mut entrypoint = None;
    for v in json_lines(&head) {
        if cwd.is_none() {
            cwd = v.get("cwd").and_then(Value::as_str).map(PathBuf::from);
        }
        if prompt.is_none() && v.get("type").and_then(Value::as_str) == Some("user") {
            prompt = typed(&v).and_then(clean_title);
        }
        if entrypoint.is_none() {
            entrypoint = v.get("entrypoint").and_then(Value::as_str).map(str::to_string);
        }
        if cwd.is_some() && prompt.is_some() && entrypoint.is_some() {
            break;
        }
    }
    let Some(cwd) = cwd else { return Ok(None) };
    // A run through the SDK (`claude -p`, sdk-cli, sdk-ts, ...) is scripted:
    // resumable, but nobody opened it, and such runs would bury the ones a
    // person had.
    if entrypoint.is_some_and(|e| e.starts_with("sdk")) {
        return Ok(None);
    }
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
/// Only listing the projects folder itself fails.
pub(super) fn candidates(home: &Path, root_given: &Path, root_canonical: &Path) -> Result<Vec<PathBuf>, String> {
    let projects = home.join(".claude/projects");
    let dirs = entries(&projects).map_err(|e| format!("cannot list {}: {e}", projects.display()))?;
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
    for (dir, is_dir) in dirs {
        let name = loosen(dir.file_name().unwrap_or_default());
        if !is_dir || !keys.iter().any(|k| name.strip_prefix(k.as_str()).is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))) {
            continue;
        }
        for (path, _) in entries_below(&dir) {
            let stem = path.file_stem().and_then(OsStr::to_str).unwrap_or_default();
            if path.extension() == Some(OsStr::new("jsonl")) && valid_id(stem) {
                out.push(path);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::super::tests::*;
    use super::*;
    use crate::conversations::{Cache, list};
    use std::os::unix::fs::{PermissionsExt, symlink};

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
        assert_eq!(sorted_titles(&run(&home, &root, &[&root], &Cache::default())), ["Untitled", "after the clear", "plain prompt"]);
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
        let got = by_id(&l);
        assert_eq!(got[ID_A], "Late title");
        assert_eq!(got[ID_B], "the prompt");
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
        assert_eq!(sorted_titles(&run(&home, &root, &[&root], &cache)), ["locked", "readable"]);

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
        let got = by_id(&l);
        assert_eq!(got[ID_A], "describe this image");
        assert_eq!(got[ID_B], "spaced");
        assert_eq!(got[ID_C], "from the prompt");
    }

    #[test]
    fn a_transcript_started_through_the_sdk_is_not_listed() {
        let (home, root) = setup("entrypoint");
        let p = project(&root);
        let with = |entrypoint: &str, text: &str| serde_json::json!({"type": "user", "cwd": root, "entrypoint": entrypoint, "message": {"content": text}}).to_string();
        transcript(&home, &p, ID_A, &[&with("cli", "by hand")]);
        transcript(&home, &p, ID_B, &[&with("sdk-cli", "scripted")]);
        transcript(&home, &p, ID_C, &[&serde_json::json!({"type": "system", "cwd": root}).to_string(), &with("sdk-ts", "scripted later")]);
        transcript(&home, &p, ID_D, &[&user(&root, "no entrypoint")]);
        assert_eq!(sorted_titles(&run(&home, &root, &[&root], &Cache::default())), ["by hand", "no entrypoint"]);
    }

    #[test]
    fn loosen_makes_each_utf16_unit_that_is_not_alphanumeric_a_dash() {
        assert_eq!(loosen(OsStr::new("/tmp/my_repo.v2")), "-tmp-my-repo-v2");
        assert_eq!(loosen(OsStr::new("/tmp/저장소")), "-tmp----");
    }
}
