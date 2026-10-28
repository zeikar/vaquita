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
//! never render HTML. A PDF is framed, and WebKit runs its PDF viewer in no
//! sandboxed frame, so PDFs do not go through the asset protocol: the vqpdf
//! scheme serves only a path view_path judged a PDF this run, re-checks the
//! PDF magic on every request, and answers with the type forced to
//! application/pdf and nosniff, so the frame can only ever show a PDF. No asset
//! URL is ever framed or navigated to. The file is read whole, up to PDF_MAX.

use std::collections::HashSet;
use std::ffi::{CString, OsString};
use std::fs::{File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::http::{Response, StatusCode};
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
/// A larger PDF keeps its default app: vqpdf reads the file whole.
pub const PDF_MAX: u64 = 100 * 1024 * 1024;

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
        if len > PDF_MAX {
            return Ok(None);
        }
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
        // Text comes through read_text; a PDF is served by vqpdf, the rest by
        // the asset protocol.
        match kind {
            Kind::Text | Kind::Markdown => {}
            Kind::Pdf => {
                app.state::<PdfAllowed>().0.lock().map_err(|e| e.to_string())?.insert(path.clone());
            }
            _ => app.asset_protocol_scope().allow_file(&path).map_err(|e| e.to_string())?,
        }
        Ok(Viewable { path, kind })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The PDFs view_path judged this run: the only files vqpdf serves.
#[derive(Default)]
pub struct PdfAllowed(Mutex<HashSet<PathBuf>>);

pub const PDF_SCHEME: &str = "vqpdf";

fn refuse(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(status).body(Vec::new()).expect("a status and an empty body make a response")
}

/// The answer to a vqpdf request whose URL path is uri_path: the path of the
/// file, percent-encoded, after a slash. Anything not allowed is a 404 with no
/// body; an allowed file that no longer starts with the PDF magic is refused.
fn pdf_response(allowed: &PdfAllowed, uri_path: &str) -> Response<Vec<u8>> {
    let Ok(decoded) = percent_encoding::percent_decode_str(uri_path.trim_start_matches('/')).decode_utf8() else {
        return refuse(StatusCode::NOT_FOUND);
    };
    let path = PathBuf::from(decoded.as_ref());
    if !allowed.0.lock().is_ok_and(|set| set.contains(&path)) {
        return refuse(StatusCode::NOT_FOUND);
    }
    let read = || -> io::Result<Result<Vec<u8>, StatusCode>> {
        // Nonblocking, so a FIFO swapped in cannot hang the open.
        let f = OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(&path)?;
        if !f.metadata()?.is_file() {
            return Ok(Err(StatusCode::UNSUPPORTED_MEDIA_TYPE));
        }
        // The header first, so a large non-PDF is never read. It stays in
        // bytes: the handle has moved past it.
        let mut bytes = head(&f, PDF_MAGIC.len() as u64)?;
        if !bytes.starts_with(PDF_MAGIC) {
            return Ok(Err(StatusCode::UNSUPPORTED_MEDIA_TYPE));
        }
        // Bounded, as the file can grow while it is read.
        (&f).take(PDF_MAX + 1 - bytes.len() as u64).read_to_end(&mut bytes)?;
        Ok(if bytes.len() as u64 > PDF_MAX { Err(StatusCode::PAYLOAD_TOO_LARGE) } else { Ok(bytes) })
    };
    match read() {
        Ok(Ok(bytes)) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "application/pdf")
            .header("X-Content-Type-Options", "nosniff")
            .body(bytes)
            .expect("fixed headers make a response"),
        Ok(Err(status)) => refuse(status),
        Err(e) if e.kind() == io::ErrorKind::NotFound => refuse(StatusCode::NOT_FOUND),
        Err(e) => {
            eprintln!("vaquita: serve {}: {e}", path.display());
            refuse(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

/// Registers vqpdf; the file is read on a blocking thread.
pub fn register_pdf_scheme<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.manage(PdfAllowed::default()).register_asynchronous_uri_scheme_protocol(PDF_SCHEME, |ctx, request, responder| {
        let app = ctx.app_handle().clone();
        let uri_path = request.uri().path().to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let response = pdf_response(&app.state::<PdfAllowed>(), &uri_path);
            responder.respond(response.map(std::borrow::Cow::Owned));
        });
    })
}

/// A file's modification time and length, which a save compares to tell
/// whether the file is still the one the text was read from.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Stamp {
    secs: u64,
    nanos: u32,
    len: u64,
}

