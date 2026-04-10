use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Serialize)]
pub struct GitCommit {
    pub hash: String,
    #[serde(rename = "shortHash")]
    pub short_hash: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub message: String,
    pub body: String,
}

#[derive(Serialize)]
pub struct GitHistoryResult {
    pub ok: bool,
    pub commits: Vec<GitCommit>,
    pub total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct DiffEntry {
    pub file: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub patch: String,
}

#[derive(Serialize)]
pub struct GitDiffResult {
    pub ok: bool,
    pub entries: Vec<DiffEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct GitRevertResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reverted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct GitPushResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pushed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct GitRemoteResult {
    pub ok: bool,
    #[serde(rename = "hasRemote")]
    pub has_remote: bool,
}

fn is_git_repo(folder: &str) -> bool {
    Path::new(folder).join(".git").exists()
}

#[tauri::command]
pub fn git_get_history(
    folder_path: String,
    page: Option<u32>,
    per_page: Option<u32>,
) -> GitHistoryResult {
    if !is_git_repo(&folder_path) {
        return GitHistoryResult {
            ok: false,
            commits: vec![],
            total: 0,
            error: Some("Not a git repository".to_string()),
        };
    }

    let page = page.unwrap_or(1);
    let per_page = per_page.unwrap_or(20);
    let skip = (page - 1) * per_page;

    // Get total count
    let total = Command::new("git")
        .args(["rev-list", "--count", "HEAD"])
        .current_dir(&folder_path)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<usize>().ok())
        .unwrap_or(0);

    let output = Command::new("git")
        .args([
            "log",
            &format!("--skip={}", skip),
            &format!("-{}", per_page),
            "--format=%H%n%h%n%an%n%ae%n%aI%n%s%n%b%n---END---",
        ])
        .current_dir(&folder_path)
        .output();

    match output {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let mut commits = vec![];
            for block in stdout.split("---END---") {
                let lines: Vec<&str> = block.trim().lines().collect();
                if lines.len() >= 6 {
                    commits.push(GitCommit {
                        hash: lines[0].to_string(),
                        short_hash: lines[1].to_string(),
                        author: lines[2].to_string(),
                        email: lines[3].to_string(),
                        date: lines[4].to_string(),
                        message: lines[5].to_string(),
                        body: lines[6..].join("\n"),
                    });
                }
            }
            GitHistoryResult {
                ok: true,
                commits,
                total,
                error: None,
            }
        }
        _ => GitHistoryResult {
            ok: false,
            commits: vec![],
            total: 0,
            error: Some("Failed to get git history".to_string()),
        },
    }
}

#[tauri::command]
pub fn git_get_diff(folder_path: String, hash: String) -> GitDiffResult {
    if !is_git_repo(&folder_path) {
        return GitDiffResult {
            ok: false,
            entries: vec![],
            error: Some("Not a git repository".to_string()),
        };
    }

    let output = Command::new("git")
        .args(["diff", &format!("{}^..{}", hash, hash), "--numstat"])
        .current_dir(&folder_path)
        .output();

    let patch_output = Command::new("git")
        .args(["diff", &format!("{}^..{}", hash, hash)])
        .current_dir(&folder_path)
        .output();

    let mut entries = vec![];

    if let (Ok(numstat), Ok(patch)) = (output, patch_output) {
        let numstat_str = String::from_utf8_lossy(&numstat.stdout);
        let patch_str = String::from_utf8_lossy(&patch.stdout);

        for line in numstat_str.lines() {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 3 {
                let adds = parts[0].parse::<u32>().unwrap_or(0);
                let dels = parts[1].parse::<u32>().unwrap_or(0);
                let file = parts[2].to_string();
                let status = if adds > 0 && dels > 0 {
                    "modified"
                } else if adds > 0 {
                    "added"
                } else {
                    "deleted"
                };

                // Find the patch section for this file
                let file_patch = extract_file_patch(&patch_str, &file);

                entries.push(DiffEntry {
                    file,
                    status: status.to_string(),
                    additions: adds,
                    deletions: dels,
                    patch: file_patch,
                });
            }
        }
    }

    GitDiffResult {
        ok: true,
        entries,
        error: None,
    }
}

fn extract_file_patch(full_patch: &str, file: &str) -> String {
    let marker = format!("diff --git a/{}", file);
    if let Some(start) = full_patch.find(&marker) {
        let rest = &full_patch[start..];
        // Find end (next diff --git or end of string)
        if let Some(end) = rest[1..].find("diff --git") {
            rest[..end + 1].to_string()
        } else {
            rest.to_string()
        }
    } else {
        String::new()
    }
}

#[tauri::command]
pub fn git_revert(
    folder_path: String,
    hash: String,
    _to_hash: Option<String>,
) -> GitRevertResult {
    if !is_git_repo(&folder_path) {
        return GitRevertResult {
            ok: false,
            reverted: None,
            conflict: None,
            error: Some("Not a git repository".to_string()),
        };
    }

    let output = Command::new("git")
        .args(["revert", "--no-edit", &hash])
        .current_dir(&folder_path)
        .output();

    match output {
        Ok(out) if out.status.success() => GitRevertResult {
            ok: true,
            reverted: Some(true),
            conflict: None,
            error: None,
        },
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            if stderr.contains("CONFLICT") {
                GitRevertResult {
                    ok: false,
                    reverted: None,
                    conflict: Some(true),
                    error: Some(stderr.to_string()),
                }
            } else {
                GitRevertResult {
                    ok: false,
                    reverted: None,
                    conflict: None,
                    error: Some(stderr.to_string()),
                }
            }
        }
        Err(e) => GitRevertResult {
            ok: false,
            reverted: None,
            conflict: None,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub fn git_push(folder_path: String) -> GitPushResult {
    if !is_git_repo(&folder_path) {
        return GitPushResult {
            ok: false,
            pushed: None,
            error: Some("Not a git repository".to_string()),
        };
    }

    let output = Command::new("git")
        .args(["push"])
        .current_dir(&folder_path)
        .output();

    match output {
        Ok(out) if out.status.success() => GitPushResult {
            ok: true,
            pushed: Some(true),
            error: None,
        },
        Ok(out) => GitPushResult {
            ok: false,
            pushed: None,
            error: Some(String::from_utf8_lossy(&out.stderr).to_string()),
        },
        Err(e) => GitPushResult {
            ok: false,
            pushed: None,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub fn git_has_remote(folder_path: String) -> GitRemoteResult {
    if !is_git_repo(&folder_path) {
        return GitRemoteResult {
            ok: false,
            has_remote: false,
        };
    }

    let output = Command::new("git")
        .args(["remote"])
        .current_dir(&folder_path)
        .output();

    let has_remote = output
        .ok()
        .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false);

    GitRemoteResult {
        ok: true,
        has_remote,
    }
}
