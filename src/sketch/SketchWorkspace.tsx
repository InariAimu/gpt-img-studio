import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ArrowDown, ArrowUp, ArrowUpRight, Box, Check, Circle, Copy, Download, Eye, EyeOff, FilePlus2, FolderOpen, Hand, ImagePlus, LockKeyhole, MousePointer2, Move3d, MoveUpRight, Orbit, Pencil, Redo2, Rotate3d, RotateCw, Save, Scan, Square, Trash2, Type, Undo2, UnlockKeyhole, ZoomIn, ZoomOut } from 'lucide-react';
import { desktop, type Studio } from '../useStudio';
import { Modal } from '../components';
import notices from './third-party-notices.txt?raw';
import humanoidLicense from './assets/LICENSE-CC0.txt?raw';
import SketchCanvas, { type CanvasHandle } from './SketchCanvas';
import { constrainPose, duplicateEntity, entityDefaults, entityKinds, MAX_ENTITIES, MAX_FIGURES, removeEntity, updateEntity, initialSketch, jointAxis, layerDefaults, sceneDefaults, uid, validateSketch, type EntityKind, type FigureEntity, type Joint, type SceneData, type SceneEntity, type SceneSelection, type SketchDocument, type SketchLayer, type Tool } from './model.ts';
import { EntityInspector } from './EntityInspector';
import { PoseLibrary } from './PoseLibrary';
import { applyPreset, type PosePreset } from './poses.ts';
import { exportFile, importPicture, pngBlob } from './storage';
import './sketch.css';
import CanvasSize from './CanvasSize';
import { createSketch, loadLibrarySketch, saveLibrarySketch, ensurePreview } from './library';
import type { SketchRecord } from '../types';

function Range({label,value,min,max,step=1,onChange,onCommit}:{label:string;value:number;min:number;max:number;step?:number;onChange:(v:number)=>void;onCommit:()=>void}){
  return <label className="sketch-range"><span>{label}</span><input aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(Number(e.target.value))} onPointerUp={onCommit} onKeyUp={onCommit} onBlur={onCommit}/><output>{Number(value.toFixed(2))}</output></label>;
}
function Color({label,value,onChange,transparent=false}:{label:string;value:string;onChange:(v:string)=>void;transparent?:boolean}){
  return <div className="sketch-color"><label><span>{label}</span><input type="color" aria-label={label} value={value==='transparent'?'#ffffff':value} onChange={e=>onChange(e.target.value)}/></label>{transparent&&<label className="sketch-check"><input type="checkbox" checked={value==='transparent'} onChange={e=>onChange(e.target.checked?'transparent':'#ffffff')}/>透明</label>}</div>;
}
function IconButton({label,children,onClick,disabled=false}:{label:string;children:ReactNode;onClick:()=>void;disabled?:boolean}){return <button className="icon-button" title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>;}

