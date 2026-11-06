import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, LoaderCircle, Settings2, Upload } from 'lucide-react';
import { Modal } from './components';
import { desktop, type Studio } from './useStudio';

export default function GalleryImportDialog({studio,assetIds,selectedIds,onClose,onSettings,onQueued}:{studio:Studio;assetIds:string[];selectedIds:string[];onClose:()=>void;onSettings:()=>void;onQueued:()=>void}) {
  const [selected,setSelected]=useState(()=>new Set(selectedIds));
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const [config,setConfig]=useState<{hasToken:boolean;config:{apiUrl:string;labelModel?:{providerId:string;modelId:string}|null}}>();
  useEffect(()=>{let active=true;if(desktop)void invoke<typeof config>('gallery_settings').then(v=>{if(active)setConfig(v);}).catch(e=>{if(active)setError(String(e));});return()=>{active=false;};},[]);
  const assets=assetIds.map(id=>studio.document.assets.find(a=>a.id===id)).filter(a=>!!a);
  const sessions=[...new Set(assets.map(a=>a.sessionId))];
  const model=config?.config.labelModel?.modelId||studio.document.settings.modelAssignments?.refine.modelId;
  const ready=!!config?.hasToken&&!!model;
  async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');try{await studio.enqueueGalleryImport(assets.filter(a=>selected.has(a.id)).map(a=>a.id));onQueued();}catch(e){setError(String(e));setBusy(false);}}
  function toggle(id:string){setSelected(old=>{const next=new Set(old);if(next.has(id))next.delete(id);else next.add(id);return next;});}
  return <Modal title="导入图库" onClose={()=>{if(!busy)onClose();}} className="gallery-import-modal"><form onSubmit={e=>void submit(e)}>
    <div className="modal-body gallery-import-body">
      <p className="field-help">只上传勾选的生成图片。后台逐张生成标签与评级、上传原图并附带创作信息；本机原图保留。</p>
      <div className="import-destination"><span>{config?.config.apiUrl||'尚未配置图库'}</span><span>标签模型：{model||'未选择'}</span></div>
      <div className="import-selection-heading"><strong>已选 {assets.filter(a=>selected.has(a.id)).length} / {assets.length} 张</strong><button type="button" className="button ghost small" disabled={busy} onClick={()=>setSelected(selected.size===assets.length?new Set():new Set(assets.map(a=>a.id)))}>{selected.size===assets.length?'取消全选':'全选图片'}</button></div>
      <div className="import-session-list">{sessions.map(sessionId=>{
        const group=assets.filter(a=>a.sessionId===sessionId);const title=studio.document.sessions.find(s=>s.id===sessionId)?.title||group[0].title;
        return <details key={sessionId} className="import-session" open={sessions.length===1||undefined}><summary>{title}<span>{group.filter(a=>selected.has(a.id)).length} / {group.length} 张</span></summary><div className="import-image-grid">{group.map(asset=><button type="button" key={asset.id} className={`import-image ${selected.has(asset.id)?'selected':''}`} aria-pressed={selected.has(asset.id)} aria-label={`选择图片 ${asset.title}`} disabled={busy} onClick={()=>toggle(asset.id)}><img src={studio.imageUrl(asset,true)} alt={asset.title}/><span className="import-check">{selected.has(asset.id)&&<Check size={15}/>}</span><span className="import-image-caption">{asset.width} × {asset.height}{asset.galleryImports?.length?' · 已导入':''}</span></button>)}</div></details>;
      })}</div>
      <p className="field-help">执行期间暂停多设备同步，可以继续生图。重复原图会关联已有帖子。关闭应用会中断任务，重启后可手动继续。</p>
      {!ready&&<div className="network-result"><span>{config?'请先保存图库 Token 并配置支持视觉的标签模型。':'正在读取图库配置…'}</span><button type="button" className="button secondary small" onClick={onSettings}><Settings2/>打开图库设置</button></div>}
      {error&&<p className="option-error" role="alert">{error}</p>}
    </div><footer className="modal-footer"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={!ready||busy||!selected.size||selected.size>200}>{busy?<LoaderCircle className="spin"/>:<Upload/>}{busy?'正在加入任务':'加入导入任务'}</button></footer>
  </form></Modal>;
}
