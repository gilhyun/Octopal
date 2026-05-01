//! Augmented binary discovery for CLI-subscription providers.
//!
//! Phase 5a-finalize §3.1. Solves the core problem surfaced during
//! 5a Commit C-3 manual verification: macOS Finder/Dock-launched
//! Octopal inherits a minimal LaunchServices PATH (`/usr/bin:/bin:
//! /usr/sbin:/sbin`) with no nvm/asdf/homebrew dirs, so plain PATH
//! lookup misses `claude` (and `codex`, `gemini`, etc.) when they're
//! installed via npm/asdf/homebrew.
//!
//! Two surfaces:
//!
//! 1. [`discover_binary`] — find a named CLI tool by scanning the
//!    parent PATH **plus** known install dirs. Returns the first
//!    executable hit. Used by `detect_claude` / `detect_codex` /
//!    future `detect_*` commands.
//!
//! 2. [`augmented_path_value`] — render the candidate dirs as a `:`-
//!    joined PATH value, suitable for child env injection. Used by
//!    `goose_acp::build_goose_env` so subprocess-spawning providers
//!    (notably `chatgpt-codex`, whose `codex.js` shebang requires
//!    `node` on PATH) can resolve their runtime deps even when the
//!    parent inherited PATH is gutted.
//!
//! ## Why "augmented PATH" instead of just `*_COMMAND` env injection
//!
//! Goose has env overrides like `CLAUDE_CODE_COMMAND` and
//! `CODEX_COMMAND` that pin the binary's absolute path without PATH
//! lookup. We use those (5a-finalize §3.3) — but for shebang scripts
//! like `codex.js` (`#!/usr/bin/env node`), the *kernel* still does a
//! PATH lookup for the interpreter. So even with `CODEX_COMMAND` set
//! to the absolute codex.js path, the spawn fails with "env: node:
//! No such file or directory" if PATH is missing nvm's bin dir.
//!
//! Augmented PATH covers that. The two mechanisms are
//! complementary, not redundant.
//!
//! ## Name validation
//!
//! [`discover_binary`] only accepts names matching `^[A-Za-z0-9_-]+$`,
//! length ≤ 64. This is a contract-typing barrier against renderer-
//! supplied path traversal (`../../etc/passwd`) and against
//! accidentally probing arbitrary filesystem nodes — the function is
//! exposed via Tauri command [`super::cli_subscription::detect_binary`]
//! whose input arrives from the renderer.

use std::path::{Path, PathBuf};

/// Maximum length for a valid binary name. Real CLI tool names are
/// well under this; the cap is just a denial-of-service guard for the
/// validation regex equivalent.
const MAX_BINARY_NAME_LEN: usize = 64;

