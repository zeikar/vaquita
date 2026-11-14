// An update deletes the app, and macOS privacy refuses every protected folder to
// a daemon whose executable is gone. A copy of the helper app in the home stays,
// and passes the app's designated requirement, so it still counts as vaquita.

use crate::launchd::{Outcome, Runner, HELPER, HELPER_EXE};
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};

const COPY: &str = "vaquitad.app";

/// The `vaquitad` of a copy, under `root`, of the helper app in the app bundle `app`,
/// one per helper CDHash. A missing copy is made, and published only once it
/// passes the app's designated requirement, so a present one is used as is.
/// Callers hold the home's helper lock, so there is one publisher at a time.
pub fn materialize(r: &dyn Runner, root: &Path, app: &Path) -> Result<PathBuf, String> {
    let helper = app.join("Contents").join(HELPER);
    let cdhash = cdhash(r, &helper)?;
    let dest = root.join(&cdhash);
    let copy = dest.join(COPY).join(HELPER_EXE);
    if copy.exists() {
        return Ok(copy);
    }
    // 0700, as Go's `state.Home` does: the app may be the first to create the home.
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(root)
        .map_err(|e| format!("could not create {}: {e}", root.display()))?;
    let staging = root.join(format!("{cdhash}.staging-{}", std::process::id()));
    let published = publish(r, &helper, app, &staging, &dest);
    if published.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    published.map(|()| copy)
}

fn publish(r: &dyn Runner, helper: &Path, app: &Path, staging: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir(staging).map_err(|e| format!("could not create {}: {e}", staging.display()))?;
    let staged = staging.join(COPY);
    let (helper, staged_s) = (helper.to_string_lossy(), staged.to_string_lossy());
    run(r, "copy the helper app", "/usr/bin/ditto", &[&helper, &staged_s])?;
    let requirement = requirement(r, app)?;
    run(
        r,
        "verify the copy against the app's signature",
        "/usr/bin/codesign",
        &["--verify", "--strict", "-R", &format!("={requirement}"), &staged_s],
    )?;
    // A directory here without a `vaquitad` is a leftover, not a copy; rename
    // cannot replace a non-empty directory. Removing it is safe only under the
    // helper lock, which keeps any other publisher out until the rename.
    if dest.exists() {
        std::fs::remove_dir_all(dest).map_err(|e| format!("could not remove {}: {e}", dest.display()))?;
    }
    std::fs::rename(staging, dest).map_err(|e| format!("could not publish {}: {e}", dest.display()))
}

// It names a directory, so it is held to what codesign prints.
fn cdhash(r: &dyn Runner, helper: &Path) -> Result<String, String> {
    let step = "read the helper's CDHash";
    let out = run(r, step, "/usr/bin/codesign", &["-dvvv", &helper.to_string_lossy()])?;
    let hash = out.stderr.lines().find_map(|l| l.strip_prefix("CDHash=")).unwrap_or("");
    if (40..=64).contains(&hash.len()) && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        Ok(hash.to_string())
    } else {
        Err(format!("could not {step}: got {hash:?}"))
    }
}

fn requirement(r: &dyn Runner, app: &Path) -> Result<String, String> {
    let step = "read the app's designated requirement";
    let out = run(r, step, "/usr/bin/codesign", &["-d", "-r-", &app.to_string_lossy()])?;
    // An implicit requirement, as of an ad hoc signature, is printed as a comment.
    out.stdout
        .lines()
        .find_map(|l| l.strip_prefix("# ").unwrap_or(l).strip_prefix("designated => "))
        .map(str::to_string)
        .ok_or_else(|| format!("could not {step}: none in {:?}", out.stdout))
}

