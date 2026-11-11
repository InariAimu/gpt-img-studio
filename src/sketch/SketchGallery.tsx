import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Check, Copy, Heart, ListChecks, LoaderCircle, Pencil, Plus, Search, Trash2, Undo2, X } from 'lucide-react';
import { Empty, Modal } from '../components';
import { OptionSelect } from '../OptionSelect';
import type { Studio } from '../useStudio';
import type { SketchRecord } from '../types';
import { createSketch, ensurePreview, sketchUrl } from './library';
import './sketch.css';
const Editor=lazy(()=>import('./SketchWorkspace'));

export default function SketchGallery({studio,active,entry}:{studio:Studio;active:boolean;entry:number}){
  const [editing,setEditing]=useState<string|null>(null),[query,setQuery]=useState(''),[filter,setFilter]=useState('all');
  const [selecting,setSelecting]=useState(false),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[size,setSize]=useState('normal');
  const [rename,setRename]=useState<SketchRecord|null>(null),[name,setName]=useState(''),[deleting,setDeleting]=useState<string[]|null>(null);
  const [failed,setFailed]=useState<string[]>([]),[rendering,setRendering]=useState('');
  const studioRef=useRef(studio);studioRef.current=studio;
  const previousEntry=useRef(entry);
  useEffect(()=>{if(entry!==previousEntry.current&&editing)void studioRef.current.flushSketchEditors().then(()=>setEditing(null)).catch(studioRef.current.report);previousEntry.current=entry;},[entry]);
  const sketches=studio.document.sketches??[];
  const filtered=sketches.filter(s=>(filter==='trash'?!!s.trashedAt:!s.trashedAt)&&(filter!=='favorites'||s.favorite)&&s.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
  const nextPreview=active&&!editing&&filter!=='trash'?filtered.slice(0,24).find(s=>(!s.previewPath||s.previewRevision!==s.documentPath)&&!failed.includes(`${s.id}:${s.revision}`)):undefined;
  const previewKey=nextPreview?`${nextPreview.id}:${nextPreview.revision}`:'';
  useEffect(()=>{
    if(!nextPreview)return;let stopped=false;setRendering(nextPreview.id);
    void ensurePreview(studioRef.current,nextPreview).catch(()=>{if(!stopped)setFailed(v=>[...v,previewKey]);}).finally(()=>{if(!stopped)setRendering('');});
    return()=>{stopped=true;};
  },[previewKey]);
  useEffect(()=>{setSelected([]);},[query,filter]);
  useEffect(()=>{setSelected(ids=>ids.filter(id=>sketches.some(s=>s.id===id&&(filter==='trash'?!!s.trashedAt:!s.trashedAt))));},[studio.document.sketches,filter]);
  async function action(operation:string,ids:string[],extra:Record<string,unknown>={}){
    setBusy(true);try{await studio.mutate({type:'sketch_action',operation,ids,...extra});if(operation==='trash'||operation==='restore'){setSelected([]);studio.notify(operation==='trash'?'草图已移入最近删除；已使用的参考图保持不变':'草图已恢复');}setRename(null);setDeleting(null);}catch(e){studio.report(e);}finally{setBusy(false);}
  }
  async function add(){setBusy(true);try{const result=await createSketch(studio);setEditing(result.sketchId);}catch(e){studio.report(e);}finally{setBusy(false);}}
  const toggle=(id:string)=>setSelected(ids=>ids.includes(id)?ids.filter(v=>v!==id):[...ids,id]);
  return <div className="sketch-library">
    <div className="sketch-library-list" hidden={!!editing}>
      <header className="page-header"><div><h1>草图<span className="heading-count">{filtered.length}</span></h1></div><div className="header-actions"><button className="button secondary" disabled={busy} onClick={()=>void add()}><Plus/>新增草图</button></div></header>
      <div className="gallery-layout"><section className="gallery-panel" aria-label="草图库">
      <div className="gallery-toolbar"><label className="search-input"><Search/><input aria-label="搜索草图" placeholder="搜索草图名称…" value={query} onChange={e=>setQuery(e.target.value)}/></label><OptionSelect className="gallery-view-select" aria-label="草图预览大小" title="草图预览大小" value={size} onValueChange={setSize}><option value="normal">小预览</option><option value="large">中预览</option><option value="xlarge">大预览</option></OptionSelect><button className="button secondary" aria-pressed={selecting} onClick={()=>{setSelecting(!selecting);setSelected([]);}}>{selecting?<X/>:<ListChecks/>}{selecting?'退出多选':'多选'}</button></div>
      <div className="gallery-filters"><div className="filter-tabs">{[['all','全部'],['favorites','收藏'],['trash','最近删除']].map(([id,label])=><button key={id} className={filter===id?'selected':''} onClick={()=>setFilter(id)}>{label}</button>)}</div><span className="muted">{filter==='trash'?'可恢复；已生成的参考图始终保留':'最近修改优先'}</span></div>
      {selecting&&<div className="gallery-batch-bar"><div className="gallery-batch-summary"><strong>已选 {selected.length} 份草图</strong><span>更改筛选会清空选择。</span></div><div className="gallery-batch-actions"><button className="button secondary small" onClick={()=>setSelected(selected.length===filtered.length?[]:filtered.map(s=>s.id))}>{filtered.length&&selected.length===filtered.length?'取消全选':'全选当前结果'}</button>{filter==='trash'?<button className="button secondary small" disabled={busy||!selected.length} onClick={()=>void action('restore',selected)}><Undo2/>恢复</button>:<><button className="button secondary small" disabled={busy||!selected.length} onClick={()=>void action('duplicate',selected)}><Copy/>复制</button><button className="button danger small" disabled={busy||!selected.length} onClick={()=>setDeleting(selected)}><Trash2/>删除</button></>}</div></div>}
      <section aria-label="草图列表"><div className="asset-grid sketch-grid" data-preview-size={size}>{filtered.map(item=><article className={`asset-card sketch-card ${selected.includes(item.id)?'selected':''}`} key={item.id}>
        <button className="asset-main" aria-label={`${selecting?'选择':filter==='trash'?'已删除':'编辑'}草图 ${item.name}`} aria-pressed={selected.includes(item.id)} onClick={()=>selecting?toggle(item.id):filter!=='trash'&&setEditing(item.id)}>
          <span className="asset-frame sketch-preview">{item.previewPath?<img src={sketchUrl(studio,item)} alt="" loading="lazy"/>:<span className="sketch-preview-empty"><Pencil/>{rendering===item.id?'正在生成预览…':'预览待更新'}</span>}{selecting&&<span className={`asset-selection-check ${selected.includes(item.id)?'checked':''}`}>{selected.includes(item.id)&&<Check size={14}/>}</span>}{item.previewPath&&item.previewRevision!==item.documentPath&&<span className="sketch-preview-status">预览待更新</span>}</span>
          <span className="asset-title" title={item.name}>{item.name}</span><span className="asset-subtitle">{item.width} × {item.height}<span>·</span>{new Date(item.updatedAt).toLocaleDateString()}</span>
        </button>
        {!selecting&&<div className="sketch-card-actions">{filter==='trash'?<button className="button secondary small" disabled={busy} onClick={()=>void action('restore',[item.id])}><Undo2/>恢复草图</button>:<><button className="icon-button" aria-label={`重命名 ${item.name}`} disabled={busy} onClick={()=>{setRename(item);setName(item.name);}}><Pencil/></button><button className="icon-button" aria-label={`复制 ${item.name}`} disabled={busy} onClick={()=>void action('duplicate',[item.id])}><Copy/></button><button className="icon-button" aria-label={`${item.favorite?'取消收藏':'收藏'} ${item.name}`} disabled={busy} onClick={()=>void action('favorite',[item.id],{favorite:!item.favorite})}><Heart fill={item.favorite?'currentColor':'none'}/></button><button className="icon-button" aria-label={`删除 ${item.name}`} disabled={busy} onClick={()=>setDeleting([item.id])}><Trash2/></button></>}</div>}
      </article>)}</div>{!filtered.length&&<Empty title={query?'没有匹配的草图':filter==='trash'?'最近删除为空':filter==='favorites'?'还没有收藏的草图':'从第一份构图开始'} description={query?'换一个名称试试。':filter==='trash'?'删除的草图会保留在这里，随时可以恢复。':'新增草图，放置人物、几何体或绘制二维图层。'}>{filter==='all'&&!query&&<button className="button primary" onClick={()=>void add()}><Plus/>新增草图</button>}</Empty>}</section>
      </section></div>
    </div>
    {editing&&<Suspense fallback={<div className="loading-screen">正在打开草图…</div>}><Editor key={editing} studio={studio} active={active} sketchId={editing} onBack={()=>setEditing(null)} onOpenId={setEditing}/></Suspense>}
    {rename&&<Modal title="重命名草图" onClose={()=>{if(!busy)setRename(null);}}><form onSubmit={e=>{e.preventDefault();void action('rename',[rename.id],{name});}}><div className="modal-content"><label className="field">草图名称<input aria-label="新的草图名称" autoFocus maxLength={120} value={name} onChange={e=>setName(e.target.value)}/></label></div><footer className="modal-footer"><button type="button" className="button secondary" disabled={busy} onClick={()=>setRename(null)}>取消</button><button className="button primary" disabled={busy||!name.trim()}>保存名称</button></footer></form></Modal>}
    {deleting&&<Modal title={`删除 ${deleting.length} 份草图`} onClose={()=>{if(!busy)setDeleting(null);}}><div className="modal-content"><p>草图将移入“最近删除”，可以恢复。已用于生成的参考图和历史记录保持不变。</p></div><footer className="modal-footer"><button className="button secondary" disabled={busy} onClick={()=>setDeleting(null)}>取消</button><button className="button danger" disabled={busy} onClick={()=>void action('trash',deleting)}>{busy&&<LoaderCircle className="spin"/>}移入最近删除</button></footer></Modal>}
  </div>;
}
