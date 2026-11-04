import { useEffect, useRef, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from 'react';
import { Check, LoaderCircle, Plus } from 'lucide-react';
import { Empty, Modal } from './components';
import type { Studio } from './useStudio';

type PickerTab = 'references' | 'generated';
const tabs: {id:PickerTab;label:string}[] = [{id:'references',label:'参考图'},{id:'generated',label:'生成图片'}];

export default function ReferencePicker({studio,selectedIds,onChange,onImport,onClose}:{studio:Studio;selectedIds:string[];onChange:Dispatch<SetStateAction<string[]>>;onImport:()=>Promise<void>;onClose:()=>void}) {
  const [tab,setTab]=useState<PickerTab>('references');
  const [importing,setImporting]=useState(false);
  const scrollRef=useRef<HTMLDivElement>(null);
  const assets=studio.document.assets.filter(asset=>!asset.demo);
  const references=assets.filter(asset=>asset.isReference||asset.referenceOnly||asset.model==='本地导入'||!asset.sessionId);
  const referenceIds=new Set(references.map(asset=>asset.id));
  const groups={references,generated:assets.filter(asset=>!referenceIds.has(asset.id))};
  useEffect(()=>{scrollRef.current?.scrollTo({top:0});},[tab]);
  function navigateTabs(event:KeyboardEvent<HTMLButtonElement>){
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();
    const next=event.key==='Home'?0:event.key==='End'?1:tab==='references'?1:0;
    setTab(tabs[next].id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
  async function importImages(){
    setImporting(true);
    try{await onImport();setTab('references');scrollRef.current?.scrollTo({top:0});}finally{setImporting(false);}
  }
  return <Modal title="选择参考图" onClose={onClose} className="reference-picker">
    <div className="picker-topline"><div className="segment picker-tabs" role="tablist" aria-label="图片来源">{tabs.map(item=><button key={item.id} id={`picker-tab-${item.id}`} role="tab" aria-selected={tab===item.id} aria-controls="reference-picker-panel" tabIndex={tab===item.id?0:-1} onKeyDown={navigateTabs} onClick={()=>setTab(item.id)}>{item.label}<span className="picker-tab-count">{groups[item.id].length}</span></button>)}</div><button className="button secondary" disabled={importing} onClick={()=>void importImages()}>{importing?<LoaderCircle className="spin"/>:<Plus/>}导入图片</button></div>
    <div className="picker-scroll" ref={scrollRef} id="reference-picker-panel" role="tabpanel" aria-labelledby={`picker-tab-${tab}`} tabIndex={0}>
      {groups[tab].length?<div className="picker-grid">{groups[tab].map(asset=>{
        const selected=selectedIds.includes(asset.id);
        return <button key={asset.id} className={`picker-item ${selected?'picked':''}`} title={asset.title} aria-label={asset.title} aria-pressed={selected} disabled={!selected&&selectedIds.length>=8} onClick={()=>onChange(current=>current.includes(asset.id)?current.filter(id=>id!==asset.id):current.length<8?[...current,asset.id]:current)}><img src={studio.imageUrl(asset,true)} alt="" loading="lazy"/><span>{asset.title}</span>{selected&&<span className="picked-check"><Check size={13}/></span>}</button>;
      })}</div>:<Empty title={tab==='references'?'还没有参考图':'还没有生成图片'} description={tab==='references'?'导入图片，或将已有作品加入参考图。':'生成后的作品会显示在这里，也可以选作参考图。'}/>}
    </div>
    <footer className="modal-footer"><span className="muted">已选 {selectedIds.length} / 8 张</span><button className="button primary" onClick={onClose}>完成选择</button></footer>
  </Modal>;
}
