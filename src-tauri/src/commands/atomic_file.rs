//! In-process serialization and atomic replacement for shared JSON files.
//!
//! Octopal can complete several agents at once and can also have multiple
//! windows open. A plain read-modify-write sequence lets two writers read the
//! same old value and silently discard whichever update finishes first. These
//! helpers provide a per-path critical section and same-directory atomic file
//! replacement on every supported desktop platform.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

static PATH_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();

fn normalized_lock_key(path: &Path) -> PathBuf {
    if let Ok(canonical) = fs::canonicalize(path) {
        return canonical;
    }
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if let Ok(canonical_parent) = fs::canonicalize(parent) {
            return canonical_parent.join(name);
        }
    }
    path.to_path_buf()
}

/// Run one filesystem transaction while excluding other Octopal writers for
/// the same normalized path.
pub fn with_path_lock<T>(
    path: &Path,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    with_path_locks(std::slice::from_ref(&path.to_path_buf()), operation)
}

/// Run one filesystem transaction while excluding writers for every supplied
/// path. Keys are normalized, sorted, and locked in a deterministic order so
/// rename operations can safely cover both the old and new name without
/// deadlocking another concurrent rename.
pub fn with_path_locks<T>(
    paths: &[PathBuf],
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let mut keys = paths
        .iter()
        .map(|path| normalized_lock_key(path))
        .collect::<Vec<_>>();
    keys.sort();
    keys.dedup();
    if keys.is_empty() {
        return operation();
    }

    let locks = {
        let registry = PATH_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut locks = registry
            .lock()
            .map_err(|_| "path lock registry poisoned".to_string())?;
        // Weak entries let one-off workspace paths disappear instead of
        // growing this process-global registry for the lifetime of the app.
        locks.retain(|_, lock| lock.strong_count() > 0);
        let mut acquired = Vec::with_capacity(keys.len());
        for key in keys {
            let lock = if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(Mutex::new(()));
                locks.insert(key, Arc::downgrade(&lock));
                lock
            };
            acquired.push(lock);
        }
        acquired
    };

    let mut guards = Vec::with_capacity(locks.len());
    for lock in &locks {
        guards.push(
            lock.lock()
                .map_err(|_| "path write lock poisoned".to_string())?,
        );
    }
    operation()
}

/// Replace a file using a temporary file in the same directory. `persist`
/// performs an atomic overwrite on macOS, Linux, and Windows.
pub fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "target file has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(contents).map_err(|e| e.to_string())?;
    temp.flush().map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path)
        .map(|_| ())
        .map_err(|e| e.error.to_string())
}

pub fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    atomic_write(path, &json)
}

/// Copy a file through a same-directory temporary and atomically publish the
/// completed snapshot. A crash can leave at most an unreferenced temp file,
/// never a partially-written backup at the final path.
pub fn atomic_copy(source: &Path, target: &Path) -> Result<u64, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "target file has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut source = fs::File::open(source).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    let copied = std::io::copy(&mut source, &mut temp).map_err(|e| e.to_string())?;
    temp.flush().map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(target).map_err(|e| e.error.to_string())?;
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_read_modify_write_keeps_every_update() {
        let root =
            std::env::temp_dir().join(format!("octopal-atomic-file-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = Arc::new(root.join("history.json"));
        atomic_write_json(path.as_ref(), &Vec::<u32>::new()).unwrap();

        let mut workers = Vec::new();
        for value in 0..16_u32 {
            let path = path.clone();
            workers.push(std::thread::spawn(move || {
                with_path_lock(path.as_ref(), || {
                    let content = fs::read_to_string(path.as_ref()).map_err(|e| e.to_string())?;
                    let mut values: Vec<u32> =
                        serde_json::from_str(&content).map_err(|e| e.to_string())?;
                    values.push(value);
                    atomic_write_json(path.as_ref(), &values)
                })
                .unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }

        let mut values: Vec<u32> =
            serde_json::from_str(&fs::read_to_string(path.as_ref()).unwrap()).unwrap();
        values.sort_unstable();
        assert_eq!(values, (0..16).collect::<Vec<_>>());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn multi_path_lock_deduplicates_aliases_and_orders_keys() {
        let root =
            std::env::temp_dir().join(format!("octopal-multi-lock-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let first = root.join("first.json");
        let second = root.join("second.json");

        with_path_locks(&[second.clone(), first.clone(), first.clone()], || {
            atomic_write(&first, b"one")?;
            atomic_write(&second, b"two")
        })
        .unwrap();

        assert_eq!(fs::read(&first).unwrap(), b"one");
        assert_eq!(fs::read(&second).unwrap(), b"two");
        let _ = fs::remove_dir_all(root);
    }
}