impl Stamp {
    fn of(meta: &Metadata) -> io::Result<Stamp> {
        let modified = meta.modified()?.duration_since(UNIX_EPOCH).map_err(|_| io::Error::other("modified before 1970"))?;
        Ok(Stamp { secs: modified.as_secs(), nanos: modified.subsec_nanos(), len: meta.len() })
    }
}

pub const CHANGED_ON_DISK: &str = "changed on disk";
const NOT_REGULAR: &str = "not a regular file";
const READ_ONLY: &str = "read-only";
const TOO_LARGE: &str = "larger than 2 MiB";

/// The stamp of the file at canonical itself; a symlink put in its place is
/// not followed, as the rename would replace the link.
fn stamp(canonical: &Path) -> Result<Stamp, String> {
    let meta = std::fs::symlink_metadata(canonical).map_err(open_path::io_error)?;
    if !meta.is_file() {
        return Err(NOT_REGULAR.to_string());
    }
    Stamp::of(&meta).map_err(open_path::io_error)
}

#[derive(Debug, Serialize)]
pub struct Contents {
    text: String,
    stamp: Stamp,
}

fn read(path: &Path) -> Result<Contents, String> {
    let canonical = std::fs::canonicalize(path).map_err(open_path::io_error)?;
    // Nonblocking, so a FIFO cannot hang the open; the stamp is the handle's,
    // taken before the read, so a change during the read shows on save.
    let f = OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(canonical).map_err(open_path::io_error)?;
    let meta = f.metadata().map_err(open_path::io_error)?;
    if !meta.is_file() {
        return Err(NOT_REGULAR.to_string());
    }
    if meta.len() > TEXT_MAX {
        return Err(TOO_LARGE.to_string());
    }
    let stamp = Stamp::of(&meta).map_err(open_path::io_error)?;
    let mut bytes = Vec::new();
    // Bounded, as the file can grow after its length was taken.
    (&f).take(TEXT_MAX + 1).read_to_end(&mut bytes).map_err(open_path::io_error)?;
    if bytes.len() as u64 > TEXT_MAX {
        return Err(TOO_LARGE.to_string());
    }
    // Strict: a lossy read would be saved back lossy.
    let text = String::from_utf8(bytes).map_err(|_| "not UTF-8 text".to_string())?;
    Ok(Contents { text, stamp })
}

/// Gives f what the original has beyond its content: mode, owner, flags, ACLs
/// and extended attributes such as Finder tags, which a plain new file lacks.
fn copy_metadata(original: &Path, f: &File) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    let src = File::open(original).map_err(open_path::io_error)?;
    // SAFETY: both descriptors are open for the call; a null state is allowed.
    let rc = unsafe { libc::fcopyfile(src.as_raw_fd(), f.as_raw_fd(), std::ptr::null_mut(), libc::COPYFILE_METADATA) };
    if rc != 0 {
        return Err(open_path::io_error(io::Error::last_os_error()));
    }
    Ok(())
}

