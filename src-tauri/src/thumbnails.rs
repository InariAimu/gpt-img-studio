use crate::store::{id, list_mut, text, Result, Store};
use image::{DynamicImage, ImageFormat};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Cursor, Read, Write},
    path::Path,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

const MAX_BYTES: usize = 128 * 1024 * 1024;
const BATCH_SIZE: usize = 4;

pub(crate) fn decode_raster(bytes: &[u8]) -> Result<(DynamicImage, &'static str, &'static str)> {
    if bytes.len() > MAX_BYTES {
        return Err("单张图片不能超过 128 MB".into());
    }
    let unsupported = "不支持的图片格式，请使用 PNG、JPEG、WebP 或 GIF";
    let format = image::guess_format(bytes).map_err(|_| unsupported)?;
    let (extension, mime) = match format {
        ImageFormat::Png => ("png", "image/png"),
        ImageFormat::Jpeg => ("jpg", "image/jpeg"),
        ImageFormat::WebP => ("webp", "image/webp"),
        ImageFormat::Gif => ("gif", "image/gif"),
        _ => return Err(unsupported.into()),
    };
    let (width, height) = image::ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|e| format!("无法读取图片尺寸：{e}"))?;
    if u64::from(width) * u64::from(height) > 50_000_000 {
        return Err("图片超过 5000 万像素，请先缩小图片".into());
    }
    let decoded = image::load_from_memory_with_format(bytes, format)
        .map_err(|e| format!("无法解码图片：{e}"))?;
    Ok((decoded, extension, mime))
}

pub(crate) fn encode(image: &DynamicImage) -> Result<Vec<u8>> {
    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image.thumbnail(960, 960).to_rgba8())
        .write_to(&mut output, ImageFormat::WebP)
        .map_err(|e| format!("无法生成预览图：{e}"))?;
    Ok(output.into_inner())
}

pub(crate) fn relative_path(hash: &str) -> String {
    format!("thumbnails/{hash}.webp")
}

pub(crate) fn is_cached(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() > 0)
}

pub(crate) fn install(path: &Path, bytes: &[u8]) -> Result<()> {
    let directory = path.parent().ok_or("无效的缩略图目录")?;
    if !fs::symlink_metadata(directory)
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("无效的缩略图目录".into());
    }
    let temporary = directory.join(format!(".preview-{}.tmp", id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = written.and_then(|()| fs::rename(&temporary, path)) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法保存预览图：{error}"));
    }
    Ok(())
}

fn needs_preview(asset: &Value) -> bool {
    asset["demo"] != true
        && text(asset, "thumbnailPath").is_empty()
        && matches!(
            text(asset, "mime"),
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        )
}

struct Prepared {
    path: String,
    bytes: Option<Vec<u8>>,
}

fn prepare(store: &Store, asset: &Value) -> Result<Prepared> {
    let original = store.asset_path(asset)?;
    if !original.is_file() {
        return Err("原图不是文件".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(original)
        .and_then(|file| file.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes))
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("单张图片不能超过 128 MB".into());
    }
    let path = relative_path(&format!("{:x}", Sha256::digest(&bytes)));
    let bytes = if is_cached(&store.root.join(&path)) {
        None
    } else {
        Some(encode(&decode_raster(&bytes)?.0)?)
    };
    Ok(Prepared { path, bytes })
}

fn publish(store: &Store, prepared: &HashMap<&str, Option<Prepared>>) -> Result<(Value, bool)> {
    let _operation = store.operation()?;
    // Recheck against the current document before installing a preview for a removed or changed asset.
    store.change_if(|document| {
        let assets = list_mut(document, "assets")?;
        let mut updated = false;
        for asset in assets.iter_mut().filter(|asset| needs_preview(asset)) {
            let Some(Some(preview)) = prepared.get(text(asset, "path")) else {
                continue;
            };
            let target = store.root.join(&preview.path);
            if !is_cached(&target) {
                let Some(bytes) = &preview.bytes else {
                    continue;
                };
                if install(&target, bytes).is_err() {
                    continue;
                }
            }
            asset["thumbnailPath"] = json!(preview.path);
            updated = true;
        }
        Ok(updated)
    })
}

