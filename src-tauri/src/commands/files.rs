use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri::State;
use uuid::Uuid;

const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;
const MAX_BASE64_INPUT_SIZE: usize = (MAX_FILE_SIZE as usize).div_ceil(3) * 4 + 16;
const UPLOADS_DIR: &str = ".octopal/uploads";

use super::path_guard;
use crate::state::ManagedState;

#[derive(Serialize)]
pub struct Attachment {
    pub id: String,
    #[serde(rename = "type")]
    pub att_type: String,
    pub filename: String,
    pub path: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub size: u64,
}

#[derive(Serialize)]
pub struct SaveResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment: Option<Attachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct ReadResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Check if a path is sensitive (should never be accessed)
fn is_sensitive_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    let sensitive_patterns = [
        ".env",
        "credentials",
        ".ssh",
        ".gnupg",
        ".aws/credentials",
        "keychain",
        ".npmrc",
        ".pypirc",
    ];
    sensitive_patterns.iter().any(|p| lower.contains(p))
}

/// Resolve one attachment created by `save_file`. Attachment IPC is kept
/// deliberately narrower than general workspace reads: only a direct regular
/// file in `.octopal/uploads` is accepted, and it must remain under the size
/// limit used when saving.
pub(crate) fn resolve_upload_file(folder: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = path_guard::safe_relative(relative_path)?;
    let parts: Vec<_> = relative.components().collect();
    if parts.len() != 3 || parts[0].as_os_str() != ".octopal" || parts[1].as_os_str() != "uploads" {
        return Err("Only files in .octopal/uploads may be read".to_string());
    }
    let resolved = path_guard::existing_regular_file_path(folder, &relative)?;
    let size = fs::metadata(&resolved).map_err(|e| e.to_string())?.len();
    if size > MAX_FILE_SIZE {
        return Err(format!(
            "File too large: {size} bytes (max {MAX_FILE_SIZE})"
        ));
    }
    Ok(resolved)
}