/// Puts text in place of the file at canonical and returns its new stamp;
/// with expect, only while the file's stamp is still expect, else
/// CHANGED_ON_DISK. The text goes to a temporary file beside it that is then
/// renamed over it, so a failed write, a full disk say, leaves the original
/// whole. The temporary file is made with create_new, so a file or symlink
/// already at its name is never truncated or followed. The stamp is compared
/// again just before the rename, so a change made while the text was being
/// written is not silently lost; one in the instant between that check and the
/// rename still is. The mode, owner, flags, ACLs and extended attributes carry
/// over (a failure to copy them stops the save), and another hard link to the
/// file keeps the old text.
fn replace(canonical: &Path, text: &str, expect: Option<Stamp>) -> Result<Stamp, String> {
    let meta = std::fs::metadata(canonical).map_err(open_path::io_error)?;
    if !meta.is_file() {
        return Err(NOT_REGULAR.to_string());
    }
    let before = Stamp::of(&meta).map_err(open_path::io_error)?;
    if expect.is_some_and(|e| e != before) {
        return Err(CHANGED_ON_DISK.to_string());
    }
    // The rename needs only the folder to be writable, so it would replace a
    // file the user cannot write.
    let c = CString::new(canonical.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    // SAFETY: c ends in NUL.
    if unsafe { libc::access(c.as_ptr(), libc::W_OK) } != 0 {
        let e = io::Error::last_os_error();
        return Err(match e.raw_os_error() {
            Some(libc::EACCES | libc::EPERM | libc::EROFS) => READ_ONLY.to_string(),
            _ => open_path::io_error(e),
        });
    }
    let mut name = OsString::from(".");
    name.push(canonical.file_name().ok_or(NOT_REGULAR)?);
    name.push(format!(".vaquita-{}.tmp", std::process::id()));
    let tmp = canonical.with_file_name(&name);
    let mut f = match OpenOptions::new().write(true).create_new(true).open(&tmp) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            return Err(format!("a temporary file is in the way: {}", name.to_string_lossy()));
        }
        Err(e) => return Err(open_path::io_error(e)),
    };
    let written = (|| {
        copy_metadata(canonical, &f)?;
        f.write_all(text.as_bytes()).map_err(open_path::io_error)?;
        f.sync_all().map_err(open_path::io_error)?;
        // The rename keeps the inode, so this is the saved file's stamp.
        let after = Stamp::of(&f.metadata().map_err(open_path::io_error)?).map_err(open_path::io_error)?;
        if stamp(canonical)? != before {
            return Err(CHANGED_ON_DISK.to_string());
        }
        std::fs::rename(&tmp, canonical).map_err(open_path::io_error)?;
        Ok(after)
    })();
    if written.is_err() {
        // This call made tmp, so nobody else's file is removed.
        if let Err(e) = std::fs::remove_file(&tmp) {
            eprintln!("vaquita: remove {}: {e}", tmp.display());
        }
    }
    written
}

