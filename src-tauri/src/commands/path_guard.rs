//! Shared filesystem-boundary checks for renderer-facing commands.
//!
//! Renderer strings are never treated as authority. Commands first resolve a
//! workspace folder from persisted application state, then resolve paths
//! beneath that canonical root while rejecting traversal and symlink hops.

use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::state::ManagedState;

/// Return the canonical form of `requested` only when it exactly matches a
/// folder persisted in one of the application's workspaces.
pub fn registered_folder(state: &ManagedState, requested: &Path) -> Result<PathBuf, String> {
    let registered: Vec<String> = state
        .app_state
        .lock()
        .map_err(|e| e.to_string())?
        .workspaces
        .iter()
        .flat_map(|workspace| workspace.folders.iter().cloned())
        .collect();
    canonical_registered_folder(requested, &registered)
}

/// Revalidate a path that was already canonicalized at a renderer-facing
/// boundary. This is intentionally separate from `registered_folder`: IPC
/// strings must exactly match persisted state, while trusted internal layers
/// may pass along the canonical result of that first validation.
pub(crate) fn revalidate_canonical_registered_folder(
    state: &ManagedState,
    requested: &Path,
) -> Result<PathBuf, String> {
    let registered: Vec<String> = state
        .app_state
        .lock()
        .map_err(|e| e.to_string())?
        .workspaces
        .iter()
        .flat_map(|workspace| workspace.folders.iter().cloned())
        .collect();
    canonical_registered_folder_internal(requested, &registered)
}

fn canonical_registered_folder_internal(
    requested: &Path,
    registered: &[String],
) -> Result<PathBuf, String> {
    let canonical =
        fs::canonicalize(requested).map_err(|e| format!("workspace folder is unavailable: {e}"))?;
    if canonical.as_os_str() != requested.as_os_str() {
        return Err("internal workspace path is not canonical".to_string());
    }
    if !canonical.is_dir() {
        return Err("workspace folder is not a directory".to_string());
    }
    if registered
        .iter()
        .filter_map(|folder| fs::canonicalize(folder).ok())
        .any(|folder| folder == canonical)
    {
        Ok(canonical)
    } else {
        Err("folder is not registered in an Octopal workspace".to_string())
    }
}

pub(crate) fn canonical_registered_folder(
    requested: &Path,
    registered: &[String],
) -> Result<PathBuf, String> {
    // A canonical-path comparison alone is insufficient for an IPC boundary:
    // an attacker could send a symlink alias (or a `..` spelling) that happens
    // to resolve to a registered folder. Require the renderer to echo the
    // exact persisted string before touching the filesystem.
    let persisted = registered
        .iter()
        .find(|folder| Path::new(folder.as_str()).as_os_str() == requested.as_os_str())
        .ok_or_else(|| "folder is not registered in an Octopal workspace".to_string())?;

    let requested =
        fs::canonicalize(requested).map_err(|e| format!("workspace folder is unavailable: {e}"))?;
    if !requested.is_dir() {
        return Err("workspace folder is not a directory".to_string());
    }
    let persisted = fs::canonicalize(persisted)
        .map_err(|e| format!("registered workspace folder is unavailable: {e}"))?;
    if persisted == requested {
        Ok(requested)
    } else {
        Err("registered workspace folder changed while resolving it".to_string())
    }
}

fn is_windows_reserved_name(value: &str) -> bool {
    // Windows treats a reserved DOS device basename as reserved even when an
    // extension is present (`CON.txt`). Keep this portable on every OS so a
    // workspace created on macOS/Linux remains safe when moved to Windows.
    let base = value
        .trim_end_matches([' ', '.'])
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(
        base.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
    ) || matches!(
        base.as_str(),
        "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "COM¹"
            | "COM²"
            | "COM³"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
            | "LPT¹"
            | "LPT²"
            | "LPT³"
    )
}

/// Validate a single filesystem segment. This deliberately rejects both path
/// separator styles on every platform so data written on macOS cannot become
/// traversal input when the same state is later opened on Windows.
pub fn safe_segment<'a>(value: &'a str, label: &str) -> Result<&'a str, String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.len() > 255
        || value.contains('/')
        || value.contains('\\')
        || value
            .chars()
            .any(|c| c <= '\u{1f}' || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        || value.ends_with([' ', '.'])
        || is_windows_reserved_name(value)
    {
        return Err(format!("invalid {label}"));
    }
    let mut components = Path::new(value).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err(format!("invalid {label}"));
    }
    Ok(value)
}

