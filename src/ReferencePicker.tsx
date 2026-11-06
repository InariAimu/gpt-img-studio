import { useEffect, useRef, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from 'react';
import { Check, LoaderCircle, Plus, Search, X } from 'lucide-react';
import { Empty, Modal } from './components';
import type { Studio } from './useStudio';

type PickerTab = 'global' | 'workspace' | 'generated';
const tabs: {id:PickerTab;label:string}[] = [{id:'global',label:'全局参考图'},{id:'workspace',label:'工作区参考图'},{id:'generated',label:'生成图片'}];

export default function ReferencePicker({studio,workspaceId,selectedIds,onChange,onImport,onClose}:{studio:Studio;workspaceId:string;selectedIds:string[];onChange:Dispatch<SetStateAction<string[]>>;onImport:()=>Promise<void>;onClose:()=>void}) {
  const [tab,setTab]=useState<PickerTab>('global');
  const [query,setQuery]=useState('');
  const [importing,setImporting]=useState(false);
  const scrollRef=useRef<HTMLDivElement>(null);
  const assets=studio.document.assets.filter(asset=>!asset.demo);
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
  const filtered=Object.fromEntries(tabs.map(({id})=>[id,groups[id].filter(asset=>{
    const session=sessions.get(asset.sessionId||asset.sourceSessionId||'');
    const searchable=[asset.title,asset.path.split(/[\\/]/u).at(-1),asset.originalPrompt,asset.submittedPrompt,asset.revisedPrompt,asset.model,session?.title,workspaces.get(asset.workspaceId)?.name].filter(Boolean).join(' ').toLocaleLowerCase();
    return words.every(word=>searchable.includes(word));
  })])) as typeof groups;
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
    <div className="picker-topline"><div className="segment picker-tabs" role="tablist" aria-label="图片来源">{tabs.map(item=><button key={item.id} id={`picker-tab-${item.id}`} role="tab" aria-selected={tab===item.id} aria-controls="reference-picker-panel" tabIndex={tab===item.id?0:-1} onKeyDown={navigateTabs} onClick={()=>setTab(item.id)}>{item.label}<span className="picker-tab-count">{words.length?`${filtered[item.id].length} / ${groups[item.id].length}`:groups[item.id].length}</span></button>)}</div><button className="button secondary" disabled={importing} onClick={()=>void importImages()}>{importing?<LoaderCircle className="spin"/>:<Plus/>}导入图片</button></div>
    <div className="picker-search-row"><div className="search-input"><Search aria-hidden="true"/><input aria-label="搜索参考图片" placeholder="搜索名称、Prompt、会话或模型…" value={query} onChange={event=>setQuery(event.target.value)}/>{query&&<button className="icon-button" aria-label="清空参考图搜索" onClick={()=>setQuery('')}><X/></button>}</div><span className="picker-scope" title={tab==='workspace'?workspaces.get(workspaceId)?.name:undefined}>{tab==='workspace'?`当前工作区：${workspaces.get(workspaceId)?.name||'工作区'}`:tab==='global'?'全局可用的参考素材':'全部工作区的生成图片'}</span></div>
    <div className="picker-scroll" ref={scrollRef} id="reference-picker-panel" role="tabpanel" aria-labelledby={`picker-tab-${tab}`} tabIndex={0}>
      {filtered[tab].length?<div className="picker-grid">{filtered[tab].map(asset=>{
        const selected=selectedIds.includes(asset.id);
        return <button key={asset.id} className={`picker-item ${selected?'picked':''}`} title={asset.title} aria-label={asset.title} aria-pressed={selected} disabled={!selected&&selectedIds.length>=8} onClick={()=>onChange(current=>current.includes(asset.id)?current.filter(id=>id!==asset.id):current.length<8?[...current,asset.id]:current)}><img src={studio.imageUrl(asset,true)} alt="" loading="lazy"/><span>{asset.title}</span>{selected&&<span className="picked-check"><Check size={13}/></span>}</button>;
      })}</div>:<Empty title={words.length?'没有匹配的图片':tab==='global'?'还没有全局参考图':tab==='workspace'?'当前工作区还没有参考图':'还没有生成图片'} description={words.length?'换个关键词，或清空搜索查看此页签的全部图片。':tab==='global'?'在参考图库导入图片，或将已有作品加入全局参考图。':tab==='workspace'?'在当前工作区导入或粘贴的参考素材会显示在这里。':'生成后的作品会显示在这里，也可以选作参考图。'}/>}
    </div>
    <footer className="modal-footer"><span className="muted">已选 {selectedIds.length} / 8 张</span><button className="button primary" onClick={onClose}>完成选择</button></footer>
  </Modal>;
}
