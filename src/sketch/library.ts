import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import type { Studio } from '../useStudio';
import type { SketchRecord, StudioDocument } from '../types';
import { initialSketch, validateSketch, type SketchDocument } from './model';

export interface LoadedSketch {revision:string;document:SketchDocument;record:SketchRecord}
interface SavedResult {sketchId:string;record:SketchRecord;document:StudioDocument}
export function sketchUrl(studio:Studio,item:SketchRecord){
  const path=item.thumbnailPath||item.previewPath;
  return path?(path.startsWith('data:')?path:convertFileSrc(`${studio.dataDir}/${path}`)):'';
}
export async function loadLibrarySketch(studio:Studio,id:string):Promise<LoadedSketch>{
  const result=await command<LoadedSketch>(studio,'load_library_sketch',{sketchId:id});
  const document=validateSketch(result.document);
  const shared=studio.document.sketchLibraries?.find(l=>l.id==='shared');
  return {...result,document:shared?{...document,savedPoses:shared.savedPoses,favoritePoses:shared.favoritePoses}:document};
}
export async function saveLibrarySketch(studio:Studio,id:string|null,document:SketchDocument,revision='',previousLibrary:SketchDocument|null=null){
  validateSketch(document);
  const result=await command<SavedResult>(studio,'save_library_sketch',{sketchId:id,document,expectedRevision:revision,previousLibrary:previousLibrary?{savedPoses:previousLibrary.savedPoses,favoritePoses:previousLibrary.favoritePoses}:null});
  studio.accept(result.document);return result;
}
export async function createSketch(studio:Studio,document=initialSketch()){
  const library=studio.document.sketchLibraries?.find(l=>l.id==='shared');
  if(library)document={...document,savedPoses:[...new Map([...library.savedPoses,...document.savedPoses].map(p=>[p.id,p])).values()],favoritePoses:[...new Set([...library.favoritePoses,...document.favoritePoses])]};
  return saveLibrarySketch(studio,null,document,'',{...document,savedPoses:[],favoritePoses:[]});
}
// Share pending renders between the library, editor, and reference picker. Never render a canvas per card.
const previews=new Map<string,Promise<SketchRecord>>();
export function ensurePreview(studio:Studio,item:SketchRecord):Promise<SketchRecord>{
  if(item.previewPath&&item.previewRevision===item.documentPath)return Promise.resolve(item);
  const key=`${item.id}:${item.revision}`;
  if(previews.has(key))return previews.get(key)!;
  const promise=(async()=>{
    const loaded=await loadLibrarySketch(studio,item.id);
    if(loaded.revision!==item.revision)throw new Error('草图已更新，请重试');
    const {renderDocument}=await import('./renderDocument');const png=await renderDocument(loaded.document);
    const document=await command<StudioDocument>(studio,'save_sketch_preview',{sketchId:item.id,expectedRevision:loaded.revision,png:png.split(',')[1]});
    studio.accept(document);return document.sketches!.find(s=>s.id===item.id)!;
  })().finally(()=>previews.delete(key));previews.set(key,promise);return promise;
}
export async function selectSketchReference(studio:Studio,item:SketchRecord){
  const ready=await ensurePreview(studio,item);
  const result=await command<{assetId:string;document:StudioDocument}>(studio,'select_sketch_reference',{sketchId:ready.id,expectedRevision:ready.revision});
  studio.accept(result.document);return result.assetId;
}
async function command<T>(studio:Studio,name:string,args:Record<string,unknown>):Promise<T>{
  return isTauri()?invoke<T>(name,args):browserCommand(name,args,studio.document) as Promise<T>;
}

