import { useEffect, useRef, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from 'react';
import { Check, LoaderCircle, Plus, Search, X } from 'lucide-react';
import { Empty, Modal } from './components';
import type { Studio } from './useStudio';
import { selectSketchReference, sketchUrl } from './sketch/library';
import type { SketchRecord } from './types';
import './sketch/sketch.css';

type ImageTab = 'global' | 'workspace' | 'generated';
type PickerTab = ImageTab | 'sketch';
const tabs: {id:PickerTab;label:string}[] = [{id:'global',label:'全局参考图'},{id:'workspace',label:'工作区参考图'},{id:'generated',label:'生成图片'},{id:'sketch',label:'草图'}];

export default function ReferencePicker({studio,workspaceId,selectedIds,onChange,onImport,onClose}:{studio:Studio;workspaceId:string;selectedIds:string[];onChange:Dispatch<SetStateAction<string[]>>;onImport:()=>Promise<void>;onClose:()=>void}) {
  const [tab,setTab]=useState<PickerTab>('global');
  const [query,setQuery]=useState('');
  const [importing,setImporting]=useState(false);
  const [preparing,setPreparing]=useState('');
  const selectedRef=useRef(selectedIds);selectedRef.current=selectedIds;
  const scrollRef=useRef<HTMLDivElement>(null);
  const assets=studio.document.assets.filter(asset=>!asset.demo&&(!asset.sketchSnapshot||asset.isReference||asset.sketchPromotedAt));
  const references=assets.filter(asset=>asset.isReference||asset.referenceOnly||asset.model==='本地导入'||!asset.sessionId);
  const referenceIds=new Set(references.map(asset=>asset.id));
  const sessions=new Map(studio.document.sessions.map(session=>[session.id,session]));
  const workspaces=new Map(studio.document.workspaces.map(workspace=>[workspace.id,workspace]));
  const workspaceSessions=new Set(studio.document.sessions.filter(session=>session.workspaceId===workspaceId).map(session=>session.id));
  const usedInWorkspace=new Set(selectedIds);
  for(const record of [...studio.document.sessions.filter(session=>workspaceSessions.has(session.id)),...assets.filter(asset=>asset.workspaceId===workspaceId||workspaceSessions.has(asset.sessionId)),...studio.document.jobs.filter(job=>workspaceSessions.has(job.sessionId))]) {
    for(const id of record.referenceIds??[])usedInWorkspace.add(id);
    if('parentAssetId' in record&&record.parentAssetId)usedInWorkspace.add(record.parentAssetId);
  }
  const global=references.filter(asset=>asset.isReference||!asset.workspaceId);
  const globalIds=new Set(global.map(asset=>asset.id));
  const groups={global,workspace:references.filter(asset=>!globalIds.has(asset.id)&&(asset.workspaceId===workspaceId||usedInWorkspace.has(asset.id))),generated:assets.filter(asset=>!referenceIds.has(asset.id))};
  const words=query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const filtered=Object.fromEntries((['global','workspace','generated'] as ImageTab[]).map(id=>[id,groups[id].filter(asset=>{
    const session=sessions.get(asset.sessionId||asset.sourceSessionId||'');
    const searchable=[asset.title,asset.path.split(/[\\/]/u).at(-1),asset.originalPrompt,asset.submittedPrompt,asset.revisedPrompt,asset.model,session?.title,workspaces.get(asset.workspaceId)?.name].filter(Boolean).join(' ').toLocaleLowerCase();
    return words.every(word=>searchable.includes(word));
  })])) as typeof groups;
  const sketches=(studio.document.sketches??[]).filter(s=>!s.trashedAt).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  const matchingSketches=sketches.filter(s=>words.every(word=>s.name.toLocaleLowerCase().includes(word)));
  const sketchAsset=(item:SketchRecord)=>studio.document.assets.find(a=>a.sketchId===item.id&&a.sketchRevision===item.documentPath&&selectedIds.includes(a.id));
  async function pickSketch(item:SketchRecord){
    const selected=sketchAsset(item);if(selected){onChange(ids=>ids.filter(id=>id!==selected.id));return;}
    if(preparing||selectedRef.current.length>=8)return;
    setPreparing(item.id);
    try{const id=await selectSketchReference(studio,item);onChange(ids=>ids.includes(id)||ids.length>=8?ids:[...ids,id]);}catch(e){studio.report(e);}finally{setPreparing('');}
  }
  useEffect(()=>{scrollRef.current?.scrollTo({top:0});},[tab,query]);
  function navigateTabs(event:KeyboardEvent<HTMLButtonElement>){
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();
    const current=tabs.findIndex(item=>item.id===tab);
    const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(current+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
    setTab(tabs[next].id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
  async function importImages(){
    setImporting(true);
    try{await onImport();setQuery('');setTab('workspace');scrollRef.current?.scrollTo({top:0});}finally{setImporting(false);}
  }
  return <Modal title="选择参考图" onClose={onClose} className="reference-picker">
    <div className="picker-topline"><div className="segment picker-tabs" role="tablist" aria-label="图片来源">{tabs.map(item=><button key={item.id} id={`picker-tab-${item.id}`} role="tab" aria-selected={tab===item.id} aria-controls="reference-picker-panel" tabIndex={tab===item.id?0:-1} onKeyDown={navigateTabs} onClick={()=>setTab(item.id)}>{item.label}<span className="picker-tab-count">{item.id==='sketch'?(words.length?`${matchingSketches.length} / ${sketches.length}`:sketches.length):words.length?`${filtered[item.id].length} / ${groups[item.id].length}`:groups[item.id].length}</span></button>)}</div><button className="button secondary" disabled={importing} onClick={()=>void importImages()}>{importing?<LoaderCircle className="spin"/>:<Plus/>}导入图片</button></div>
    <div className="picker-search-row"><div className="search-input"><Search aria-hidden="true"/><input aria-label="搜索参考图片" placeholder={tab==='sketch'?'搜索草图名称…':'搜索名称、Prompt、会话或模型…'} value={query} onChange={event=>setQuery(event.target.value)}/>{query&&<button className="icon-button" aria-label="清空参考图搜索" onClick={()=>setQuery('')}><X/></button>}</div><span className="picker-scope" title={tab==='workspace'?workspaces.get(workspaceId)?.name:undefined}>{tab==='workspace'?`当前工作区：${workspaces.get(workspaceId)?.name||'工作区'}`:tab==='global'?'全局可用的参考素材':tab==='sketch'?'全部可用草图':'全部工作区的生成图片'}</span></div>
    <div className="picker-scroll" ref={scrollRef} id="reference-picker-panel" role="tabpanel" aria-labelledby={`picker-tab-${tab}`} tabIndex={0}>
      {tab==='sketch'?<><p className="sketch-picker-note">选择当前画面作为参考；提交生成时自动保存到参考图库。之后修改或删除草图，不影响这张参考图。</p>{matchingSketches.length?<div className="picker-grid">{matchingSketches.map(item=>{const selected=!!sketchAsset(item);return <button key={item.id} className={`picker-item ${selected?'picked':''}`} title={item.name} aria-label={`选择草图 ${item.name}`} aria-pressed={selected} disabled={!!preparing||(!selected&&selectedIds.length>=8)} onClick={()=>void pickSketch(item)}><span className="sketch-picker-preview">{preparing===item.id?<LoaderCircle className="spin"/>:item.previewPath?<img src={sketchUrl(studio,item)} alt="" loading="lazy"/>:<span>选择时生成预览</span>}</span><span>{item.name}</span>{selected&&<span className="picked-check"><Check size={13}/></span>}</button>;})}</div>:<Empty title={words.length?'没有匹配的草图':'还没有草图'} description={words.length?'换一个名称试试。':'在左侧“草图”中新增构图，保存后即可在这里选择。'}/>}</>:filtered[tab].length?<div className="picker-grid">{filtered[tab].map(asset=>{
        const selected=selectedIds.includes(asset.id);
        return <button key={asset.id} className={`picker-item ${selected?'picked':''}`} title={asset.title} aria-label={asset.title} aria-pressed={selected} disabled={!selected&&selectedIds.length>=8} onClick={()=>onChange(current=>current.includes(asset.id)?current.filter(id=>id!==asset.id):current.length<8?[...current,asset.id]:current)}><img src={studio.imageUrl(asset,true)} alt="" loading="lazy"/><span>{asset.title}</span>{selected&&<span className="picked-check"><Check size={13}/></span>}</button>;
      })}</div>:<Empty title={words.length?'没有匹配的图片':tab==='global'?'还没有全局参考图':tab==='workspace'?'当前工作区还没有参考图':'还没有生成图片'} description={words.length?'换个关键词，或清空搜索查看此页签的全部图片。':tab==='global'?'在参考图库导入图片，或将已有作品加入全局参考图。':tab==='workspace'?'在当前工作区导入或粘贴的参考素材会显示在这里。':'生成后的作品会显示在这里，也可以选作参考图。'}/>}
    </div>
    <footer className="modal-footer"><span className="muted">已选 {selectedIds.length} / 8 张</span><button className="button primary" disabled={!!preparing} onClick={onClose}>{preparing?'正在准备草图…':'完成选择'}</button></footer>
  </Modal>;
}
