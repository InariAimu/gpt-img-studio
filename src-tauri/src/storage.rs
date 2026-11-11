//! Data moves run before opening SQLite, while the previous process is stopped.
use crate::store::{id, text, Result};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const LOCATOR: &str = "storage-location.json";
fn display(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_owned()
}
fn config(base: &Path) -> Result<Value> {
    match fs::read(base.join(LOCATOR)) {
        Ok(data) => serde_json::from_slice(&data).map_err(|e| format!("存储路径配置无法读取：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({"active":display(base)})),
        Err(e) => Err(e.to_string()),
    }
}
fn write_config(base: &Path, config: &Value) -> Result<()> {
    fs::create_dir_all(base).map_err(|e| e.to_string())?;
    let temp = base.join("storage-location.json.tmp");
    let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
    use std::io::Write;
    file.write_all(config.to_string().as_bytes())
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(temp, base.join(LOCATOR)).map_err(|e| e.to_string())
}
pub fn request_move(base: &Path, source: &Path, target: &Path) -> Result<()> {
    let target = validate_target(source, target, false)?;
    write_config(
        base,
        &json!({"active":display(source),"pending":display(&target),"migrationId":id()}),
    )
}
fn validate_target(source: &Path, target: &Path, resuming: bool) -> Result<PathBuf> {
    if !target.is_absolute() {
        return Err("数据目录必须是绝对路径".into());
    }
    if target.as_os_str().is_empty() {
        return Err("请选择有效目录".into());
    }
    fs::create_dir_all(target).map_err(|e| format!("无法创建目标目录：{e}"))?;
    let target = target.canonicalize().map_err(|e| e.to_string())?;
    let source = source.canonicalize().map_err(|e| e.to_string())?;
    if target == source || target.starts_with(&source) || source.starts_with(&target) {
        return Err("目标目录不能是当前目录、其子目录或父目录".into());
    }
    if !resuming
        && fs::read_dir(&target)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
    {
        return Err("请使用空目录，避免覆盖已有文件".into());
    }
    Ok(target)
}
fn digest(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn files(root: &Path, directory: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
        if [
            LOCATOR,
            "storage-location.json.tmp",
            ".storage-migration.lock",
            ".storage-migration.json",
        ]
        .contains(&relative.to_string_lossy().as_ref())
        {
            continue;
        }
        let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err("数据目录含链接或 junction，请先移除链接再迁移".into());
            }
        }
        if meta.file_type().is_symlink() {
            return Err("数据目录含符号链接，无法自动迁移".into());
        }
        if meta.is_dir() {
            files(root, &path, out)?;
        } else if meta.is_file() {
            out.push(relative.to_path_buf());
        }
    }
    Ok(())
}
fn verify_database(root: &Path) -> Result<()> {
    let db = root.join("studio.sqlite3");
    if !db.exists() {
        return Ok(());
    }
    let connection = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let check: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if check != "ok" {
        return Err("目标数据库完整性校验失败，原数据保留".into());
    }
    let doc: String = connection
        .query_row("SELECT document FROM studio_state WHERE id=1", [], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;
    let doc: Value = serde_json::from_str(&doc).map_err(|e| e.to_string())?;
    for asset in doc["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["demo"] != true)
        .chain(doc["sketches"].as_array().into_iter().flatten())
    {
        for field in ["path", "thumbnailPath", "documentPath", "previewPath"] {
            let value = text(asset, field);
            if !value.is_empty() {
                let relative = Path::new(value);
                if relative.is_absolute()
                    || relative
                        .components()
                        .any(|c| matches!(c, std::path::Component::ParentDir))
                    || !root.join(relative).is_file()
                {
                    return Err(format!("图片文件校验失败：{field}，原数据保留"));
                }
            }
        }
    }
    Ok(())
}
fn resolve_pending(base: &Path) -> Result<PathBuf> {
    fs::create_dir_all(base).map_err(|e| e.to_string())?;
    let mut cfg = config(base)?;
    let source = PathBuf::from(text(&cfg, "active"));
    if source.as_os_str().is_empty() || !source.is_absolute() {
        return Err("本地数据目录配置无效".into());
    }
    if text(&cfg, "pending").is_empty() {
        if base.join(LOCATOR).exists() && !source.join("studio.sqlite3").exists() {
            return Err("配置的数据目录不可用，请检查磁盘或恢复数据目录".into());
        }
        return Ok(source);
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    let _lock = options
        .open(base.join(".storage-migration.lock"))
        .map_err(|_| "数据迁移正在另一进程中执行，请稍后重新打开")?;
    let target = validate_target(&source, Path::new(text(&cfg, "pending")), true)?;
    let marker = target.join(".storage-migration.json");
    if marker.exists() {
        let saved: Value = serde_json::from_slice(&fs::read(&marker).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        if saved["migrationId"] != cfg["migrationId"] {
            return Err("目标目录不属于本次迁移，原数据保留".into());
        }
    } else {
        if fs::read_dir(&target)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
        {
            return Err("目标目录已产生其他文件，原数据保留".into());
        }
        fs::write(
            &marker,
            json!({"migrationId":cfg["migrationId"],"source":display(&source)}).to_string(),
        )
        .map_err(|e| e.to_string())?;
    }
    // Restart can overlap the previous WebView browser's final cache cleanup.
    std::thread::sleep(std::time::Duration::from_secs(2));
    let mut list = Vec::new();
    files(&source, &source, &mut list)?;
    let mut checks = Vec::new();
    for relative in &list {
        let original = source.join(relative);
        let copied = target.join(relative);
        fs::create_dir_all(copied.parent().ok_or("目标路径无效")?).map_err(|e| e.to_string())?;
        if !copied
            .parent()
            .unwrap()
            .canonicalize()
            .map_err(|e| e.to_string())?
            .starts_with(&target)
        {
            return Err("目标父目录超出数据目录，原数据保留".into());
        }
        // A resumable target is owned by this migration, but may not contain external links.
        if copied.exists()
            && copied
                .canonicalize()
                .map_err(|e| e.to_string())?
                .strip_prefix(&target)
                .is_err()
        {
            return Err("目标文件超出数据目录，原数据保留".into());
        }
        match fs::copy(&original, &copied) {
            Ok(_) => {}
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    && relative.starts_with("webview2") =>
            {
                continue
            }
            Err(error) => {
                return Err(format!(
                    "迁移复制失败（{}），原数据保留：{error}",
                    relative.display()
                ))
            }
        }
        fs::OpenOptions::new()
            .write(true)
            .open(&copied)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        let hash = match digest(&original) {
            Ok(hash) => hash,
            Err(_) if relative.starts_with("webview2") && !original.exists() => {
                let _ = fs::remove_file(&copied);
                continue;
            }
            Err(error) => return Err(error),
        };
        if digest(&copied)? != hash {
            return Err("迁移文件校验失败，原数据保留".into());
        }
        checks.push((relative.clone(), hash));
    }
    verify_database(&target)?;
    // Recheck the complete source before switching. No source is removed before verification.
    for (relative, hash) in &checks {
        if digest(&source.join(relative))? != *hash {
            return Err("原目录在迁移期间发生变化，原数据保留".into());
        }
    }
    cfg = json!({"active":display(&target),"migratedFrom":display(&source),"migratedAt":crate::store::now()});
    write_config(base, &cfg)?;
    // Delete only copied, verified regular files. The locator and any new files stay untouched.
    let mut remaining = Vec::new();
    for (relative, hash) in &checks {
        let original = source.join(relative);
        if digest(&original).ok().as_deref() != Some(hash.as_str())
            || fs::remove_file(&original).is_err()
        {
            remaining.push(display(relative));
        }
    }
    let mut parents = checks
        .iter()
        .filter_map(|(p, _)| p.parent().map(|p| source.join(p)))
        .collect::<Vec<_>>();
    parents.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    parents.dedup();
    for parent in parents {
        if parent != source {
            let _ = fs::remove_dir(parent);
        }
    }
    cfg["cleanupRemaining"] = json!(remaining);
    write_config(base, &cfg)?;
    Ok(PathBuf::from(display(&target)))
}
pub fn resolve(base: &Path) -> Result<PathBuf> {
    match resolve_pending(base) {
        Ok(root) => Ok(root),
        Err(error) => {
            let cfg = config(base)?;
            let source = PathBuf::from(text(&cfg, "active"));
            if text(&cfg, "pending").is_empty() || !source.exists() || error.contains("另一进程")
            {
                return Err(error);
            }
            write_config(
                base,
                &json!({"active":display(&source),"lastMigrationError":error,"failedTarget":cfg["pending"]}),
            )?;
            Ok(source)
        }
    }
}
pub fn notice(base: &Path) -> Option<String> {
    let cfg = config(base).ok()?;
    if let Some(error) = cfg["lastMigrationError"].as_str() {
        return Some(format!("数据迁移未完成，仍使用原目录：{error}"));
    }
    let count = cfg["cleanupRemaining"].as_array().map_or(0, |a| a.len());
    if count > 0 {
        Some(format!(
            "已迁移到新目录，原目录仍有 {count} 个文件被占用或发生变化，需要检查后清理。"
        ))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn move_preserves_data_and_rejects_nonempty_targets() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("original");
        let target = temp.path().join("moved");
        drop(crate::store::Store::open(source.clone()).unwrap());
        fs::create_dir_all(source.join("assets")).unwrap();
        fs::write(source.join("assets/original.png"), b"original-bytes").unwrap();
        request_move(&source, &source, &target).unwrap();
        let resolved = resolve(&source).unwrap();
        assert_eq!(
            resolved.canonicalize().unwrap(),
            target.canonicalize().unwrap(),
            "{:?}",
            notice(&source)
        );
        assert_eq!(
            fs::read(target.join("assets/original.png")).unwrap(),
            b"original-bytes"
        );
        assert!(!source.join("assets/original.png").exists());
        assert!(source.join(LOCATOR).exists());
        assert_eq!(resolve(&source).unwrap(), resolved);
        let busy = temp.path().join("busy");
        fs::create_dir(&busy).unwrap();
        fs::write(busy.join("user.txt"), "keep").unwrap();
        assert!(request_move(&source, &target, &busy).is_err());
        assert_eq!(fs::read_to_string(busy.join("user.txt")).unwrap(), "keep");
    }
    #[test]
    fn database_and_usage_move_together_and_failed_validation_keeps_source() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        let store = crate::store::Store::open(source.clone()).unwrap();
        store
            .record_usage(&json!({"id":"persisted","occurredAt":1}))
            .unwrap();
        store
            .change(|doc| {
                doc["assets"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"id":"missing","demo":false,"path":"assets/missing.png"}));
                Ok(())
            })
            .unwrap();
        drop(store);
        request_move(&source, &source, &target).unwrap();
        assert_eq!(resolve(&source).unwrap(), source);
        assert!(source.join("studio.sqlite3").exists());
        assert!(notice(&source).is_some());
        let store = crate::store::Store::open(source.clone()).unwrap();
        store
            .change(|doc| {
                doc["assets"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|a| a["id"] != "missing");
                Ok(())
            })
            .unwrap();
        drop(store);
        let target2 = temp.path().join("target2");
        request_move(&source, &source, &target2).unwrap();
        resolve(&source).unwrap();
        let moved = crate::store::Store::open(target2).unwrap();
        assert_eq!(moved.usage_events().unwrap()[0]["id"], "persisted");
    }
}
