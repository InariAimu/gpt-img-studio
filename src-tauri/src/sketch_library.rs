//! Editable sketches and immutable rendered references share the library's atomic metadata store.
use crate::store::{find, id, list_mut, now, text, Result, Store};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::{fs, io::Write};

fn encode(document: &Value) -> Result<Vec<u8>> {
    if !matches!(document["version"].as_u64(), Some(1 | 2)) || !document["layers"].is_array()
        || document["layers"].as_array().unwrap().len() > 200
        || ["width", "height"].iter().any(|k| !document[*k].as_u64().is_some_and(|n| (256..=4096).contains(&n)))
    { return Err("草图格式或画布尺寸无效（每边 256–4096 像素）".into()); }
    let bytes=serde_json::to_vec(document).map_err(|e|e.to_string())?;
    if bytes.len()>64*1024*1024 {return Err("草图超过 64 MB，请减少导入图片".into());}
    Ok(bytes)
}
fn write_document(store:&Store, document:&Value)->Result<String>{
    let bytes=encode(document)?;
    let path=format!("assets/{}.json",studio_sync::hash(&bytes));
    match fs::OpenOptions::new().write(true).create_new(true).open(store.root.join(&path)) {
        Ok(mut file)=>{file.write_all(&bytes).map_err(|e|e.to_string())?;file.sync_all().map_err(|e|e.to_string())?;},
        Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists=>{
            if fs::read(store.root.join(&path)).map_err(|e|e.to_string())?!=bytes{return Err("草图文件校验失败，未覆盖原文件".into());}
        },
        Err(e)=>return Err(e.to_string())
    }
    Ok(path)
}
fn record(document:&Value,path:&str)->Value{
    json!({"id":id(),"name":text(document,"name"),"createdAt":now(),"updatedAt":now(),"revision":id(),"documentPath":path,"width":document["width"],"height":document["height"],"favorite":false})
}
pub fn migrate(store:&Store)->Result<()> {
    if store.read()?["sketchLibraryMigrated"]==true{return Ok(());}
    let legacy:Option<String>=store.connection.lock().map_err(|e|e.to_string())?.query_row("SELECT document FROM sketch_state WHERE id=1",[],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let legacy=legacy.map(|v|serde_json::from_str::<Value>(&v).map_err(|e|e.to_string())).transpose()?;
    let item=legacy.as_ref().map(|v|write_document(store,v).map(|p|record(v,&p))).transpose()?;
    store.change(|doc|{
        if doc["sketchLibraryMigrated"]==true{return Ok(());}
        if !doc["sketches"].is_array(){doc["sketches"]=json!([]);}
        if let Some(item)=item{list_mut(doc,"sketches")?.push(item);}
        doc["sketchLibraries"]=json!([{ "id":"shared", "savedPoses":legacy.as_ref().and_then(|v|v.get("savedPoses")).cloned().unwrap_or(json!([])),"favoritePoses":legacy.as_ref().and_then(|v|v.get("favoritePoses")).cloned().unwrap_or(json!([])) }]);
        doc["sketchLibraryMigrated"]=json!(true);Ok(())
    })?;Ok(())
}
fn current<'a>(doc:&'a Value, sketch_id:&str, expected:&str)->Result<&'a Value>{
    let item=find(doc,"sketches",sketch_id)?;
    if item["trashedAt"].is_string(){return Err("草图已移入最近删除，请先恢复；当前编辑内容仍可导出".into());}
    if text(item,"revision")!=expected{return Err("草图已在其他窗口或设备更新；请另存副本保留当前编辑".into());}
    Ok(item)
}
pub fn load(store:&Store,sketch_id:&str)->Result<Value>{
    let doc=store.read()?;let item=find(&doc,"sketches",sketch_id)?;
    let path=text(item,"documentPath");studio_sync::blob_name(path)?;
    let bytes=fs::read(store.asset_path(&json!({"path":path}))?).map_err(|e|e.to_string())?;
    if bytes.len()>64*1024*1024||!path.ends_with(&format!("{}.json",studio_sync::hash(&bytes))){return Err("草图文件校验失败".into());}
    let mut content:Value=serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
    encode(&content)?;content["name"]=item["name"].clone();
    if let Ok(shared)=find(&doc,"sketchLibraries","shared"){
        content["savedPoses"]=shared["savedPoses"].clone();content["favoritePoses"]=shared["favoritePoses"].clone();
    }
    Ok(json!({"revision":item["revision"],"document":content,"record":item}))
}
fn update_library(doc:&mut Value,old:&Value,next:&Value)->Result<()> {
    if old.is_null(){return Ok(());}
    let library=list_mut(doc,"sketchLibraries")?.iter_mut().find(|v|v["id"]=="shared").ok_or("姿势库不存在")?;
    for key in ["savedPoses","favoritePoses"]{
        let before=old[key].as_array().ok_or("姿势库格式无效")?;
        let after=next[key].as_array().ok_or("姿势库格式无效")?;
        if before==after{continue;}
        if after.len()>500{return Err("姿势库条目过多".into());}
        let values=library[key].as_array_mut().ok_or("姿势库格式无效")?;
        let identity=|v:&Value| if key=="savedPoses" {v["id"].clone()}else{v.clone()};
        values.retain(|v| !before.iter().any(|b|identity(b)==identity(v))||after.iter().any(|a|identity(a)==identity(v)));
        for value in after{
            if before.iter().any(|b|b==value){continue;}
            values.retain(|v|identity(v)!=identity(value));values.push(value.clone());
        }
    }
    Ok(())
}
pub fn save(store:&Store,sketch_id:Option<&str>,document:&Value,expected:&str,previous_library:&Value)->Result<Value>{
    let path=write_document(store,document)?;
    let new_id=sketch_id.map(str::to_owned).unwrap_or_else(id);
    let changed=store.change(|doc|{
        if let Some(sketch_id)=sketch_id{current(doc,sketch_id,expected)?;}
        update_library(doc,previous_library,document)?;
        let items=list_mut(doc,"sketches")?;
        let mut item=if let Some(sketch_id)=sketch_id{items.iter().find(|s|s["id"]==sketch_id).unwrap().clone()}else{record(document,&path)};
        item["id"]=json!(new_id);item["name"]=json!(text(document,"name").trim().chars().take(120).collect::<String>());
        if text(&item,"name").is_empty(){item["name"]=json!("未命名草图");}
        item["documentPath"]=json!(path);item["width"]=document["width"].clone();item["height"]=document["height"].clone();
        item["revision"]=json!(id());item["updatedAt"]=json!(now());
        items.retain(|s|s["id"]!=new_id);items.push(item);Ok(())
    })?;
    Ok(json!({"sketchId":new_id,"record":find(&changed,"sketches",&new_id)?,"document":changed}))
}
pub fn preview(store:&Store,sketch_id:&str,expected:&str,png:&str)->Result<Value>{
    let doc=store.read()?;let item=current(&doc,sketch_id,expected)?;
    if png.len()>96*1024*1024{return Err("预览图片过大".into());}
    let bytes=STANDARD.decode(png).map_err(|e|e.to_string())?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n"){return Err("预览必须是 PNG".into());}
    let image=store.save_image(&bytes,text(item,"name"))?;
    if image["width"]!=item["width"]||image["height"]!=item["height"]{return Err("预览尺寸与草图不一致".into());}
    store.change(|doc|{
        current(doc,sketch_id,expected)?;
        let item=list_mut(doc,"sketches")?.iter_mut().find(|s|s["id"]==sketch_id).unwrap();
        item["previewPath"]=image["path"].clone();item["thumbnailPath"]=image["thumbnailPath"].clone();item["previewRevision"]=item["documentPath"].clone();Ok(())
    })
}
pub fn snapshot(store:&Store,sketch_id:&str,expected:&str)->Result<Value>{
    let mut asset_id=String::new();
    let changed=store.change(|doc|{
        let item=current(doc,sketch_id,expected)?.clone();
        if item["previewRevision"]!=item["documentPath"]||!item["previewPath"].is_string(){return Err("草图画面正在更新，请稍后重试".into());}
        if let Some(asset)=doc["assets"].as_array().unwrap().iter().find(|a|a["sketchId"]==sketch_id&&a["sketchRevision"]==item["documentPath"]){asset_id=text(asset,"id").into();return Ok(());}
        asset_id=id();
        list_mut(doc,"assets")?.push(json!({"id":asset_id,"title":item["name"],"path":item["previewPath"],"thumbnailPath":item["thumbnailPath"],"mime":"image/png","width":item["width"],"height":item["height"],"createdAt":now(),"workspaceId":"","sessionId":"","originalPrompt":"","submittedPrompt":"","referenceIds":[],"model":"草图快照","size":format!("{}x{}",item["width"],item["height"]),"quality":"original","groupId":asset_id,"favorite":false,"isReference":false,"referenceOnly":true,"demo":false,"sketchId":sketch_id,"sketchRevision":item["documentPath"],"sketchSnapshot":true}));Ok(())
    })?;
    Ok(json!({"assetId":asset_id,"document":changed}))
}
/// Called in the same transaction that inserts the generation job, before any model request.
pub fn promote(doc:&mut Value,reference_ids:&[String])->Result<()> {
    for reference_id in reference_ids{find(doc,"assets",reference_id)?;}
    for asset in list_mut(doc,"assets")?{
        if asset["sketchSnapshot"]==true&&reference_ids.iter().any(|id|asset["id"]==*id){asset["isReference"]=json!(true);asset["sketchPromotedAt"]=json!(now());}
    }Ok(())
}
pub fn action(doc:&mut Value,action:&Value)->Result<()> {
    let ids=action["ids"].as_array().ok_or("请选择草图")?;
    if ids.is_empty(){return Err("请选择草图".into());}
    for value in ids{find(doc,"sketches",value.as_str().ok_or("草图 ID 无效")?)?;}
    let op=text(action,"operation");
    if !["rename","trash","restore","favorite","duplicate"].contains(&op){return Err("草图操作无效".into());}
    let items=list_mut(doc,"sketches")?;let mut copies=Vec::new();
    for item in items.iter_mut().filter(|s|ids.contains(&s["id"])){
        match op{
            "rename"=>{let name=text(action,"name").trim();if name.is_empty()||name.chars().count()>120{return Err("名称需要 1–120 个字符".into());}item["name"]=json!(name);},
            "trash"=>item["trashedAt"]=json!(now()),
            "restore"=>{item.as_object_mut().unwrap().remove("trashedAt");},
            "favorite"=>item["favorite"]=json!(action["favorite"]==true),
            "duplicate"=>{let mut copy=item.clone();copy["id"]=json!(id());copy["name"]=json!(format!("{} 副本",text(item,"name").chars().take(110).collect::<String>()));copy["createdAt"]=json!(now());copy["revision"]=json!(id());copy["updatedAt"]=json!(now());copy.as_object_mut().unwrap().remove("trashedAt");copies.push(copy);continue;},_=>unreachable!()
        }
        if op!="favorite"{item["revision"]=json!(id());item["updatedAt"]=json!(now());}
    }
    items.extend(copies);Ok(())
}
#[tauri::command]
pub fn load_library_sketch(store:tauri::State<'_,Store>,sketch_id:String)->Result<Value>{load(&store,&sketch_id)}
#[tauri::command]
pub fn save_library_sketch(app:tauri::AppHandle,store:tauri::State<'_,Store>,sketch_id:Option<String>,document:Value,expected_revision:String,previous_library:Value)->Result<Value>{
    let _op=store.operation()?;let result=save(&store,sketch_id.as_deref(),&document,&expected_revision,&previous_library)?;crate::changed(&app,result["document"].clone());Ok(result)
}
#[tauri::command]
pub fn save_sketch_preview(app:tauri::AppHandle,store:tauri::State<'_,Store>,sketch_id:String,expected_revision:String,png:String)->Result<Value>{
    let _op=store.operation()?;Ok(crate::changed(&app,preview(&store,&sketch_id,&expected_revision,&png)?))
}
#[tauri::command]
pub fn select_sketch_reference(app:tauri::AppHandle,store:tauri::State<'_,Store>,sketch_id:String,expected_revision:String)->Result<Value>{
    let _op=store.operation()?;let result=snapshot(&store,&sketch_id,&expected_revision)?;crate::changed(&app,result["document"].clone());Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store()->Store {
        let root=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("output/sketch-library-20261111/tests").join(id());
        Store::open(root).unwrap()
    }
    fn content()->Value{json!({"version":2,"name":"构图 A","width":256,"height":256,"background":"#ffffff","layers":[],"savedPoses":[],"favoritePoses":[]})}
    fn png()->String{
        let mut out=std::io::Cursor::new(Vec::new());image::DynamicImage::new_rgba8(256,256).write_to(&mut out,image::ImageFormat::Png).unwrap();STANDARD.encode(out.into_inner())
    }
    #[test]
    fn library_migration_preserves_legacy_once_and_global_poses(){
        let store=store();let mut old=content();old["favoritePoses"]=json!(["standing"]);
        store.connection.lock().unwrap().execute("INSERT INTO sketch_state VALUES(1,7,?1)",[old.to_string()]).unwrap();
        store.change(|d|{d["sketchLibraryMigrated"]=json!(false);Ok(())}).unwrap();migrate(&store).unwrap();migrate(&store).unwrap();
        let doc=store.read().unwrap();assert_eq!(doc["sketches"].as_array().unwrap().len(),1);assert_eq!(doc["sketchLibraries"][0]["favoritePoses"],json!(["standing"]));
        let loaded=load(&store,text(&doc["sketches"][0],"id")).unwrap();assert_eq!(loaded["document"],old);
    }
    #[test]
    fn library_snapshots_are_immutable_promoted_on_generation_and_survive_source_changes(){
        let store=store();let original=content();let created=save(&store,None,&original,"",&Value::Null).unwrap();let sketch_id=text(&created,"sketchId");let revision=text(&created["record"],"revision");
        preview(&store,sketch_id,revision,&png()).unwrap();let first=snapshot(&store,sketch_id,revision).unwrap();let asset_id=text(&first,"assetId").to_owned();
        assert_eq!(snapshot(&store,sketch_id,revision).unwrap()["assetId"],first["assetId"]);
        assert_eq!(find(&first["document"],"assets",&asset_id).unwrap()["isReference"],false);
        store.change(|doc|{promote(doc,&[asset_id.clone()])?;list_mut(doc,"jobs")?.push(json!({"id":"test-job","sessionId":"demo-material","status":"completed","referenceIds":[asset_id]}));Ok(())}).unwrap();
        let before=find(&store.read().unwrap(),"assets",&asset_id).unwrap().clone();assert_eq!(before["isReference"],true);
        let mut changed=original.clone();changed["background"]=json!("#000000");save(&store,Some(sketch_id),&changed,revision,&original).unwrap();
        assert!(save(&store,Some(sketch_id),&original,revision,&original).is_err());assert!(preview(&store,sketch_id,revision,&png()).is_err());
        store.change(|d|action(d,&json!({"ids":[sketch_id],"operation":"trash"}))).unwrap();
        let doc=store.read().unwrap();assert_eq!(find(&doc,"assets",&asset_id).unwrap(),&before);assert!(store.asset_path(&before).unwrap().is_file());
        store.change(|d|action(d,&json!({"ids":[sketch_id],"operation":"restore"}))).unwrap();
        assert_eq!(load(&store,sketch_id).unwrap()["document"]["background"],"#000000");
    }
    #[test]
    fn library_copy_rename_and_shared_pose_deltas_do_not_overwrite_other_documents(){
        let store=store();let original=content();let a=save(&store,None,&original,"",&Value::Null).unwrap();let aid=text(&a,"sketchId");
        let mut edited=original.clone();edited["favoritePoses"]=json!(["sit"]);save(&store,Some(aid),&edited,text(&a["record"],"revision"),&original).unwrap();
        let b=save(&store,None,&original,"",&Value::Null).unwrap();assert_eq!(load(&store,text(&b,"sketchId")).unwrap()["document"]["favoritePoses"],json!(["sit"]));
        store.change(|d|action(d,&json!({"ids":[aid],"operation":"duplicate"}))).unwrap();
        store.change(|d|action(d,&json!({"ids":[aid],"operation":"rename","name":"新版"}))).unwrap();
        let doc=store.read().unwrap();assert_eq!(doc["sketches"].as_array().unwrap().len(),3);assert_eq!(load(&store,aid).unwrap()["document"]["name"],"新版");
        assert!(doc["sketches"].as_array().unwrap().iter().any(|s|s["name"]=="构图 A 副本"));
    }
}