#[tauri::command]
pub async fn read_text(path: String) -> Result<Contents, String> {
    tauri::async_runtime::spawn_blocking(move || read(Path::new(&path))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn write_text(path: String, text: String, expect: Option<Stamp>) -> Result<Stamp, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let canonical = std::fs::canonicalize(&path).map_err(open_path::io_error)?;
        replace(&canonical, &text, expect)
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

    use std::os::unix::fs::PermissionsExt;

    fn text_file(name: &str, text: &str) -> PathBuf {
        let p = file(&dir(&format!("text-{name}")), "notes.txt", 0o644);
        std::fs::write(&p, text).unwrap();
        p
    }

    fn content(p: &Path) -> String {
        std::fs::read_to_string(p).unwrap()
    }

    // Every write below changes the length, so a stamp differs even where the
    // clock is too coarse to tell two writes apart.

    #[test]
    fn a_read_gives_the_text_and_its_stamp() {
        let p = text_file("read", "héllo\n");
        let r = read(&p).unwrap();
        assert_eq!(r.text, "héllo\n");
        assert_eq!(r.stamp, stamp(&p).unwrap());
    }

    #[test]
    fn a_write_with_the_read_stamp_saves_and_gives_a_new_one() {
        let p = text_file("write", "one\n");
        let old = read(&p).unwrap().stamp;
        let new = replace(&p, "one two\n", Some(old)).unwrap();
        assert_ne!(new, old);
        assert_eq!(new, stamp(&p).unwrap());
        assert_eq!(content(&p), "one two\n");
    }

    #[test]
    fn a_write_with_a_stale_stamp_leaves_the_file() {
        let p = text_file("stale", "one\n");
        let old = read(&p).unwrap().stamp;
        std::fs::write(&p, "changed elsewhere\n").unwrap();
        assert_eq!(replace(&p, "mine\n", Some(old)).unwrap_err(), CHANGED_ON_DISK);
        assert_eq!(content(&p), "changed elsewhere\n");
        // Without a stamp it writes whatever is there.
        replace(&p, "mine\n", None).unwrap();
        assert_eq!(content(&p), "mine\n");
    }

    #[test]
    fn a_write_keeps_the_mode() {
        let p = file(&dir("text-mode"), "notes.txt", 0o640);
        replace(&p, "longer text\n", None).unwrap();
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o640);
    }

    #[test]
    fn a_write_keeps_extended_attributes() {
        let p = text_file("xattr", "one\n");
        let name = CString::new("user.vaquita-test").unwrap();
        let c = CString::new(p.as_os_str().as_bytes()).unwrap();
        // SAFETY: both strings end in NUL and the value is 3 bytes.
        let rc = unsafe { libc::setxattr(c.as_ptr(), name.as_ptr(), b"abc".as_ptr().cast(), 3, 0, 0) };
        assert_eq!(rc, 0, "{}", io::Error::last_os_error());
        replace(&p, "one two\n", None).unwrap();
        let mut buf = [0u8; 8];
        // SAFETY: buf has room for the 8 bytes asked.
        let n = unsafe { libc::getxattr(c.as_ptr(), name.as_ptr(), buf.as_mut_ptr().cast(), 8, 0, 0) };
        assert_eq!(&buf[..n.max(0) as usize], b"abc");
    }

    #[test]
    fn a_read_only_file_is_not_replaced() {
        let p = file(&dir("text-ro"), "notes.txt", 0o444);
        assert_eq!(replace(&p, "longer text\n", None).unwrap_err(), READ_ONLY);
        assert_eq!(content(&p), "x");
        let names: Vec<_> = std::fs::read_dir(p.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["notes.txt"]);
    }

    #[test]
    fn a_write_into_a_folder_it_cannot_write_leaves_everything() {
        let p = text_file("readonly", "one\n");
        let d = p.parent().unwrap();
        std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o500)).unwrap();
        let r = replace(&p, "one two\n", None);
        let names: Vec<_> = std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name()).collect();
        std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(r.unwrap_err(), "Permission denied (os error 13)");
        assert_eq!(content(&p), "one\n");
        assert_eq!(names, ["notes.txt"]);
    }

    #[test]
    fn a_file_at_the_temporary_name_is_left_alone() {
        let p = text_file("inway", "one\n");
        let name = format!(".notes.txt.vaquita-{}.tmp", std::process::id());
        let tmp = p.with_file_name(&name);
        std::fs::write(&tmp, "someone else's\n").unwrap();
        assert_eq!(replace(&p, "one two\n", None).unwrap_err(), format!("a temporary file is in the way: {name}"));
        assert_eq!(content(&p), "one\n");
        assert_eq!(content(&tmp), "someone else's\n");
    }

    fn allowing(p: &Path) -> PdfAllowed {
        let a = PdfAllowed::default();
        a.0.lock().unwrap().insert(p.to_path_buf());
        a
    }

    fn url_path(p: &Path) -> String {
        format!("/{}", p.to_string_lossy().replace('/', "%2F").replace(' ', "%20"))
    }

    #[test]
    fn an_allowed_pdf_is_served_with_its_type_forced() {
        let p = file(&dir("pdf-ok"), "my doc.pdf", 0o644);
        std::fs::write(&p, b"%PDF-1.7\nbody").unwrap();
        let r = pdf_response(&allowing(&p), &url_path(&p));
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers()["Content-Type"], "application/pdf");
        assert_eq!(r.headers()["X-Content-Type-Options"], "nosniff");
        assert_eq!(r.body(), b"%PDF-1.7\nbody");
    }

    #[test]
    fn a_path_that_was_not_allowed_is_not_found() {
        let p = file(&dir("pdf-no"), "a.pdf", 0o644);
        std::fs::write(&p, b"%PDF-1.7\n").unwrap();
        let r = pdf_response(&PdfAllowed::default(), &url_path(&p));
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
        assert!(r.body().is_empty());
    }

    #[test]
    fn an_allowed_file_that_lost_the_magic_is_refused() {
        let p = file(&dir("pdf-swapped"), "a.pdf", 0o644);
        std::fs::write(&p, b"<html><script></script></html>").unwrap();
        let r = pdf_response(&allowing(&p), &url_path(&p));
        assert_eq!(r.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert!(r.body().is_empty());
    }

    #[test]
    fn a_pdf_over_the_limit_is_not_shown_nor_served() {
        let p = file(&dir("pdf-big"), "big.pdf", 0o644);
        let f = File::create(&p).unwrap();
        f.set_len(PDF_MAX + 1).unwrap();
        // Zeros, with no magic: judged by size before anything is read.
        assert_eq!(kind_of(&p, &std::fs::metadata(&p).unwrap()).unwrap(), None);
        (&f).write_all(b"%PDF-").unwrap();
        assert_eq!(kind_of(&p, &std::fs::metadata(&p).unwrap()).unwrap(), None);
        let r = pdf_response(&allowing(&p), &url_path(&p));
        assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(r.body().is_empty());
    }

    #[test]
    fn a_missing_or_binary_file_is_not_read() {
        let p = text_file("bad", "");
        assert_eq!(read(&p.with_file_name("missing.txt")).unwrap_err(), "no such file");
        std::fs::write(&p, b"caf\xe9").unwrap();
        assert_eq!(read(&p).unwrap_err(), "not UTF-8 text");
    }
}