/// Returns true iff `name` is a valid binary name to probe for.
///
/// Rules: ASCII alphanumeric or `_`/`-`, length 1..=MAX_BINARY_NAME_LEN.
/// This excludes paths (`/`, `\`), parent-traversal (`..`), shell
/// metacharacters, and anything else that could break out of the
/// "look up a binary by name in known dirs" contract.
///
/// Returning `false` rather than panicking makes this safe to use as
/// the entry point of a Tauri command — bad input → empty result, not
/// an error pop-up.
pub fn is_valid_binary_name(name: &str) -> bool {
    if name.is_empty() || name.len() > MAX_BINARY_NAME_LEN {
        return false;
    }
    name.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Build the ordered list of directories where we'll look for CLI
/// binaries. First match wins — keep the order close to "what would
/// `which` find in the user's interactive shell."
///
/// Order:
/// 1. Parent process PATH (whatever the OS gave Octopal)
/// 2. nvm: `~/.nvm/versions/node/*/bin/`, **latest version mtime
///    first** so the active Node install wins over older crufty ones
/// 3. asdf: `~/.asdf/shims/`
/// 4. Homebrew, arch-aware:
///    - aarch64: `/opt/homebrew/bin`, `/opt/homebrew/sbin`
///    - x86_64:  `/usr/local/bin`, `/usr/local/sbin`
/// 5. `~/.local/bin/`
/// 6. `~/.cargo/bin/`
///
/// Dedups in-order: a dir already present from PATH won't be added a
/// second time by the heuristic. PATH order wins.
pub fn candidate_search_paths() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();

    let push = |dir: PathBuf,
                out: &mut Vec<PathBuf>,
                seen: &mut std::collections::HashSet<PathBuf>| {
        if seen.insert(dir.clone()) {
            out.push(dir);
        }
    };

    // 1. Parent PATH — whatever the OS handed us.
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            if !dir.as_os_str().is_empty() {
                push(dir, &mut out, &mut seen);
            }
        }
    }

    // 2. nvm — glob the versioned dirs, latest mtime first.
    if let Some(home) = home_dir() {
        let nvm_root = home.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm_root) {
            let mut versioned: Vec<(std::time::SystemTime, PathBuf)> = entries
                .flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter_map(|e| {
                    let bin = e.path().join("bin");
                    if !bin.is_dir() {
                        return None;
                    }
                    let mtime = e
                        .metadata()
                        .and_then(|m| m.modified())
                        .unwrap_or(std::time::UNIX_EPOCH);
                    Some((mtime, bin))
                })
                .collect();
            // Latest first (descending mtime). Stable sort over equal
            // mtimes — alphabetical names break ties consistently.
            versioned.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
            for (_, bin) in versioned {
                push(bin, &mut out, &mut seen);
            }
        }

        // 3. asdf
        let asdf_shims = home.join(".asdf/shims");
        if asdf_shims.is_dir() {
            push(asdf_shims, &mut out, &mut seen);
        }

        // 5. ~/.local/bin
        let local_bin = home.join(".local/bin");
        if local_bin.is_dir() {
            push(local_bin, &mut out, &mut seen);
        }

        // 6. ~/.cargo/bin
        let cargo_bin = home.join(".cargo/bin");
        if cargo_bin.is_dir() {
            push(cargo_bin, &mut out, &mut seen);
        }
    }

    // 4. Homebrew — arch-aware.
    #[cfg(target_arch = "aarch64")]
    {
        for d in ["/opt/homebrew/bin", "/opt/homebrew/sbin"] {
            let p = PathBuf::from(d);
            if p.is_dir() {
                push(p, &mut out, &mut seen);
            }
        }
    }
    #[cfg(target_arch = "x86_64")]
    {
        for d in ["/usr/local/bin", "/usr/local/sbin"] {
            let p = PathBuf::from(d);
            if p.is_dir() {
                push(p, &mut out, &mut seen);
            }
        }
    }

    out
}

/// Render the candidate search paths as a single `:`-joined string,
/// suitable for assignment to a child process's PATH env. Empty if
/// no candidates resolved (vanishingly unlikely — the parent PATH
/// alone is usually non-empty even on bare LaunchServices spawns).
pub fn augmented_path_value() -> String {
    let dirs = candidate_search_paths();
    let path_strs: Vec<String> = dirs
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    path_strs.join(":")
}

/// Look up a binary by name in the candidate search paths. Returns
/// the absolute path of the first executable hit, or `None` if the
/// binary isn't installed in any known location.
///
/// "Executable" means: the path resolves to a regular file (after
/// symlink resolution) AND the file's permissions include at least
/// one execute bit on POSIX. On Windows we accept the file plus
/// common executable extensions (`.exe`, `.cmd`, `.bat`); the symlink
/// dance in `~/.nvm/.../claude.exe → ../lib/.../claude.exe` works on
/// macOS because `is_file()` follows symlinks and the target is the
/// real Bun-compiled binary.
///
/// Returns `None` for invalid names (per [`is_valid_binary_name`]).
/// This is the API barrier against renderer-supplied path traversal.
pub fn discover_binary(name: &str) -> Option<PathBuf> {
    if !is_valid_binary_name(name) {
        return None;
    }

    for dir in candidate_search_paths() {
        let candidate = dir.join(name);
        if is_runnable(&candidate) {
            return Some(candidate);
        }

        // Windows executable extensions. POSIX no-op (the cfg gate
        // means the loop body doesn't even compile on POSIX).
        #[cfg(windows)]
        {
            for ext in ["exe", "cmd", "bat"] {
                let with_ext = candidate.with_extension(ext);
                if is_runnable(&with_ext) {
                    return Some(with_ext);
                }
            }
        }
    }
    None
}

/// True iff `path` is a regular file (post-symlink) and looks
/// runnable. Symlink resolution comes for free via `is_file()` on
/// `std::path::Path`.
fn is_runnable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::metadata(path) {
            Ok(meta) => meta.permissions().mode() & 0o111 != 0,
            Err(_) => false,
        }
    }
    // On Windows, file existence + extension are how the OS itself
    // decides "runnable" — there's no exec bit. Caller's extension
    // loop handles `.exe`/`.cmd`/`.bat`; here we just trust `is_file`.
    #[cfg(not(unix))]
    {
        true
    }
}

