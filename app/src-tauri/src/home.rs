use sha2::{Digest, Sha256};
use std::env;
use std::path::{Component, PathBuf};

const BASE_LABEL: &str = "io.github.zeikar.vaquitad";

/// Mirrors Go's `state.Home` (minus creating the directory): `$VAQUITA_HOME`
/// made absolute, else the per-user Application Support directory.
pub fn home() -> PathBuf {
    let dir = match env::var_os("VAQUITA_HOME").filter(|v| !v.is_empty()) {
        Some(v) => PathBuf::from(v),
        None => {
            let mut p = PathBuf::from(env::var_os("HOME").unwrap_or_default());
            p.push("Library/Application Support/vaquita");
            p
        }
    };
    std::path::absolute(&dir).unwrap_or(dir)
}

pub fn endpoint_path() -> PathBuf {
    home().join("endpoint.json")
}

/// Mirrors Go's `state.Label`: a custom home gets the first 8 hex chars of the
/// sha256 of its absolute, cleaned path, as `filepath.Abs` produces it.
pub fn label() -> String {
    let Some(custom) = env::var_os("VAQUITA_HOME").filter(|v| !v.is_empty()) else {
        return BASE_LABEL.to_string();
    };
    // std's `absolute` keeps `..`; Go's Abs cleans it lexically.
    let mut clean = PathBuf::new();
    // On failure keep the path as given, as Go's label and `home()` do.
    let custom = PathBuf::from(custom);
    for c in std::path::absolute(&custom).unwrap_or(custom).components() {
        match c {
            Component::ParentDir => {
                clean.pop();
            }
            c => clean.push(c),
        }
    }
    let sum = Sha256::digest(clean.as_os_str().as_encoded_bytes());
    let hex: String = sum.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("{BASE_LABEL}.{hex}")
}

pub fn plist_path() -> PathBuf {
    home().join(format!("{}.plist", label()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Tests that mutate VAQUITA_HOME hold this for their whole body.
    static ENV: Mutex<()> = Mutex::new(());

    // Restores VAQUITA_HOME on drop, so a panicking test does not leak it.
    struct Restore(Option<std::ffi::OsString>);

    impl Drop for Restore {
        fn drop(&mut self) {
            // SAFETY: still under the ENV lock held by with_home.
            match self.0.take() {
                Some(v) => unsafe { env::set_var("VAQUITA_HOME", v) },
                None => unsafe { env::remove_var("VAQUITA_HOME") },
            }
        }
    }

    fn with_home<R>(value: Option<&str>, f: impl FnOnce() -> R) -> R {
        let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let _restore = Restore(env::var_os("VAQUITA_HOME"));
        // SAFETY: every test that touches the environment holds ENV.
        match value {
            Some(v) => unsafe { env::set_var("VAQUITA_HOME", v) },
            None => unsafe { env::remove_var("VAQUITA_HOME") },
        }
        f()
    }

    #[test]
    fn home_resolution() {
        with_home(None, || {
            assert!(home().ends_with("Library/Application Support/vaquita"));
        });
        with_home(Some("relative/dir"), || {
            let h = home();
            assert!(h.is_absolute());
            assert!(h.ends_with("relative/dir"));
            assert_eq!(endpoint_path(), h.join("endpoint.json"));
        });
    }

    #[test]
    fn label_default() {
        with_home(None, || assert_eq!(label(), "io.github.zeikar.vaquitad"));
        with_home(Some(""), || assert_eq!(label(), "io.github.zeikar.vaquitad"));
    }

    #[test]
    fn label_hashes_the_absolute_home() {
        // printf '/tmp/vq-home' | shasum -a 256 | cut -c1-8
        with_home(Some("/tmp/vq-home"), || {
            assert_eq!(label(), "io.github.zeikar.vaquitad.3c340a06");
            assert_eq!(plist_path(), PathBuf::from("/tmp/vq-home/io.github.zeikar.vaquitad.3c340a06.plist"));
        });
        with_home(Some("/tmp/other/../vq-home/"), || {
            assert_eq!(label(), "io.github.zeikar.vaquitad.3c340a06");
        });
    }
}
