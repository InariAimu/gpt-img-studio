//! The first sketch is local-only and lives alongside the library in SQLite.
use crate::store::{Result, Store};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

pub fn init(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS sketch_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, document TEXT NOT NULL);").map_err(|e|e.to_string())
}
fn encoded(document: &Value) -> Result<String> {
    if !matches!(document["version"].as_u64(), Some(1 | 2)) || !document["layers"].is_array() || document["layers"].as_array().unwrap().len()>200 {
        return Err("草图格式无效或版本不受支持".into());
    }
    let value=serde_json::to_string(document).map_err(|e|e.to_string())?;
    if value.len()>64*1024*1024 {return Err("草图超过 64 MB，请减少导入图片".into());}
    Ok(value)
}
fn save(connection: &mut Connection, document:&Value, expected_revision:i64)->Result<i64>{
    let data=encoded(document)?;
    let tx=connection.transaction().map_err(|e|e.to_string())?;
    let revision=tx.query_row("SELECT revision FROM sketch_state WHERE id=1",[],|r|r.get::<_,i64>(0)).optional().map_err(|e|e.to_string())?.unwrap_or(0);
    if revision!=expected_revision{return Err("草图已被另一窗口更新，请先导出当前草图，再重新打开应用".into());}
    tx.execute("INSERT INTO sketch_state(id,revision,document) VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,document=excluded.document",params![revision+1,data]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;Ok(revision+1)
}
#[tauri::command]
pub fn load_sketch(store:tauri::State<'_,Store>)->Result<Value>{
    let connection=store.connection.lock().map_err(|e|e.to_string())?;
    let row=connection.query_row("SELECT revision,document FROM sketch_state WHERE id=1",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?))).optional().map_err(|e|e.to_string())?;
    match row {Some((revision,data))=>Ok(json!({"revision":revision,"document":serde_json::from_str::<Value>(&data).map_err(|e|format!("草图读取失败：{e}"))?})),None=>Ok(json!({"revision":0,"document":null}))}
}
#[tauri::command]
pub fn save_sketch(store:tauri::State<'_,Store>,document:Value,expected_revision:i64)->Result<i64>{
    let _operation=store.operation()?;
    let mut connection=store.connection.lock().map_err(|e|e.to_string())?;
    save(&mut connection,&document,expected_revision)
}
#[tauri::command]
pub fn export_sketch_file(destination:PathBuf,data:String,kind:String)->Result<()> {
    if !destination.is_absolute(){return Err("请选择有效的导出路径".into());}
    let extension=destination.extension().and_then(|v|v.to_str()).unwrap_or("").to_ascii_lowercase();
    let bytes=match kind.as_str(){
        "json" if extension=="json"=>{let document:Value=serde_json::from_str(&data).map_err(|e|e.to_string())?;encoded(&document)?.into_bytes()},
        "png" if extension=="png"=>{if data.len()>96*1024*1024{return Err("导出图片过大".into());}let bytes=STANDARD.decode(data).map_err(|e|e.to_string())?;if !bytes.starts_with(b"\x89PNG\r\n\x1a\n"){return Err("导出内容不是 PNG".into());}bytes},
        _=>return Err("请选择 .png 或 .json 文件".into())
    };
    fs::write(destination,bytes).map_err(|e|format!("导出失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sketch_saves_are_atomic_and_reject_stale_writers(){
        let mut c=Connection::open_in_memory().unwrap();init(&c).unwrap();
        c.execute_batch("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('keep');").unwrap();
        let first=json!({"version":1,"layers":[],"name":"first"});
        assert_eq!(save(&mut c,&first,0).unwrap(),1);
        assert!(save(&mut c,&json!({"version":1,"layers":[],"name":"stale"}),0).is_err());
        assert!(save(&mut c,&json!({"version":3,"layers":[]}),1).is_err());
        let saved:String=c.query_row("SELECT document FROM sketch_state",[],|r|r.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(),first);
        assert_eq!(c.query_row("SELECT value FROM unrelated",[],|r|r.get::<_,String>(0)).unwrap(),"keep");
        let upgraded=json!({"version":2,"layers":[],"savedPoses":[],"favoritePoses":[]});
        assert_eq!(save(&mut c,&upgraded,1).unwrap(),2);
        let stored:String=c.query_row("SELECT document FROM sketch_state",[],|r|r.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(),upgraded);
    }
}