fn run(r: &dyn Runner, step: &str, program: &str, args: &[&str]) -> Result<Outcome, String> {
    let out = r.run(program, args).map_err(|e| format!("could not {step}: {e}"))?;
    if out.ok {
        Ok(out)
    } else {
        Err(format!("could not {step}: {}", out.stderr))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launchd::RealRunner;
    use std::cell::RefCell;
    use std::os::unix::fs::PermissionsExt;

    const HASH: &str = "937918932045335991360a01c87c6a4b23588379";
    const DR: &str = r#"identifier "dev.example.vaquita" and anchor apple generic"#;

    struct Fake {
        calls: RefCell<Vec<Vec<String>>>,
        cdhash: &'static str,
        verify_fails: bool,
    }

    impl Fake {
        fn new() -> Self {
            Fake { calls: RefCell::default(), cdhash: HASH, verify_fails: false }
        }
    }

    impl Runner for Fake {
        fn run(&self, program: &str, args: &[&str]) -> Result<Outcome, String> {
            let mut call = vec![program.to_string()];
            call.extend(args.iter().map(|a| a.to_string()));
            self.calls.borrow_mut().push(call);
            let ran = |ok: bool, stdout: String, stderr: String| Ok(Outcome { ok, stdout, stderr });
            match (program, args[0]) {
                ("/usr/bin/codesign", "-dvvv") => ran(true, String::new(), format!("Identifier=x\nCDHash={}\nSignature=adhoc", self.cdhash)),
                ("/usr/bin/codesign", "-d") => ran(true, format!("designated => {DR}\n"), String::new()),
                ("/usr/bin/codesign", "--verify") => ran(!self.verify_fails, String::new(), "failed to satisfy".to_string()),
                ("/usr/bin/ditto", _) => {
                    let exe = Path::new(args[1]).join("Contents/MacOS/vaquitad");
                    std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
                    std::fs::write(exe, "").unwrap();
                    ran(true, String::new(), String::new())
                }
                _ => panic!("unexpected command {program}"),
            }
        }
    }

    // A temp dir with a home that does not exist yet, removed on drop.
    struct Dir {
        dir: PathBuf,
        root: PathBuf,
        app: PathBuf,
        helper: PathBuf,
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn dir(name: &str) -> Dir {
        let dir = std::env::temp_dir().join(format!("vaquita-helper-copy-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let app = dir.join("vaquita.app");
        let helper = app.join("Contents/Helpers/vaquitad.app");
        Dir { root: dir.join("home/helper.noindex"), app, helper, dir }
    }

    fn entries(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_new_copy_is_checked_then_published() {
        let d = dir("new");
        let f = Fake::new();
        let copy = materialize(&f, &d.root, &d.app).unwrap();
        assert_eq!(copy, d.root.join(HASH).join("vaquitad.app/Contents/MacOS/vaquitad"));
        assert!(copy.exists());
        assert_eq!(entries(&d.root), [HASH]);
        let staged = d.root.join(format!("{HASH}.staging-{}", std::process::id())).join("vaquitad.app");
        let (helper, staged) = (d.helper.to_string_lossy(), staged.to_string_lossy());
        assert_eq!(
            *f.calls.borrow(),
            vec![
                strs(&["/usr/bin/codesign", "-dvvv", &helper]),
                strs(&["/usr/bin/ditto", &helper, &staged]),
                strs(&["/usr/bin/codesign", "-d", "-r-", &d.app.to_string_lossy()]),
                strs(&["/usr/bin/codesign", "--verify", "--strict", "-R", &format!("={DR}"), &staged]),
            ]
        );
    }

    #[test]
    fn a_present_copy_is_reused_after_reading_the_cdhash() {
        let d = dir("present");
        let present = d.root.join(HASH).join("vaquitad.app/Contents/MacOS/vaquitad");
        std::fs::create_dir_all(present.parent().unwrap()).unwrap();
        std::fs::write(&present, "").unwrap();
        let f = Fake::new();
        assert_eq!(materialize(&f, &d.root, &d.app).unwrap(), present);
        assert_eq!(*f.calls.borrow(), vec![strs(&["/usr/bin/codesign", "-dvvv", &d.helper.to_string_lossy()])]);
    }

    #[test]
    fn a_leftover_directory_without_a_copy_is_replaced() {
        let d = dir("leftover");
        std::fs::create_dir_all(d.root.join(HASH).join("vaquitad.app")).unwrap();
        let copy = materialize(&Fake::new(), &d.root, &d.app).unwrap();
        assert!(copy.exists());
        assert_eq!(entries(&d.root), [HASH]);
    }

    #[test]
    fn a_copy_that_fails_verification_is_not_published() {
        let d = dir("unverified");
        let f = Fake { verify_fails: true, ..Fake::new() };
        let err = materialize(&f, &d.root, &d.app).unwrap_err();
        assert_eq!(err, "could not verify the copy against the app's signature: failed to satisfy");
        assert!(entries(&d.root).is_empty());
    }

    #[test]
    fn a_malformed_cdhash_is_refused_before_anything_is_created() {
        for bad in ["", "../../x", "937918932045335991360A01C87C6A4B23588379", "9379189320"] {
            let d = dir("malformed");
            let f = Fake { cdhash: bad, ..Fake::new() };
            let err = materialize(&f, &d.root, &d.app).unwrap_err();
            assert!(err.starts_with("could not read the helper's CDHash"), "{err}");
            assert_eq!(f.calls.borrow().len(), 1);
            assert!(!d.dir.exists());
        }
    }

    #[test]
    fn the_root_and_its_missing_parent_are_created_private() {
        let d = dir("mode");
        materialize(&Fake::new(), &d.root, &d.app).unwrap();
        for p in [d.root.parent().unwrap(), &d.root] {
            assert_eq!(std::fs::metadata(p).unwrap().permissions().mode() & 0o777, 0o700, "{}", p.display());
        }
    }

    fn signed_bundle(bundle: &Path, executable: &str, extra: &[&str]) {
        let macos = bundle.join("Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        std::fs::copy(std::env::current_exe().unwrap(), macos.join(executable)).unwrap();
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.example.vaquita</string>
<key>CFBundleExecutable</key><string>{executable}</string>
</dict></plist>
"#
        );
        std::fs::write(bundle.join("Contents/Info.plist"), plist).unwrap();
        let status = std::process::Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-", "--identifier", "dev.example.vaquita"])
            .args(extra)
            .arg(bundle)
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "codesign {}", bundle.display());
    }

    // A local build is signed ad hoc: the app's requirement is its own cdhash,
    // which no helper meets, so the app falls back to the helper inside it.
    #[test]
    fn an_ad_hoc_build_gets_no_copy() {
        let d = dir("adhoc");
        signed_bundle(&d.helper, "vaquitad", &[]);
        signed_bundle(&d.app, "vaquita", &[]);
        let err = materialize(&RealRunner, &d.root, &d.app).unwrap_err();
        assert!(err.starts_with("could not verify the copy against the app's signature: "), "{err}");
        assert!(err.contains("failed to satisfy"), "{err}");
        assert!(entries(&d.root).is_empty());
    }

    // A release's requirement names the identifier (and the team), which the
    // helper signed with the app's identifier meets.
    #[test]
    fn a_helper_that_meets_the_apps_requirement_is_published() {
        let d = dir("meets");
        signed_bundle(&d.helper, "vaquitad", &[]);
        signed_bundle(&d.app, "vaquita", &[r#"-r=designated => identifier "dev.example.vaquita""#]);
        let copy = materialize(&RealRunner, &d.root, &d.app).unwrap();
        let entries = entries(&d.root);
        assert_eq!(entries.len(), 1);
        assert_eq!(copy, d.root.join(&entries[0]).join("vaquitad.app/Contents/MacOS/vaquitad"));
        assert!(copy.exists());
    }
}