/// Parse a portable relative path, rejecting absolute paths, parent/current
/// components, Windows separators, and empty input.
pub fn safe_relative(value: &str) -> Result<PathBuf, String> {
    if value.is_empty()
        || value.contains('\\')
        || value.split('/').any(str::is_empty)
        || value.contains('\0')
    {
        return Err("invalid relative path".to_string());
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Err("absolute path is not allowed".to_string());
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let part = part
                    .to_str()
                    .ok_or_else(|| "relative path must be valid UTF-8".to_string())?;
                safe_segment(part, "relative path segment")?;
                normalized.push(part);
            }
            Component::CurDir | Component::ParentDir => {
                return Err("path traversal is not allowed".to_string())
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err("absolute path is not allowed".to_string())
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err("invalid relative path".to_string());
    }
    Ok(normalized)
}

fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("root is unavailable: {e}"))?;
    if !root.is_dir() {
        return Err("root is not a directory".to_string());
    }
    Ok(root)
}

fn validate_relative_path(relative: &Path) -> Result<(), String> {
    if relative.as_os_str().is_empty() || relative.is_absolute() {
        return Err("invalid relative path".to_string());
    }
    for component in relative.components() {
        match component {
            Component::Normal(part) => {
                let part = part
                    .to_str()
                    .ok_or_else(|| "relative path must be valid UTF-8".to_string())?;
                safe_segment(part, "relative path segment")?;
            }
            Component::CurDir | Component::ParentDir => {
                return Err("path traversal is not allowed".to_string())
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err("absolute path is not allowed".to_string())
            }
        }
    }
    Ok(())
}

/// Reject every existing symlink component below a canonical root. The final
/// open still happens separately, but this closes the persistent symlink
/// escape used by malicious workspaces and gives callers a common invariant.
fn reject_existing_symlinks(root: &Path, relative: &Path) -> Result<(), String> {
    let mut current = root.to_path_buf();
    let components: Vec<_> = relative.components().collect();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(part) = component else {
            return Err("path traversal is not allowed".to_string());
        };
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("symlink paths are not allowed".to_string())
            }
            Ok(meta) if index + 1 < components.len() && !meta.is_dir() => {
                return Err("path parent is not a directory".to_string())
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

/// Resolve an existing regular file below `root` without following symlinks.
pub fn existing_regular_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = safe_relative(relative)?;
    existing_regular_file_path(root, &relative)
}

pub fn existing_regular_file_path(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    validate_relative_path(relative)?;
    let root = canonical_root(root)?;
    reject_existing_symlinks(&root, relative)?;
    let candidate = root.join(relative);
    let resolved = fs::canonicalize(&candidate).map_err(|e| e.to_string())?;
    if !resolved.starts_with(&root) {
        return Err("path escapes its allowed root".to_string());
    }
    let meta = fs::metadata(&resolved).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("path is not a regular file".to_string());
    }
    Ok(resolved)
}

/// Resolve a path that may not exist yet, ensuring its nearest existing
/// ancestor is inside `root` and no existing component is a symlink.
pub fn write_target(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = safe_relative(relative)?;
    write_target_path(root, &relative)
}

pub fn write_target_path(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    validate_relative_path(relative)?;
    let root = canonical_root(root)?;
    reject_existing_symlinks(&root, relative)?;
    let candidate = root.join(relative);

    let mut ancestor = candidate.as_path();
    while !ancestor.exists() {
        ancestor = ancestor
            .parent()
            .ok_or_else(|| "path has no existing parent".to_string())?;
    }
    let ancestor = fs::canonicalize(ancestor).map_err(|e| e.to_string())?;
    if !ancestor.starts_with(&root) {
        return Err("path escapes its allowed root".to_string());
    }
    Ok(candidate)
}

