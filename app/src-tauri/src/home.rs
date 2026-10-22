use std::env;
use std::path::PathBuf;

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

#[cfg(test)]
mod tests {
    use super::*;

    // One test, because both checks mutate the process environment.
    #[test]
    fn home_resolution() {
        let saved = env::var_os("VAQUITA_HOME");

        // SAFETY: this is the only test that touches the environment.
        unsafe { env::remove_var("VAQUITA_HOME") };
        assert!(home().ends_with("Library/Application Support/vaquita"));

        unsafe { env::set_var("VAQUITA_HOME", "relative/dir") };
        let h = home();
        assert!(h.is_absolute());
        assert!(h.ends_with("relative/dir"));
        assert_eq!(endpoint_path(), h.join("endpoint.json"));

        match saved {
            Some(v) => unsafe { env::set_var("VAQUITA_HOME", v) },
            None => unsafe { env::remove_var("VAQUITA_HOME") },
        }
    }
}