fn backfill(store: &Store, ids: &[String]) -> Result<(Value, bool)> {
    let _worker = store.thumbnail_worker.lock().map_err(|e| e.to_string())?;
    let snapshot = store.read()?;
    let ids: HashSet<_> = ids.iter().take(BATCH_SIZE).map(String::as_str).collect();
    let mut prepared = HashMap::new();
    for asset in snapshot["assets"].as_array().into_iter().flatten() {
        if ids.contains(text(asset, "id")) && needs_preview(asset) {
            prepared
                .entry(text(asset, "path"))
                .or_insert_with(|| prepare(store, asset).ok());
        }
    }
    if prepared.values().all(Option::is_none) {
        return Ok((snapshot, false));
    }
    publish(store, &prepared)
}

async fn run_batch(app: AppHandle, ids: Vec<String>) -> Result<(Value, bool)> {
    tauri::async_runtime::spawn_blocking(move || backfill(&app.state::<Store>(), &ids))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn prepare_asset_thumbnails(app: AppHandle, asset_ids: Vec<String>) -> Result<Value> {
    run_batch(app, asset_ids)
        .await
        .map(|(document, _)| document)
}

pub(crate) fn warm_synced(app: &AppHandle, before: &Value, after: &Value) {
    let previous: HashSet<_> = before["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|asset| (text(asset, "id"), text(asset, "path")))
        .collect();
    let ids: Vec<_> = after["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|asset| {
            needs_preview(asset) && !previous.contains(&(text(asset, "id"), text(asset, "path")))
        })
        .map(|asset| text(asset, "id").to_owned())
        .collect();
    if ids.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for batch in ids.chunks(BATCH_SIZE) {
            // Leave the worker available for previews requested by the visible gallery.
            tokio::time::sleep(Duration::from_millis(350)).await;
            if let Ok((document, true)) = run_batch(app.clone(), batch.to_vec()).await {
                let _ = app.emit("studio:changed", document);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGINAL: &[u8] = include_bytes!("../icons/icon.png");
    const ORIGINAL_PATH: &str = "assets/remote.png";

    fn seed_store() -> (tempfile::TempDir, Store) {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../output/gallery-thumbnails");
        fs::create_dir_all(&dir).unwrap();
        let scratch = tempfile::tempdir_in(dir).unwrap();
        let store = Store::open(scratch.path().to_owned()).unwrap();
        fs::write(store.root.join(ORIGINAL_PATH), ORIGINAL).unwrap();
        store
            .change(|doc| {
                doc["assets"] = json!([
                    {"id":"remote","mime":"image/png","path":ORIGINAL_PATH},
                    {"id":"same-original","mime":"image/png","path":ORIGINAL_PATH},
                    {"id":"broken","mime":"image/png","path":"assets/missing.png"}
                ]);
                Ok(())
            })
            .unwrap();
        (scratch, store)
    }

    #[test]
    fn historical_thumbnails_share_a_preview_and_keep_originals() {
        let (_scratch, store) = seed_store();
        let before = store.read().unwrap();
        let (saved, changed) = backfill(&store, &["broken".into(), "remote".into()]).unwrap();
        let thumbnail = text(&saved["assets"][0], "thumbnailPath");
        assert!(changed);
        assert_eq!(saved["revision"], before["revision"].as_u64().unwrap() + 1);
        assert_eq!(saved["assets"][1]["thumbnailPath"], thumbnail);
        assert!(saved["assets"][2].get("thumbnailPath").is_none());
        assert!(is_cached(&store.root.join(thumbnail)));
        assert_eq!(fs::read(store.root.join(ORIGINAL_PATH)).unwrap(), ORIGINAL);
        assert_eq!(
            backfill(&store, &["same-original".into()]).unwrap(),
            (saved.clone(), false)
        );
        let root = store.root.clone();
        drop(store);
        assert_eq!(Store::open(root).unwrap().read().unwrap(), saved);
    }

    #[test]
    fn completed_preview_is_skipped_when_its_assets_were_removed_or_changed() {
        let (_scratch, store) = seed_store();
        let mut prepared = HashMap::new();
        let snapshot = store.read().unwrap();
        let preview = prepare(&store, &snapshot["assets"][0]).unwrap();
        let target = store.root.join(&preview.path);
        prepared.insert(ORIGINAL_PATH, Some(preview));
        let saved = store
            .change(|doc| {
                let assets = list_mut(doc, "assets")?;
                assets.remove(0);
                assets[0]["path"] = json!("assets/different.png");
                Ok(())
            })
            .unwrap();
        assert_eq!(publish(&store, &prepared).unwrap(), (saved, false));
        assert!(!target.exists());
    }
}