/// Cross-platform home dir lookup. Wraps `dirs::home_dir` so the
/// rest of the module can ignore Windows quirks (Windows uses
/// `USERPROFILE`, POSIX `$HOME`).
fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Make `dir` and an executable file at `dir/name` so we can
    /// validate the discovery walk against synthetic filesystems.
    /// Returns the absolute path of the created file.
    fn touch_executable(dir: &Path, name: &str) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, b"#!/bin/sh\necho stub\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    /// Make a non-executable file (touches the same name layout but
    /// no exec bits). Used to verify is_runnable rejects.
    fn touch_nonexec(dir: &Path, name: &str) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, b"data\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        }
        path
    }

    fn unique_tmp(label: &str) -> PathBuf {
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("octopal-bd-{label}-{pid}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ── name validation ──────────────────────────────────────────

    #[test]
    fn is_valid_binary_name_accepts_typical_cli_names() {
        assert!(is_valid_binary_name("claude"));
        assert!(is_valid_binary_name("codex"));
        assert!(is_valid_binary_name("gemini-cli"));
        assert!(is_valid_binary_name("cursor_agent"));
        assert!(is_valid_binary_name("a"));
        assert!(is_valid_binary_name("tool123"));
    }

    #[test]
    fn is_valid_binary_name_rejects_path_traversal() {
        // The whole point of validation: renderer can't ship "../../etc/passwd"
        // and have us probe arbitrary filesystem locations.
        assert!(!is_valid_binary_name(".."));
        assert!(!is_valid_binary_name("../claude"));
        assert!(!is_valid_binary_name("foo/bar"));
        assert!(!is_valid_binary_name("foo\\bar"));
        assert!(!is_valid_binary_name("/usr/bin/claude"));
    }

    #[test]
    fn is_valid_binary_name_rejects_shell_metacharacters() {
        for bad in &[
            "claude; rm -rf /",
            "claude && evil",
            "claude|cat",
            "claude$()",
            "claude `evil`",
            "claude\nevil",
            "",
        ] {
            assert!(
                !is_valid_binary_name(bad),
                "should reject: {bad:?}",
            );
        }
    }

    #[test]
    fn is_valid_binary_name_rejects_oversized() {
        let too_long = "a".repeat(MAX_BINARY_NAME_LEN + 1);
        assert!(!is_valid_binary_name(&too_long));
        let just_at_limit = "a".repeat(MAX_BINARY_NAME_LEN);
        assert!(is_valid_binary_name(&just_at_limit));
    }

    // ── candidate_search_paths ────────────────────────────────────

    #[test]
    fn candidate_search_paths_dedups_on_repeated_dir() {
        // Same dir present in PATH twice (a reasonable shell config
        // accident) should appear only once in the candidate list.
        let dir_a = unique_tmp("dedup-a");
        let path_with_dup = format!(
            "{}:{}:{}",
            dir_a.display(),
            dir_a.display(),
            dir_a.display()
        );
        let _g = EnvGuard::set("PATH", &path_with_dup);
        let dirs = candidate_search_paths();
        let count = dirs.iter().filter(|d| **d == dir_a).count();
        assert_eq!(count, 1, "dir_a should appear exactly once: {dirs:?}");
    }

    #[test]
    fn candidate_search_paths_starts_with_parent_path() {
        // Parent PATH order is preserved; heuristic dirs come after.
        let dir_a = unique_tmp("first-a");
        let dir_b = unique_tmp("first-b");
        let path = format!("{}:{}", dir_a.display(), dir_b.display());
        let _g = EnvGuard::set("PATH", &path);
        let dirs = candidate_search_paths();
        let pos_a = dirs.iter().position(|d| *d == dir_a).expect("dir_a present");
        let pos_b = dirs.iter().position(|d| *d == dir_b).expect("dir_b present");
        assert!(pos_a < pos_b, "PATH order preserved: {dirs:?}");
    }

    #[test]
    fn candidate_search_paths_skips_empty_path_segments() {
        // POSIX PATH like `:::foo` has empty entries that traditionally
        // mean "current dir" — refusing to pollute the candidate list
        // with empty paths is safer.
        let dir_a = unique_tmp("skip-empty");
        let path = format!("::{}::", dir_a.display());
        let _g = EnvGuard::set("PATH", &path);
        let dirs = candidate_search_paths();
        for d in &dirs {
            assert!(
                !d.as_os_str().is_empty(),
                "no empty dirs in candidate list: {dirs:?}",
            );
        }
        assert!(dirs.iter().any(|d| *d == dir_a));
    }

    // ── discover_binary ──────────────────────────────────────────

    #[test]
    fn discover_binary_finds_executable_in_parent_path() {
        let dir = unique_tmp("find-via-path");
        let bin_name = "octopal-test-tool-001";
        let abs = touch_executable(&dir, bin_name);
        let _g = EnvGuard::set("PATH", &dir.display().to_string());

        let found = discover_binary(bin_name).expect("should find synthetic binary");
        assert_eq!(found, abs);
    }

    #[test]
    fn discover_binary_skips_nonexecutable_file() {
        let dir = unique_tmp("skip-nonexec");
        let bin_name = "octopal-test-tool-002";
        // Non-executable file with the matching name in the parent
        // PATH dir → discover should NOT return it. (POSIX-only;
        // Windows treats `is_file` as "runnable" with extension dance.)
        touch_nonexec(&dir, bin_name);
        let _g = EnvGuard::set("PATH", &dir.display().to_string());

        #[cfg(unix)]
        assert!(
            discover_binary(bin_name).is_none(),
            "non-executable file shouldn't be reported as a runnable binary",
        );
    }

    #[test]
    fn discover_binary_returns_none_for_absent_binary() {
        let dir = unique_tmp("absent");
        let _g = EnvGuard::set("PATH", &dir.display().to_string());
        assert!(discover_binary("octopal-definitely-not-installed-xyz").is_none());
    }

    #[test]
    fn discover_binary_rejects_invalid_names_via_validation() {
        // Even if the file existed at the literal path, the API
        // refuses to look it up — the validator is the security
        // boundary, not "discovery couldn't find it."
        assert!(discover_binary("../claude").is_none());
        assert!(discover_binary("/usr/bin/sh").is_none());
        assert!(discover_binary("").is_none());
    }

    #[test]
    fn discover_binary_first_hit_wins() {
        // Two PATH dirs both contain the same name — first one wins.
        // This pins the "PATH order matters" invariant.
        let dir_a = unique_tmp("first-wins-a");
        let dir_b = unique_tmp("first-wins-b");
        let bin_name = "octopal-test-tool-003";
        let path_a = touch_executable(&dir_a, bin_name);
        touch_executable(&dir_b, bin_name);
        let path_var = format!("{}:{}", dir_a.display(), dir_b.display());
        let _g = EnvGuard::set("PATH", &path_var);

        assert_eq!(discover_binary(bin_name), Some(path_a));
    }

    // ── augmented_path_value ─────────────────────────────────────

    #[test]
    fn augmented_path_value_includes_parent_path() {
        let dir = unique_tmp("aug-path-includes");
        let _g = EnvGuard::set("PATH", &dir.display().to_string());
        let aug = augmented_path_value();
        assert!(
            aug.contains(&dir.display().to_string()),
            "augmented PATH must include parent PATH dirs; got {aug}",
        );
    }

    #[test]
    fn augmented_path_value_uses_colon_separator() {
        // POSIX-only — Windows path separator differs and we don't
        // ship Windows in 5a-finalize scope.
        let dir_a = unique_tmp("sep-a");
        let dir_b = unique_tmp("sep-b");
        let path = format!("{}:{}", dir_a.display(), dir_b.display());
        let _g = EnvGuard::set("PATH", &path);
        let aug = augmented_path_value();
        // Both dirs visible AND separated by `:`, in input order.
        let pos_a = aug.find(&dir_a.display().to_string()).expect("a in aug");
        let pos_b = aug.find(&dir_b.display().to_string()).expect("b in aug");
        assert!(pos_a < pos_b, "PATH order preserved in augmented value");
        assert!(aug.contains(':'));
    }

    // ── env mutation guard ───────────────────────────────────────
    //
    // Same pattern as cli_subscription.rs::EnvGuard. Tests that mutate
    // PATH must serialize to avoid cross-test interference. The tests
    // in this module that don't touch env (validation, etc.) run in
    // parallel as normal.

    static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct EnvGuard {
        key: String,
        prev: Option<String>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl EnvGuard {
        fn set(key: &str, value: &str) -> Self {
            let lock = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            let prev = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self {
                key: key.to_string(),
                prev,
                _lock: lock,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match self.prev.take() {
                Some(v) => std::env::set_var(&self.key, v),
                None => std::env::remove_var(&self.key),
            }
        }
    }
}
