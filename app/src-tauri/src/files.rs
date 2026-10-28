//! Files the webview shows in a tab of its own instead of their default app.
//! Only a regular file that open_path.rs would open qualifies. An image,
//! audio or video file is one by its extension, the formats WebKit on macOS
//! shows; a .pdf is one when it starts with the PDF magic; any other file is
//! text when it is at most TEXT_MAX bytes and its first SNIFF bytes hold no NUL
//! and are UTF-8 up to the cut, and markdown among text by its extension.
//! Anything else keeps its default app.
//!
//! The asset protocol serves a file it cannot identify as text/html, so HTML
//! named .png is served as HTML. Media is safe as <img>, <audio> and <video>
//! never render HTML. The PDF magic cannot make a frame safe, since the file
//! can be swapped after view_path: the empty sandbox on the PDF frame does,
//! and no asset URL but a PDF's is ever framed or navigated to.

use std::fs::{File, Metadata, OpenOptions};
use std::io::{self, Read};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::open_path::{self, Action};

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Text,
    Markdown,
    Image,
    Pdf,
    Audio,
    Video,
}

const IMAGES: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic", "heif", "tif", "tiff"];
const AUDIO: &[&str] = &["mp3", "m4a", "aac", "wav", "aif", "aiff", "flac"];
const VIDEO: &[&str] = &["mp4", "m4v", "mov", "webm"];
const MARKDOWN: &[&str] = &["md", "markdown"];

pub const TEXT_MAX: u64 = 2 * 1024 * 1024;
const SNIFF: u64 = 8 * 1024;
const PDF_MAGIC: &[u8] = b"%PDF-";

/// At most n bytes from the start of f.
fn head(f: &File, n: u64) -> io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    f.take(n).read_to_end(&mut buf)?;
    Ok(buf)
}

/// What the webview shows canonical as, by the rule above; None for its
/// default app.
pub fn kind_of(canonical: &Path, meta: &Metadata) -> io::Result<Option<Kind>> {
    if !meta.is_file() {
        return Ok(None);
    }
    let ext = canonical.extension().and_then(|e| e.to_str()).unwrap_or_default().to_lowercase();
    let ext = ext.as_str();
    for (list, kind) in [(IMAGES, Kind::Image), (AUDIO, Kind::Audio), (VIDEO, Kind::Video)] {
        if list.contains(&ext) {
            return Ok(Some(kind));
        }
    }
    // What is read is judged by the handle's own metadata, so a file swapped
    // in after meta cannot slip by; nonblocking, so a FIFO cannot hang the open.
    let f = OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(canonical)?;
    let opened = f.metadata()?;
    if !opened.is_file() {
        return Ok(None);
    }
    let len = opened.len();
    if ext == "pdf" {
        return Ok(head(&f, PDF_MAGIC.len() as u64)?.starts_with(PDF_MAGIC).then_some(Kind::Pdf));
    }
    if len > TEXT_MAX {
        return Ok(None);
    }
    let sniff = head(&f, SNIFF)?;
    let utf8 = match std::str::from_utf8(&sniff) {
        Ok(_) => true,
        // A character the cut split in two; at the file's own end it is broken.
        Err(e) => e.error_len().is_none() && (sniff.len() as u64) < len,
    };
    if sniff.contains(&0) || !utf8 {
        return Ok(None);
    }
    Ok(Some(if MARKDOWN.contains(&ext) { Kind::Markdown } else { Kind::Text }))
}

#[derive(Serialize)]
pub struct Viewable {
    path: PathBuf,
    kind: Kind,
}

// The static assetProtocol scope is empty: this is the one place a file is
// allowed, one at a time and only just after it was judged, so the scope never
// holds a folder, a glob or anything the gate in open_path.rs would reveal. A
// tab asks this on every show, which judges a restored tab afresh.
#[tauri::command]
pub async fn view_path(app: AppHandle, path: String) -> Result<Viewable, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
        let (_, action) = open_path::resolve(&path, "", Path::new(&home), &open_path::handler_id)?;
        let (path, kind) = match action {
            Action::Revealed { why } => return Err(why),
            Action::Opened => return Err("it opens in its default app".to_string()),
            Action::View { path, kind } => (path, kind),
        };
        // Text comes through read_text; the rest is loaded by URL.
        if !matches!(kind, Kind::Text | Kind::Markdown) {
            app.asset_protocol_scope().allow_file(&path).map_err(|e| e.to_string())?;
        }
        Ok(Viewable { path, kind })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open_path::tests::{dir, file};

    fn kind(name: &str, ext: &str, bytes: &[u8]) -> Option<Kind> {
        let p = file(&dir(&format!("kind-{name}")), &format!("f{ext}"), 0o644);
        std::fs::write(&p, bytes).unwrap();
        kind_of(&p, &std::fs::metadata(&p).unwrap()).unwrap()
    }

    const OVER: usize = TEXT_MAX as usize + 1;

    #[test]
    fn markdown_is_text_named_md_under_the_cap() {
        assert_eq!(kind("md", ".md", b"# Title\n"), Some(Kind::Markdown));
        assert_eq!(kind("mdcase", ".Markdown", b"# Title\n"), Some(Kind::Markdown));
        assert_eq!(kind("mdbig", ".md", &vec![b'a'; OVER]), None);
    }

    #[test]
    fn media_is_known_by_its_extension() {
        assert_eq!(kind("png", ".png", b"\x89PNG\0"), Some(Kind::Image));
        assert_eq!(kind("mp3", ".mp3", b"\0"), Some(Kind::Audio));
        assert_eq!(kind("mov", ".mov", b"\0"), Some(Kind::Video));
    }

    #[test]
    fn a_pdf_needs_the_magic() {
        assert_eq!(kind("pdf", ".pdf", b"%PDF-1.7\n"), Some(Kind::Pdf));
        assert_eq!(kind("fakepdf", ".pdf", b"<html><script></script></html>"), None);
    }

    #[test]
    fn text_is_utf8_without_nul_under_the_cap() {
        assert_eq!(kind("plain", "", "all: build\n# é\n".as_bytes()), Some(Kind::Text));
        assert_eq!(kind("nul", ".txt", b"a\0b"), None);
        assert_eq!(kind("big", ".txt", &vec![b'a'; OVER]), None);
        assert_eq!(kind("latin1", ".txt", b"caf\xe9 au lait"), None);
    }

    #[test]
    fn a_character_split_by_the_sniff_is_still_text() {
        let mut cut = vec![b'a'; SNIFF as usize - 1];
        cut.extend("é".as_bytes());
        assert_eq!(kind("cut", ".txt", &cut), Some(Kind::Text));
        // The same broken tail at the file's own end is not.
        assert_eq!(kind("tail", ".txt", b"ab\xc3"), None);
    }

    #[test]
    fn a_three_byte_character_cut_after_its_first_byte_is_still_text() {
        let mut cut = vec![b'a'; SNIFF as usize - 1];
        cut.extend("한".as_bytes());
        assert_eq!(kind("cut3", ".txt", &cut), Some(Kind::Text));
    }

    #[test]
    fn a_folder_is_not_shown() {
        let d = dir("kind-folder");
        assert_eq!(kind_of(&d, &std::fs::metadata(&d).unwrap()).unwrap(), None);
    }
}