/// Normalize an absolute or workspace-relative tool path into a stable key
/// beneath `root`. Existing components are canonicalized (including their
/// on-disk casing), while missing trailing components are appended only after
/// symlink and portable-segment validation. This is suitable for conflict
/// detection and other bookkeeping where lexical aliases must collapse.
pub fn normalized_contained_target(root: &Path, requested: &Path) -> Result<PathBuf, String> {
    let root = canonical_root(root)?;
    let relative = if requested.is_absolute() {
        requested
            .strip_prefix(&root)
            .map_err(|_| "path escapes its allowed root".to_string())?
    } else {
        requested
    };

    let mut normalized = PathBuf::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => {
                let part = part
                    .to_str()
                    .ok_or_else(|| "tool path must be valid UTF-8".to_string())?;
                safe_segment(part, "tool path segment")?;
                normalized.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir => return Err("path traversal is not allowed".to_string()),
            Component::Prefix(_) | Component::RootDir => {
                return Err("path escapes its allowed root".to_string())
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Ok(root);
    }

    reject_existing_symlinks(&root, &normalized)?;
    let candidate = root.join(&normalized);
    let mut cursor = candidate.as_path();
    let mut missing = Vec::new();
    let mut resolved = loop {
        match fs::canonicalize(cursor) {
            Ok(path) => break path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(
                    cursor
                        .file_name()
                        .ok_or_else(|| "path has no existing parent".to_string())?
                        .to_os_string(),
                );
                cursor = cursor
                    .parent()
                    .ok_or_else(|| "path has no existing parent".to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
    };
    for component in missing.iter().rev() {
        resolved.push(component);
    }
    if !resolved.starts_with(&root) {
        return Err("path escapes its allowed root".to_string());
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "octopal-path-guard-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn portable_relative_rejects_both_traversal_styles() {
        for bad in [
            "../secret",
            "a/../../secret",
            "..\\secret",
            "/tmp/x",
            "",
            "a//b",
            "a/",
            "safe/CON.txt",
            "safe/report:secret",
            "safe/trailing. ",
        ] {
            assert!(safe_relative(bad).is_err(), "accepted {bad:?}");
        }
        assert_eq!(
            safe_relative("safe/report.txt").unwrap(),
            Path::new("safe/report.txt")
        );
    }

    #[test]
    fn normalized_tool_target_collapses_lexical_aliases_and_rejects_escape() {
        let root = temp_dir("normalized-target");
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("nested/file.txt"), "ok").unwrap();

        let plain = normalized_contained_target(&root, Path::new("nested/file.txt")).unwrap();
        let dotted = normalized_contained_target(&root, Path::new("./nested/file.txt")).unwrap();
        assert_eq!(plain, dotted);
        assert_eq!(
            normalized_contained_target(&root, Path::new(".")).unwrap(),
            fs::canonicalize(&root).unwrap()
        );
        assert!(normalized_contained_target(&root, Path::new("../outside")).is_err());
        assert!(normalized_contained_target(&root, Path::new("missing/new.txt")).is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn portable_segment_rejects_windows_devices_ads_and_invalid_characters() {
        for bad in [
            "CON",
            "con.txt",
            "NUL.json",
            "COM1",
            "COM¹.log",
            "lpt9.md",
            "conout$",
            "name:stream",
            "bad?.txt",
            "bad|name",
            "trailing.",
            "trailing ",
            "control\u{1f}",
        ] {
            assert!(safe_segment(bad, "name").is_err(), "accepted {bad:?}");
        }
        assert!(safe_segment("compile-report.md", "name").is_ok());
    }

    #[test]
    fn pathbuf_helpers_reject_unsanitized_relative_components() {
        let root = temp_dir("pathbuf-validation");
        assert!(write_target_path(&root, Path::new("../escape")).is_err());
        assert!(write_target_path(&root, Path::new("safe/CON.txt")).is_err());
        assert!(existing_regular_file_path(&root, Path::new("/etc/passwd")).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn registered_folder_requires_an_exact_persisted_root() {
        let root = temp_dir("registered");
        let child = root.join("child");
        fs::create_dir_all(&child).unwrap();
        let registered = vec![root.to_string_lossy().into_owned()];
        assert_eq!(
            canonical_registered_folder(&root, &registered).unwrap(),
            fs::canonicalize(&root).unwrap()
        );
        assert!(canonical_registered_folder(&child, &registered).is_err());
        assert!(canonical_registered_folder(&root.join("."), &registered).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn registered_folder_rejects_a_symlink_alias_of_the_persisted_root() {
        use std::os::unix::fs::symlink;

        let root = temp_dir("registered-real");
        let alias_parent = temp_dir("registered-alias");
        let alias = alias_parent.join("alias");
        symlink(&root, &alias).unwrap();
        let registered = vec![root.to_string_lossy().into_owned()];
        assert!(canonical_registered_folder(&alias, &registered).is_err());
        let _ = fs::remove_dir_all(alias_parent);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn trusted_internal_revalidation_accepts_only_the_canonical_registered_target() {
        use std::os::unix::fs::symlink;

        let root = temp_dir("trusted-real");
        let alias_parent = temp_dir("trusted-alias");
        let alias = alias_parent.join("alias");
        symlink(&root, &alias).unwrap();
        let registered = vec![alias.to_string_lossy().into_owned()];
        let canonical = fs::canonicalize(&root).unwrap();

        assert_eq!(
            canonical_registered_folder_internal(&canonical, &registered).unwrap(),
            canonical
        );
        assert!(canonical_registered_folder_internal(&alias, &registered).is_err());
        let _ = fs::remove_dir_all(alias_parent);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn existing_file_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root = temp_dir("symlink-root");
        let outside = temp_dir("symlink-outside");
        fs::write(outside.join("secret"), "secret").unwrap();
        symlink(&outside, root.join("link")).unwrap();
        assert!(existing_regular_file(&root, "link/secret").is_err());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }
}