export default function SketchWorkspace({studio,active,sketchId,onBack,onOpenId}:{studio:Studio;active:boolean;sketchId:string;onBack:()=>void;onOpenId:(id:string)=>void}){
  const studioRef=useRef(studio);studioRef.current=studio;
  const lastSaved=useRef<SketchDocument|null>(null),lastRecord=useRef<SketchRecord|null>(null),previewTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const [previewError,setPreviewError]=useState('');
  const [doc,setDoc]=useState<SketchDocument|null>(null),[loadError,setLoadError]=useState(''),[reload,setReload]=useState(0);
  const [selected,setSelected]=useState<string|null>(null),[tool,setTool]=useState<Tool>('select'),[color,setColor]=useState('#ed783e'),[lineWidth,setLineWidth]=useState(5);
  const [saveStatus,setSaveStatus]=useState('已保存'),[busy,setBusy]=useState(false),[historyState,setHistoryState]=useState({undo:0,redo:0}),[part,setPart]=useState<'entities'|'ground'|'camera'>('entities'),[joint,setJoint]=useState<Joint>('leftArm');
  const [showLicenses,setShowLicenses]=useState(false),[showPoses,setShowPoses]=useState(false);
  const [sceneSelection,setSceneSelection]=useState<SceneSelection|null>(null),[axes,setAxes]=useState(true),[grid,setGrid]=useState(true);
  const live=useRef<SketchDocument|null>(null),committed=useRef<SketchDocument|null>(null),revision=useRef(''),queue=useRef(Promise.resolve()),pending=useRef(0),saveError=useRef('');
  const undo=useRef<SketchDocument[]>([]),redo=useRef<SketchDocument[]>([]),canvas=useRef<CanvasHandle>(null),imageInput=useRef<HTMLInputElement>(null),fileInput=useRef<HTMLInputElement>(null);
  const report=studio.report;
  const chooseTool=useCallback((next:Tool)=>{setTool(next);if(['move3d','bend','tilt','twist','orbit'].includes(next)){const layer=live.current?.layers.find(l=>l.kind==='scene');if(layer)setSelected(layer.id);if(next==='orbit'){setPart('camera');setSceneSelection(null);}}},[]);
  const pickScene=useCallback((value:SceneSelection|null)=>{setSceneSelection(value);if(value){setPart('entities');if(value.joint)setJoint(value.joint);}},[]);
  const refreshPreview=useCallback(async()=>{
    const record=lastRecord.current;if(!record)return;
    try{await ensurePreview(studioRef.current,record);setPreviewError('');}catch(e){if(lastRecord.current?.revision===record.revision)setPreviewError(String(e));}
  },[]);
  const persist=useCallback((next:SketchDocument)=>{
    pending.current++;setSaveStatus('保存中…');
    queue.current=queue.current.then(async()=>{
      const result=await saveLibrarySketch(studioRef.current,sketchId,next,revision.current,lastSaved.current);
      revision.current=result.record.revision;lastRecord.current=result.record;lastSaved.current=next;saveError.current='';
      if(previewTimer.current)clearTimeout(previewTimer.current);previewTimer.current=setTimeout(()=>void refreshPreview(),900);
    }).catch(e=>{saveError.current=String(e);report(e);}).finally(()=>{pending.current--;setSaveStatus(saveError.current?'保存失败':pending.current?'保存中…':'已保存');});
  },[sketchId,report,refreshPreview]);
  useEffect(()=>{
    let stopped=false;setLoadError('');
    loadLibrarySketch(studioRef.current,sketchId).then(saved=>{if(stopped)return;revision.current=saved.revision;lastRecord.current=saved.record;lastSaved.current=saved.document;const d=saved.document;live.current=d;committed.current=d;setDoc(d);setSelected(d.layers.find(l=>l.kind==='scene')?.id??null);}).catch(e=>{if(!stopped)setLoadError(String(e));});
    return()=>{stopped=true;if(previewTimer.current)clearTimeout(previewTimer.current);};
  },[reload,sketchId]);
  const commit=useCallback(()=>{
    const next=live.current,previous=committed.current;if(!next||!previous||next===previous)return;
    try{validateSketch(next);}catch(e){live.current=previous;setDoc(previous);report(e);return;}
    undo.current=[...undo.current.slice(-49),previous];redo.current=[];committed.current=next;setHistoryState({undo:undo.current.length,redo:0});persist(next);
  },[persist,report]);
  const flush=useCallback(async()=>{commit();await queue.current;if(saveError.current)throw new Error(saveError.current);if(previewTimer.current)clearTimeout(previewTimer.current);await refreshPreview();},[commit,refreshPreview]);
  useEffect(()=>studio.registerSketchEditor(sketchId,flush),[studio.registerSketchEditor,sketchId,flush]);
  useEffect(()=>{if(!active)void flush().then(onBack).catch(report);},[active,flush,report]);
  async function back(){setBusy(true);try{await flush();onBack();}catch(e){report(e);}finally{setBusy(false);}}
  async function newSketch(copy=false){setBusy(true);try{if(!copy)await flush();const result=await createSketch(studioRef.current,copy&&live.current?{...live.current,name:`${live.current.name.slice(0,110)} 副本`}:initialSketch());onOpenId(result.sketchId);}catch(e){report(e);}finally{setBusy(false);}}
  const edit=useCallback((update:(d:SketchDocument)=>SketchDocument,save=false)=>{if(!live.current)return;const next=update(live.current);live.current=next;setDoc(next);if(save)commit();},[commit]);
  const travel=useCallback((back:boolean)=>{
    commit();const from=back?undo:redo,to=back?redo:undo;const next=from.current.pop();if(!next||!live.current)return;
    to.current.push(live.current);live.current=next;committed.current=next;setDoc(next);setHistoryState({undo:undo.current.length,redo:redo.current.length});persist(next);
  },[commit,persist]);
  useEffect(()=>{
    const before=(e:BeforeUnloadEvent)=>{if(pending.current||saveError.current){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',before);
    let stopped=false,unlisten:(()=>void)|undefined;
    if(desktop)void getCurrentWindow().onCloseRequested(async event=>{commit();if(pending.current||saveError.current){event.preventDefault();await queue.current;if(saveError.current)report('草图尚未保存，请先重试保存或导出备份。');else await getCurrentWindow().close();}}).then(fn=>{if(stopped)fn();else unlisten=fn;});
    return()=>{stopped=true;unlisten?.();window.removeEventListener('beforeunload',before);commit();};
  },[commit,report]);
  const selectedLayer=doc?.layers.find(l=>l.id===selected);
  const scene=selectedLayer?.scene;
  const entity=part==='entities'?scene?.entities.find(e=>e.id===sceneSelection?.entityId):undefined;
  function patch(value:Partial<SketchLayer>,save=true){if(!selectedLayer||selectedLayer.locked)return;edit(d=>({...d,layers:d.layers.map(l=>l.id===selected?{...l,...value}:l)}),save);}
  function sceneChange(update:(s:SceneData)=>SceneData,save=false){if(selectedLayer?.scene&&!selectedLayer.locked)patch({scene:update(selectedLayer.scene)},save);}
  const remove=useCallback(()=>{
    const layer=live.current?.layers.find(l=>l.id===selected);if(!layer||layer.locked)return;
    if(layer.scene){
      if(!sceneSelection)return;
      edit(d=>({...d,layers:d.layers.map(l=>l.id===layer.id?{...l,scene:removeEntity(l.scene!,sceneSelection.entityId)}:l)}),true);setSceneSelection(null);
    }else{edit(d=>({...d,layers:d.layers.filter(l=>l.id!==selected)}),true);setSelected(null);}
  },[selected,sceneSelection,edit]);
  function removeLayer(){if(!selectedLayer||selectedLayer.locked)return;edit(d=>({...d,layers:d.layers.filter(l=>l.id!==selected)}),true);setSelected(null);setSceneSelection(null);}
  function selectEntity(id:string){setSceneSelection({entityId:id});setPart('entities');setTool('move3d');}
  function entityChange(update:(e:SceneEntity)=>SceneEntity,save=false){if(entity)sceneChange(s=>updateEntity(s,entity.id,update),save);}
  function canAdd(s:SceneData,kind:EntityKind){
    if(s.entities.length>=MAX_ENTITIES||(kind==='figure'&&s.entities.filter(e=>e.kind==='figure').length>=MAX_FIGURES)){studio.notify(`单场景最多 ${MAX_ENTITIES} 个实体，其中人物最多 ${MAX_FIGURES} 个`);return false;}return true;
  }
  function addEntity(kind:EntityKind,preset?:PosePreset){
    if(!live.current)return;
    let layer=live.current.layers.find(l=>l.kind==='scene');if(layer?.locked)return;
    if(!layer&&live.current.layers.length>=200)return;
    const fresh=!layer;
    layer??=layerDefaults('scene',{x:0,y:0,width:live.current.width,height:live.current.height,scene:{...sceneDefaults(),entities:[]}});
    const s=layer.scene!;if(!canAdd(s,kind))return;
    const count=s.entities.filter(e=>e.kind===kind).length;
    let ordinal=1;while(s.entities.some(e=>e.name===`${entityKinds[kind]} ${ordinal}`))ordinal++;
    let next=entityDefaults(kind,`${entityKinds[kind]} ${ordinal}`);
    next.x=Math.min(18,(s.camera.targetX??0)+(count%5)*.7);next.z=Math.min(18,(s.camera.targetZ??0)+Math.floor(count/5)*.7);
    if(preset&&next.kind==='figure')next=applyPreset(next,preset);
    const changed={...layer,scene:{...s,entities:[...s.entities,next]}};
    edit(d=>({...d,layers:fresh?[...d.layers,changed]:d.layers.map(l=>l.id===changed.id?changed:l)}),true);
    setSelected(changed.id);selectEntity(next.id);
  }
  function copyEntity(){if(!entity||entity.locked||!scene||!canAdd(scene,entity.kind))return;const next=duplicateEntity(entity);sceneChange(s=>({...s,entities:[...s.entities,next]}),true);selectEntity(next.id);}
  function applyPose(preset:PosePreset){
    if(entity?.kind==='figure')entityChange(e=>e.kind==='figure'?applyPreset(e,preset):e,true);else addEntity('figure',preset);
    setShowPoses(false);
  }
  function savePose(name:string){
    if(entity?.kind!=='figure'||!doc)return;
    if(doc.savedPoses.length>=200){studio.notify('最多保存 200 个自定义姿势');return;}
    const p={id:`custom-${uid()}`,name,pose:constrainPose(structuredClone(entity.pose)),rotation:[...entity.rotation] as [number,number,number],support:entity.support==='legacy'?'ground' as const:entity.support,contacts:structuredClone(entity.contacts),height:entity.y};
    edit(d=>({...d,savedPoses:[...d.savedPoses,p]}),true);studio.notify('姿势已保存到分类姿势库的「自定义」');
  }
  const addImage=useCallback(async(file:File)=>{
    try{const picture=await importPicture(file);if(!live.current)return;if(live.current.layers.length>=200)throw new Error('最多支持 200 个图层');const factor=Math.min(1,live.current.width*.8/picture.width,live.current.height*.8/picture.height);
      const l=layerDefaults('image',{...picture,name:file.name.slice(0,120),width:picture.width*factor,height:picture.height*factor,x:(live.current.width-picture.width*factor)/2,y:(live.current.height-picture.height*factor)/2});edit(d=>({...d,layers:[...d.layers,l]}),true);setSelected(l.id);setTool('select');
    }catch(e){report(e);}
  },[edit,report]);
  useEffect(()=>{
    if(!active)return;
    const key=(e:KeyboardEvent)=>{
      if(document.querySelector('dialog[open]'))return;
      if((e.target as HTMLElement)?.closest('input,textarea,select,[contenteditable="true"]'))return;
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();travel(!e.shiftKey);}
      else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();travel(false);}
      else if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();remove();}
      else if(e.key==='Escape'){setTool('select');setSelected(null);setSceneSelection(null);}
      else if(!e.ctrlKey&&!e.metaKey&&!e.altKey){const t:Record<string,Tool>={v:'select',h:'hand',b:'pen',t:'text',r:'rect',o:'orbit',g:'move3d',z:'bend',x:'tilt',y:'twist'};if(t[e.key.toLowerCase()]){e.preventDefault();chooseTool(t[e.key.toLowerCase()]);}}
    };
    const paste=(e:ClipboardEvent)=>{if((e.target as HTMLElement)?.closest('input,textarea,[contenteditable="true"]'))return;const f=Array.from(e.clipboardData?.files??[]).find(f=>f.type.startsWith('image/'));if(f){e.preventDefault();void addImage(f);}};
    window.addEventListener('keydown',key);window.addEventListener('paste',paste);return()=>{window.removeEventListener('keydown',key);window.removeEventListener('paste',paste);};
  },[travel,remove,addImage,active,chooseTool]);
  async function exportDocument(){commit();if(!live.current)return;try{if(await exportFile(live.current.name,JSON.stringify(live.current),'json'))studio.notify('已导出可编辑草图');}catch(e){report(e);}}
  async function output(asReference=false){
    if(!doc||!canvas.current)return;commit();setBusy(true);
    try{const data=await canvas.current.exportPng();if(asReference){await studio.importClipboardImages([new File([pngBlob(data)],`${doc.name}.png`,{type:'image/png'})],'','');studio.notify('草图快照已加入参考图库，可在会话中选择使用');}else if(await exportFile(doc.name,data,'png'))studio.notify('已导出 PNG，编辑图层仍保留');}catch(e){report(e);}finally{setBusy(false);}
  }
  async function openFile(file:File){
    try{if(file.size>64*1024*1024)throw new Error('草图文件不能超过 64 MB');const next=validateSketch(JSON.parse(await file.text()));await flush();const result=await createSketch(studioRef.current,next);onOpenId(result.sketchId);studio.notify('已打开草图，可撤销回到上一个版本');}catch(e){report(e);}
  }
  function reorder(direction:number){if(!selectedLayer||selectedLayer.locked)return;edit(d=>{const layers=[...d.layers],i=layers.findIndex(l=>l.id===selected),j=i+direction;if(j<0||j>=layers.length)return d;[layers[i],layers[j]]=[layers[j],layers[i]];return {...d,layers};},true);}
  function duplicate(){if(!selectedLayer||selectedLayer.kind==='scene'||selectedLayer.locked||!doc||doc.layers.length>=200)return;const l={...selectedLayer,id:uid(),name:`${selectedLayer.name.slice(0,110)} 副本`,x:selectedLayer.x+24,y:selectedLayer.y+24};edit(d=>({...d,layers:[...d.layers,l]}),true);setSelected(l.id);}
  if(loadError)return <div className="loading-screen"><h2>草图读取失败</h2><p>{loadError}</p><button className="button secondary" onClick={()=>setReload(v=>v+1)}>重试</button></div>;
  if(!doc)return <div className="loading-screen">正在读取草图…</div>;
  const range=(label:string,value:number,min:number,max:number,onChange:(v:number)=>void,step=1)=><Range key={label} {...{label,value,min,max,onChange,step}} onCommit={commit}/>;
  const tools:[Tool,typeof Pencil,string][]=[['select',MousePointer2,'选择 V'],['hand',Hand,'平移 H'],['pen',Pencil,'画笔 B'],['text',Type,'文字 T'],['rect',Square,'方框 R'],['ellipse',Circle,'椭圆'],['arrow',MoveUpRight,'箭头']];
  const poseTools:[Tool,typeof Pencil,string,string][]=[['move3d',Move3d,'移动物件','G · 拖动物件沿地面移动，拖 XYZ 轴单轴移动'],['orbit',Orbit,'相机','O · 左键绕转，右键平移，中键或滚轮缩放'],['bend',Undo2,'弯曲','Z · 前后弯曲肢体'],['tilt',RotateCw,'侧倾','X · 向身体两侧抬起或倾斜'],['twist',Rotate3d,'扭转','Y · 沿肢体方向旋转']];
  return <div className="sketch-workspace">
    <header className="sketch-header"><div><h1><button className="sketch-back" disabled={busy} onClick={()=>void back()}>‹ 草图</button><span className="sketch-breadcrumb"> / {doc.name}</span></h1><span className={saveStatus==='保存失败'?'sketch-save-error':'muted'}>本机 · {saveStatus}</span></div><div className="sketch-actions">
      <IconButton label="新建草图" disabled={busy} onClick={()=>void newSketch()}><FilePlus2/></IconButton><IconButton label="另存副本" disabled={busy} onClick={()=>void newSketch(true)}><Copy/></IconButton>
      <IconButton label="打开草图文件" onClick={()=>fileInput.current?.click()}><FolderOpen/></IconButton>
      <IconButton label="保存可编辑草图文件" onClick={()=>void exportDocument()}><Save/></IconButton>
      <span className="sketch-separator"/><IconButton label="撤销" disabled={!historyState.undo} onClick={()=>travel(true)}><Undo2/></IconButton><IconButton label="重做" disabled={!historyState.redo} onClick={()=>travel(false)}><Redo2/></IconButton>
      <button className="button secondary small" disabled={busy} onClick={()=>void output()}><Download/>导出 PNG</button><button className="button primary small" disabled={busy||!desktop} title={desktop?'将当前画面快照加入参考图库':'请在 Windows 应用中使用'} onClick={()=>void output(true)}><ArrowUpRight/>用作参考图</button>
    </div></header>
    {saveStatus==='保存失败'&&<div className="sketch-save-banner" role="alert">草图未保存。可另存副本保留编辑，或重试保存。<button onClick={()=>persist(doc)}>重试保存</button></div>}
    {previewError&&<div className="sketch-save-banner" role="status">草图已保存，预览暂未更新。<button onClick={()=>void refreshPreview()}>重试预览</button></div>}
    <div className="sketch-layout"><aside className="sketch-tools" aria-label="绘图工具">
      <div className="sketch-add-section"><h2>添加实体</h2><div className="sketch-add-grid">{Object.entries(entityKinds).map(([kind,label])=><button className="button secondary small" key={kind} disabled={!!doc.layers.find(l=>l.kind==='scene')?.locked} onClick={()=>addEntity(kind as EntityKind)}>＋{label}</button>)}</div><button className="button secondary full" disabled={!!doc.layers.find(l=>l.kind==='scene')?.locked||!!entity?.locked} onClick={()=>setShowPoses(true)}>分类姿势库</button></div>
      <h2>工具</h2><div className="sketch-tool-grid">{tools.map(([value,Icon,label])=><button key={value} aria-pressed={tool===value} className={tool===value?'selected':''} onClick={()=>chooseTool(value)} title={label}><Icon/><span>{label.split(' ')[0]}</span></button>)}</div>
      <div className="sketch-section"><h2>3D 调整</h2><div className="sketch-tool-grid sketch-3d-tools">{poseTools.map(([value,Icon,label,help])=><button key={value} aria-label={label} aria-pressed={tool===value} className={tool===value?'selected':''} onClick={()=>chooseTool(value)} title={help}><Icon/><span>{label==='移动物件'?'移动':label}<kbd aria-hidden="true">{help[0]}</kbd></span></button>)}</div><p className="sketch-help">选工具后点击并拖动肢体。<br/>Esc 取消选中，Shift 吸附。</p><label className="sketch-check"><input type="checkbox" checked={axes} onChange={e=>setAxes(e.target.checked)}/>显示世界坐标轴</label><label className="sketch-check"><input type="checkbox" checked={grid} onChange={e=>setGrid(e.target.checked)}/>显示地面网格</label></div>

      <div className="sketch-section"><h2>画笔</h2><Color label="绘图颜色" value={color} onChange={setColor}/>{range('线宽',lineWidth,1,30,setLineWidth)}</div>
      <div className="sketch-section"><h2>添加素材</h2><button className="button secondary full" onClick={()=>imageInput.current?.click()}><ImagePlus/>导入图片</button><p className="sketch-help">也可拖入图片或 Ctrl V 粘贴</p>
        <button className="button secondary full" disabled={doc.layers.some(l=>l.kind==='scene')} onClick={()=>{const l=layerDefaults('scene',{x:0,y:0,width:doc.width,height:doc.height,scene:sceneDefaults()});edit(d=>({...d,layers:[...d.layers,l]}),true);setSelected(l.id);}}><Box/>添加 3D 场景</button>
      </div>
      <div className="sketch-section"><h2>画板</h2><label className="sketch-field">草图名称<input aria-label="草图名称" value={doc.name} maxLength={120} onChange={e=>edit(d=>({...d,name:e.target.value}))} onBlur={commit}/></label>
        <CanvasSize width={doc.width} height={doc.height} onChange={(width,height)=>{edit(d=>({...d,width,height,layers:d.layers.map(l=>l.kind==='scene'?{...l,width,height,x:0,y:0,scaleX:1,scaleY:1}:l)}),true);canvas.current?.fit();}}/><Color label="画板背景" value={doc.background} transparent onChange={background=>edit(d=>({...d,background}),true)}/>
      </div>
      <div className="sketch-zoom"><IconButton label="缩小画布" onClick={()=>canvas.current?.zoom(.8)}><ZoomOut/></IconButton><IconButton label="适应窗口" onClick={()=>canvas.current?.fit()}><Scan/></IconButton><IconButton label="放大画布" onClick={()=>canvas.current?.zoom(1.25)}><ZoomIn/></IconButton></div>
      <button className="sketch-license-link" onClick={()=>setShowLicenses(true)}>开源组件许可</button>
    </aside>
    <SketchCanvas ref={canvas} document={doc} selected={selected} sceneSelection={sceneSelection} axes={axes} grid={grid} tool={tool} color={color} lineWidth={lineWidth} onSelect={setSelected} onSceneSelect={pickScene} onEdit={edit} onCommit={commit} onTool={setTool} onError={report} onImport={file=>void addImage(file)}/>
    <aside className="sketch-inspector" aria-label="图层与属性"><div className="sketch-layers"><div className="sketch-panel-title"><h2>图层 <span>{doc.layers.length}</span></h2><div><IconButton label="图层上移" disabled={!selectedLayer||selectedLayer.locked||doc.layers.at(-1)?.id===selected} onClick={()=>reorder(1)}><ArrowUp/></IconButton><IconButton label="图层下移" disabled={!selectedLayer||selectedLayer.locked||doc.layers[0]?.id===selected} onClick={()=>reorder(-1)}><ArrowDown/></IconButton></div></div>
      <div className="sketch-layer-list">{[...doc.layers].reverse().map(l=><div key={l.id} className={`sketch-layer-row ${selected===l.id?'selected':''}`}><button className="sketch-layer-name" aria-label={`选择图层 ${l.name}`} onClick={()=>{setSelected(l.id);setSceneSelection(null);setTool('select');setPart('entities');}}>{l.kind==='scene'?<Box/>:l.kind==='text'?<Type/>:l.kind==='image'?<ImagePlus/>:<LayersIcon/>}<span>{l.name}</span></button><IconButton label={`${l.visible?'隐藏':'显示'} ${l.name}`} onClick={()=>edit(d=>({...d,layers:d.layers.map(v=>v.id===l.id?{...v,visible:!v.visible}:v)}),true)}>{l.visible?<Eye/>:<EyeOff/>}</IconButton><IconButton label={`${l.locked?'解锁':'锁定'} ${l.name}`} onClick={()=>edit(d=>({...d,layers:d.layers.map(v=>v.id===l.id?{...v,locked:!v.locked}:v)}),true)}>{l.locked?<LockKeyhole/>:<UnlockKeyhole/>}</IconButton></div>)}</div>
      {scene&&<>
        <div className="sketch-scene-tree">{([['entities','实体'],['ground','地面'],['camera','相机']] as const).map(([key,label])=><button key={key} className={part===key?'selected':''} onClick={()=>{setPart(key);if(key!=='entities')setSceneSelection(null);if(key==='camera')setTool('orbit');}}>{label}</button>)}</div>
        <div className="sketch-entity-list" aria-label="场景实体">{scene.entities.map(e=><div key={e.id} className={`sketch-layer-row ${entity?.id===e.id?'selected':''}`}><button className="sketch-layer-name" aria-label={`选择实体 ${e.name}`} onClick={()=>selectEntity(e.id)}><Box/><span>{e.name}</span></button><IconButton label={`${e.visible?'隐藏':'显示'}实体 ${e.name}`} disabled={selectedLayer?.locked} onClick={()=>sceneChange(s=>({...s,entities:s.entities.map(o=>o.id===e.id?{...o,visible:!o.visible}:o)}),true)}>{e.visible?<Eye/>:<EyeOff/>}</IconButton><IconButton label={`${e.locked?'解锁':'锁定'}实体 ${e.name}`} disabled={selectedLayer?.locked} onClick={()=>sceneChange(s=>({...s,entities:s.entities.map(o=>o.id===e.id?{...o,locked:!o.locked}:o)}),true)}>{e.locked?<LockKeyhole/>:<UnlockKeyhole/>}</IconButton></div>)}</div>
      </>}

    </div>
    <div className="sketch-properties"><div className="sketch-panel-title"><h2>{entity?'实体属性':selectedLayer?'图层属性':'选择一个图层'}</h2>{selectedLayer&&<div><IconButton label={entity?"复制实体":"复制图层"} disabled={selectedLayer.locked||!!entity?.locked||(!entity&&selectedLayer.kind==='scene')} onClick={entity?copyEntity:duplicate}><Copy/></IconButton><IconButton label={entity?"删除实体":"删除图层"} disabled={selectedLayer.locked||!!entity?.locked} onClick={entity?remove:removeLayer}><Trash2/></IconButton></div>}</div>
    {selectedLayer&&<fieldset disabled={selectedLayer.locked}>{!entity&&<label className="sketch-field">图层名称<input aria-label="图层名称" value={selectedLayer.name} maxLength={120} onChange={e=>patch({name:e.target.value},false)} onBlur={commit}/></label>}
      {selectedLayer.locked&&<p className="sketch-help">图层已锁定，请先解锁。</p>}
      {selectedLayer.kind==='text'&&<><label className="sketch-field">文字内容<textarea id="sketch-text" aria-label="文字内容" value={selectedLayer.text} maxLength={10000} onChange={e=>patch({text:e.target.value},false)} onBlur={commit}/></label>{range('字号',selectedLayer.fontSize!,8,160,v=>patch({fontSize:v},false))}</>}
      {!['scene','image'].includes(selectedLayer.kind)&&<><Color label={selectedLayer.kind==='text'?'文字颜色':'填充颜色'} value={selectedLayer.fill} transparent={selectedLayer.kind!=='text'} onChange={fill=>patch({fill})}/>{selectedLayer.kind!=='text'&&<><Color label="描边颜色" value={selectedLayer.stroke} onChange={stroke=>patch({stroke})}/>{range('描边宽度',selectedLayer.strokeWidth,1,30,v=>patch({strokeWidth:v},false))}</>}</>}
      {!scene&&<>{range('不透明度',selectedLayer.opacity,0,1,v=>patch({opacity:v},false),.01)}{range('旋转',selectedLayer.rotation,-180,180,v=>patch({rotation:v},false))}</>}
      {scene&&<>
        {entity&&<EntityInspector entity={entity} scene={scene} joint={joint} onJoint={next=>{setJoint(next);setSceneSelection({entityId:entity.id,joint:next});if(jointAxis(tool)===null)setTool('bend');}} onChange={entityChange} onCommit={commit} onLibrary={()=>setShowPoses(true)} onSavePose={savePose}/>}
        {part==='entities'&&!entity&&<p className="sketch-help">选择场景中的实体，或使用左侧「添加实体」。共 {scene.entities.length} 个实体。</p>}
        {part==='ground'&&<><label className="sketch-check"><input type="checkbox" checked={scene.ground.visible} onChange={e=>sceneChange(s=>({...s,ground:{...s.ground,visible:e.target.checked}}),true)}/>显示地面</label><Color label="地面颜色" value={scene.ground.color} onChange={color=>sceneChange(s=>({...s,ground:{...s.ground,color}}),true)}/></>}
        {part==='camera'&&<><p className="sketch-help">左键绕观察点旋转，右键平移，中键拖动或滚轮缩放。</p>{range('相机方位',scene.camera.azimuth,-180,180,v=>sceneChange(s=>({...s,camera:{...s.camera,azimuth:v}})))}{range('相机俯仰',scene.camera.elevation,-15,80,v=>sceneChange(s=>({...s,camera:{...s.camera,elevation:v}})))}{range('相机距离',scene.camera.distance,2,40,v=>sceneChange(s=>({...s,camera:{...s.camera,distance:v}})),.1)}{range('取景水平',scene.camera.targetX??0,-20,20,v=>sceneChange(s=>({...s,camera:{...s.camera,targetX:v}})),.05)}{range('取景高度',scene.camera.targetY,-20,20,v=>sceneChange(s=>({...s,camera:{...s.camera,targetY:v}})),.05)}{range('取景前后',scene.camera.targetZ??0,-20,20,v=>sceneChange(s=>({...s,camera:{...s.camera,targetZ:v}})),.05)}{range('视野角度',scene.camera.fov,20,80,v=>sceneChange(s=>({...s,camera:{...s.camera,fov:v}})))}<button className="button secondary full" onClick={()=>sceneChange(s=>({...s,camera:sceneDefaults().camera}),true)}>重置相机</button></>}
      </>}
    </fieldset>}
    {!selectedLayer&&<p className="sketch-help">在画布或图层列表中选择对象。文字与图形可拖动、缩放和旋转。</p>}
    </div></aside></div>
    <input ref={imageInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>{const f=e.target.files?.[0];if(f)void addImage(f);e.target.value='';}}/>
    <input ref={fileInput} hidden type="file" accept=".json" onChange={e=>{const f=e.target.files?.[0];if(f)void openFile(f);e.target.value='';}}/>
    {showPoses&&<PoseLibrary target={entity?.kind==='figure'?entity.name:null} saved={doc.savedPoses} favorites={doc.favoritePoses} onFavorite={id=>edit(d=>({...d,favoritePoses:d.favoritePoses.includes(id)?d.favoritePoses.filter(v=>v!==id):[...d.favoritePoses,id]}),true)} onRemove={id=>edit(d=>({...d,savedPoses:d.savedPoses.filter(p=>p.id!==id),favoritePoses:d.favoritePoses.filter(v=>v!==id)}),true)} onApply={applyPose} onClose={()=>setShowPoses(false)}/>}
    {showLicenses&&<Modal title="草图编辑器 · 开源组件许可" onClose={()=>setShowLicenses(false)}><pre className="sketch-licenses">{notices}{'\n\nMakeHuman continuous humanoid mesh, skeleton landmarks and skin weights\nSource: https://github.com/makehumancommunity/makehuman\nLicense: CC0 1.0 Universal\n\n'}{humanoidLicense}</pre></Modal>}
  </div>;
}
function LayersIcon(){return <Square/>;}