// Keep the existing browser-only sketch experience local and persistent as well.
async function db(){return new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('image-studio-sketch',1);r.onupgradeneeded=()=>r.result.createObjectStore('sketch');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function readLocal(){const database=await db();try{return await new Promise<any>((resolve,reject)=>{const r=database.transaction('sketch').objectStore('sketch').get('library');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}finally{database.close();}}
async function writeLocal(value:unknown){const database=await db();try{await new Promise<void>((resolve,reject)=>{const t=database.transaction('sketch','readwrite');t.objectStore('sketch').put(value,'library');t.oncomplete=()=>resolve();t.onabort=t.onerror=()=>reject(t.error);});}finally{database.close();}}
let browserQueue=Promise.resolve();
export async function browserLibrary(document:StudioDocument){
  let local=await readLocal();
  if(!local){
    const database=await db();const legacy=await new Promise<any>((resolve,reject)=>{const r=database.transaction('sketch').objectStore('sketch').get('current');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);}).finally(()=>database.close());
    local={sketches:[],sketchLibraries:[{id:'shared',savedPoses:legacy?.document?.savedPoses??[],favoritePoses:legacy?.document?.favoritePoses??[]}],assets:[],contents:{},revision:document.revision};
    if(legacy?.document){const d=validateSketch(legacy.document),id=crypto.randomUUID(),path=crypto.randomUUID(),at=new Date().toISOString();local.contents[path]=d;local.sketches.push({id,name:d.name,documentPath:path,revision:crypto.randomUUID(),width:d.width,height:d.height,createdAt:at,updatedAt:at,favorite:false});}
    await writeLocal(local);
  }
  return {...document,revision:Math.max(document.revision,local.revision),sketches:local.sketches,sketchLibraries:local.sketchLibraries,assets:[...document.assets.filter(a=>!a.sketchSnapshot),...local.assets]} as StudioDocument;
}
export function browserCommand(name:string,args:any,document:StudioDocument):Promise<unknown>{
  const task=browserQueue.then(async()=>{
    await browserLibrary(document);const local=await readLocal();const doc=await browserLibrary(document);
    const item=doc.sketches!.find(s=>s.id===args.sketchId),at=new Date().toISOString();
    if(name==='load_library_sketch'){
      if(!item)throw new Error('草图不存在');const shared=doc.sketchLibraries![0];
      return {record:item,revision:item.revision,document:{...local.contents[item.documentPath],name:item.name,savedPoses:shared.savedPoses,favoritePoses:shared.favoritePoses}};
    }
    if(item&&args.expectedRevision&&item.revision!==args.expectedRevision)throw new Error('草图已更新，请另存副本');
    let extra:Record<string,unknown>={};
    if(name==='save_library_sketch'){
      if(args.sketchId&&(!item||item.trashedAt))throw new Error('草图不存在或已删除');
      const content=validateSketch(args.document),path=crypto.randomUUID();local.contents[path]=content;
      const record:SketchRecord={...(item??{id:crypto.randomUUID(),createdAt:at,favorite:false}),name:content.name.trim()||'未命名草图',updatedAt:at,revision:crypto.randomUUID(),documentPath:path,width:content.width,height:content.height};
      doc.sketches=[...doc.sketches!.filter(s=>s.id!==record.id),record];extra={record,sketchId:record.id};
      if(args.previousLibrary)for(const key of ['savedPoses','favoritePoses'] as const)if(JSON.stringify(args.previousLibrary[key])!==JSON.stringify(content[key]))doc.sketchLibraries![0][key]=content[key] as any;
    }else if(name==='save_sketch_preview'){
      if(!item||item.trashedAt)throw new Error('草图不存在或已删除');item.previewPath=`data:image/png;base64,${args.png}`;item.previewRevision=item.documentPath;
    }else if(name==='select_sketch_reference'){
      if(!item||item.trashedAt||!item.previewPath||item.previewRevision!==item.documentPath)throw new Error('草图画面尚未准备好');
      let asset=doc.assets.find(a=>a.sketchId===item.id&&a.sketchRevision===item.documentPath);
      if(!asset){const id=crypto.randomUUID();asset={id,title:item.name,path:item.previewPath,mime:'image/png',width:item.width,height:item.height,createdAt:at,workspaceId:'',sessionId:'',originalPrompt:'',submittedPrompt:'',referenceIds:[],model:'草图快照',size:`${item.width}x${item.height}`,quality:'original',groupId:id,favorite:false,isReference:false,referenceOnly:true,demo:false,sketchSnapshot:true,sketchId:item.id,sketchRevision:item.documentPath};doc.assets.push(asset);}
      extra={assetId:asset.id};
    }else if(name==='sketch_action'){
      for(const item of doc.sketches!.filter(s=>args.ids.includes(s.id))){
        if(args.operation==='duplicate'){doc.sketches!.push({...item,id:crypto.randomUUID(),name:`${item.name} 副本`,revision:crypto.randomUUID(),createdAt:at,updatedAt:at,trashedAt:undefined});continue;}
        if(args.operation==='trash')item.trashedAt=at;
        if(args.operation==='restore')delete item.trashedAt;
        if(args.operation==='rename'){if(!args.name.trim())throw new Error('请输入名称');item.name=args.name.trim();}
        if(args.operation==='favorite')item.favorite=args.favorite;else{item.revision=crypto.randomUUID();item.updatedAt=at;}
      }
    }else throw new Error('不支持的草图操作');
    doc.revision++;await writeLocal({...local,sketches:doc.sketches,sketchLibraries:doc.sketchLibraries,assets:doc.assets.filter(a=>a.sketchSnapshot),revision:doc.revision});
    return ['save_sketch_preview','sketch_action'].includes(name)?doc:{...extra,document:doc};
  });browserQueue=task.then(()=>{},()=>{});return task;
}