#[tauri::command]
pub fn save_file(
    app: tauri::AppHandle,
    folder_path: String,
    file_name: String,
    data: String,
    mime_type: String,
    state: State<'_, ManagedState>,
) -> SaveResult {
    if data.len() > MAX_BASE64_INPUT_SIZE {
        return SaveResult {
            ok: false,
            attachment: None,
            error: Some(format!("File too large (max {MAX_FILE_SIZE} bytes)")),
        };
    }
    let folder = match path_guard::registered_folder(&state, Path::new(&folder_path)) {
        Ok(folder) => folder,
        Err(error) => {
            return SaveResult {
                ok: false,
                attachment: None,
                error: Some(error),
            }
        }
    };
    let uploads_dir = match path_guard::write_target(&folder, UPLOADS_DIR) {
        Ok(path) => path,
        Err(error) => {
            return SaveResult {
                ok: false,
                attachment: None,
                error: Some(error),
            }
        }
    };
    if fs::create_dir_all(&uploads_dir).is_err() {
        return SaveResult {
            ok: false,
            attachment: None,
            error: Some("Failed to create uploads directory".to_string()),
        };
    }

    let id = Uuid::new_v4().to_string();
    let raw_ext = mime_type
        .split('/')
        .next_back()
        .unwrap_or("bin")
        .replace("jpeg", "jpg")
        .replace("plain", "txt");
    let ext = if !raw_ext.is_empty()
        && raw_ext.len() <= 16
        && raw_ext.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        raw_ext
    } else {
        "bin".to_string()
    };
    // Use ASCII-only chars in filename to avoid macOS Unicode normalization (NFC/NFD) issues
    let ascii_name: String = file_name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .take(120)
        .collect();
    let name_part = if ascii_name.is_empty() {
        "file".to_string()
    } else {
        ascii_name
    };
    let safe_name = format!(
        "{}_{}.{}",
        id.chars().take(8).collect::<String>(),
        name_part,
        ext
    );
    let file_path = match path_guard::write_target(&folder, &format!("{UPLOADS_DIR}/{safe_name}")) {
        Ok(path) => path,
        Err(error) => {
            return SaveResult {
                ok: false,
                attachment: None,
                error: Some(error),
            }
        }
    };

    // data is base64 encoded
    let decoded = match base64::engine::general_purpose::STANDARD.decode(&data) {
        Ok(d) => d,
        Err(_) => {
            // Try as raw text
            data.as_bytes().to_vec()
        }
    };
    if decoded.len() as u64 > MAX_FILE_SIZE {
        return SaveResult {
            ok: false,
            attachment: None,
            error: Some(format!("File too large (max {MAX_FILE_SIZE} bytes)")),
        };
    }

    match crate::commands::atomic_file::with_path_lock(&file_path, || {
        crate::commands::atomic_file::atomic_write(&file_path, &decoded)
    }) {
        Ok(_) => {
            let relative = format!("{UPLOADS_DIR}/{safe_name}");
            // Grant the asset protocol only this validated attachment. No
            // workspace or parent-directory grants are installed anywhere.
            let allowed_file = match resolve_upload_file(&folder, &relative) {
                Ok(path) => path,
                Err(error) => {
                    return SaveResult {
                        ok: false,
                        attachment: None,
                        error: Some(error),
                    }
                }
            };
            if let Err(error) = app.asset_protocol_scope().allow_file(&allowed_file) {
                return SaveResult {
                    ok: false,
                    attachment: None,
                    error: Some(format!("Failed to authorize saved attachment: {error}")),
                };
            }
            let att_type = if mime_type.starts_with("image/") {
                "image"
            } else {
                "text"
            };
            SaveResult {
                ok: true,
                attachment: Some(Attachment {
                    id,
                    att_type: att_type.to_string(),
                    filename: file_name,
                    path: relative,
                    mime_type,
                    size: decoded.len() as u64,
                }),
                error: None,
            }
        }
        Err(e) => SaveResult {
            ok: false,
            attachment: None,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub fn read_file_base64(
    folder_path: String,
    relative_path: String,
    state: State<'_, ManagedState>,
) -> ReadResult {
    let folder = match path_guard::registered_folder(&state, Path::new(&folder_path)) {
        Ok(folder) => folder,
        Err(error) => {
            return ReadResult {
                ok: false,
                data: None,
                error: Some(error),
            }
        }
    };
    let file_path = match resolve_upload_file(&folder, &relative_path) {
        Ok(path) => path,
        Err(error) => {
            return ReadResult {
                ok: false,
                data: None,
                error: Some(error),
            }
        }
    };
    match fs::read(&file_path) {
        Ok(bytes) => {
            if bytes.len() as u64 > MAX_FILE_SIZE {
                return ReadResult {
                    ok: false,
                    data: None,
                    error: Some(format!(
                        "File grew beyond the {MAX_FILE_SIZE} byte limit while reading"
                    )),
                };
            }
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            ReadResult {
                ok: true,
                data: Some(encoded),
                error: None,
            }
        }
        Err(e) => ReadResult {
            ok: false,
            data: None,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub fn get_absolute_path(
    app: tauri::AppHandle,
    folder_path: String,
    relative_path: String,
    state: State<'_, ManagedState>,
) -> Result<String, String> {
    let folder = path_guard::registered_folder(&state, Path::new(&folder_path))?;
    let resolved = resolve_upload_file(&folder, &relative_path)?;
    app.asset_protocol_scope()
        .allow_file(&resolved)
        .map_err(|e| format!("Failed to authorize attachment: {e}"))?;
    Ok(resolved.to_string_lossy().to_string())
}

#[derive(Serialize)]
pub struct DroppedFile {
    pub filename: String,
    /// Base64-encoded file bytes — the renderer turns this back into a `File`
    /// object so the existing addFiles flow can consume it unchanged.
    pub data: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub size: u64,
}

/// Cap on dropped file size — matches the renderer's MAX_FILE_SIZE so the
/// backend never reads anything that the UI would reject anyway.
/// Read an arbitrary file by absolute path. Used by the drag-and-drop flow:
/// Tauri 2's native drag-drop event gives us absolute paths the user just
/// dropped, and we read them here so the renderer can turn them into File
/// objects via the same code path as the file picker.
///
/// Defenses:
///   - Refuses sensitive paths (.env, credentials, etc.)
///   - Refuses anything bigger than MAX_DROPPED_FILE_SIZE
///   - Refuses non-files (no symlink chasing into directories)
#[tauri::command]
pub fn read_dropped_file(
    path: String,
    state: State<'_, ManagedState>,
) -> Result<DroppedFile, String> {
    if is_sensitive_path(&path) {
        return Err("Access denied: sensitive path".to_string());
    }
    let p = state.dropped_file_allowlist.consume(Path::new(&path))?;
    let metadata = fs::symlink_metadata(&p).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("Not a file".to_string());
    }
    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!(
            "File too large: {} bytes (max {})",
            metadata.len(),
            MAX_FILE_SIZE
        ));
    }
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_SIZE {
        return Err(format!(
            "File grew beyond the {} byte limit while reading",
            MAX_FILE_SIZE
        ));
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let filename = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let mime_type = guess_mime(&p);
    Ok(DroppedFile {
        filename,
        data: encoded,
        mime_type,
        size: metadata.len(),
    })
}

fn guess_mime(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "txt" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "js" | "jsx" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" => "text/typescript",
        "py" => "text/x-python",
        "rs" => "text/x-rust",
        "go" => "text/x-go",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "yml" | "yaml" => "text/yaml",
        "toml" => "text/toml",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uploads_fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "octopal-files-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(root.join(UPLOADS_DIR)).unwrap();
        fs::write(root.join(UPLOADS_DIR).join("attachment.txt"), b"ok").unwrap();
        fs::write(root.join("outside.txt"), b"secret").unwrap();
        root
    }

    #[test]
    fn attachment_reads_are_limited_to_direct_upload_files() {
        let root = uploads_fixture();
        assert!(resolve_upload_file(&root, ".octopal/uploads/attachment.txt").is_ok());
        for rejected in [
            "outside.txt",
            ".octopal/room-history.json",
            ".octopal/uploads/nested/attachment.txt",
            ".octopal/uploads/../room-history.json",
        ] {
            assert!(
                resolve_upload_file(&root, rejected).is_err(),
                "accepted {rejected:?}"
            );
        }
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn attachment_reads_reject_upload_symlinks() {
        use std::os::unix::fs::symlink;

        let root = uploads_fixture();
        symlink(
            root.join("outside.txt"),
            root.join(UPLOADS_DIR).join("alias.txt"),
        )
        .unwrap();
        assert!(resolve_upload_file(&root, ".octopal/uploads/alias.txt").is_err());
        let _ = fs::remove_dir_all(root);
    }
}
