import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { desktop } from '../useStudio';
import { validateSketch, type SketchDocument } from './model';

interface SavedSketch { revision:number; document:SketchDocument|null }
export function pngBlob(dataUrl:string):Blob {
  const bytes=Uint8Array.from(atob(dataUrl.split(',')[1]),c=>c.charCodeAt(0));
  return new Blob([bytes],{type:'image/png'});
}
async function database(){
  return new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open('image-studio-sketch',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('sketch');
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
export async function loadSketch():Promise<SavedSketch>{
  let value:SavedSketch;
  if(desktop)value=await invoke<SavedSketch>('load_sketch');
  else {const db=await database();try{value=await new Promise<SavedSketch>((resolve,reject)=>{const r=db.transaction('sketch').objectStore('sketch').get('current');r.onsuccess=()=>resolve(r.result??{revision:0,document:null});r.onerror=()=>reject(r.error);});}finally{db.close();}}
  return {...value,document:value.document?validateSketch(value.document):null};
}
export async function saveSketch(document:SketchDocument,expectedRevision:number):Promise<number>{
  validateSketch(document);
  if(desktop)return invoke<number>('save_sketch',{document,expectedRevision});
  const db=await database();try{return await new Promise<number>((resolve,reject)=>{
    const tx=db.transaction('sketch','readwrite'),store=tx.objectStore('sketch'),read=store.get('current');let conflict=false;
    read.onsuccess=()=>{if((read.result?.revision??0)!==expectedRevision){conflict=true;tx.abort();return;}store.put({revision:expectedRevision+1,document},'current');};
    tx.oncomplete=()=>resolve(expectedRevision+1);tx.onabort=()=>reject(new Error(conflict?'草图已被另一窗口更新，请导出后重新载入。':'草图保存失败，请导出备份。'));tx.onerror=()=>reject(tx.error);
  });}finally{db.close();}
}
export async function exportFile(name:string,data:string,kind:'json'|'png'){
  const filename=name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,80)||'草图';
  if(desktop){
    const destination=await save({title:kind==='png'?'导出草图 PNG':'保存可编辑草图',defaultPath:`${filename}.${kind==='json'?'sketch.json':'png'}`,filters:[{name:kind==='png'?'PNG 图片':'可编辑草图',extensions:[kind]}]});
    if(!destination)return false;
    await invoke('export_sketch_file',{destination,data:kind==='png'?data.split(',')[1]:data,kind});
  }else{
    const blob=kind==='json'?new Blob([data],{type:'application/json'}):pngBlob(data);
    const url=URL.createObjectURL(blob),a=window.document.createElement('a');a.href=url;a.download=`${filename}.${kind==='json'?'sketch.json':'png'}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return true;
}
export async function importPicture(file:File):Promise<{src:string;width:number;height:number}>{
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>20*1024*1024)throw new Error('请选择 20 MB 以内的 PNG、JPEG 或 WebP 图片。');
  const bitmap=await createImageBitmap(file);
  try{
    const scale=Math.min(1,2048/Math.max(bitmap.width,bitmap.height));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    canvas.getContext('2d')!.drawImage(bitmap,0,0,canvas.width,canvas.height);
    const src=canvas.toDataURL('image/png');if(src.length>16000000)throw new Error('图片内容过大，请缩小后重试。');return {src,width:canvas.width,height:canvas.height};
  }finally{bitmap.close();}
}
