import { useEffect, useState } from 'react';
import { LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import { Modal } from './components';
import type { SessionDeletePreview } from './types';
import type { Studio } from './useStudio';

export default function SessionDeleteDialog({studio,sessionId,onClose,onDeleted}:{studio:Studio;sessionId:string;onClose:()=>void;onDeleted:(workspaceId:string)=>void}) {
  const [preview,setPreview]=useState<SessionDeletePreview|null>(null);
  const [selected,setSelected]=useState<string[]>([]);
  const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const session=studio.document.sessions.find(s=>s.id===sessionId);
  async function inspect(){setLoading(true);setError('');setPreview(null);setSelected([]);try{setPreview(await studio.previewDeleteSession(sessionId));}catch(error){setError(String(error));}finally{setLoading(false);}}
  useEffect(()=>{void inspect();},[sessionId]);
  if(!session)return null;
  async function remove(){if(!preview||saving||!session)return;setSaving(true);setError('');try{await studio.deleteSession(sessionId,selected,preview.token);onDeleted(session.workspaceId);}catch(error){setError(String(error));setPreview(null);}finally{setSaving(false);}}
  return <Modal title="删除会话" onClose={()=>{if(!saving)onClose();}}><form onSubmit={event=>{event.preventDefault();void remove();}}><div className="modal-content">
    <div className="move-session-summary"><Trash2/><div><strong>{session.title}</strong><span>{studio.document.workspaces.find(w=>w.id===session.workspaceId)?.name}</span></div></div>
    {loading&&<p className="delete-session-notice"><LoaderCircle className="spin" size={14}/>正在检查图片引用…</p>}
    {preview&&<><p className="modal-description">将删除此会话、生成任务记录和 {preview.removedResultCount} 张未被共享使用的生成图片。</p>
      {(preview.preservedReferenceCount>0||preview.preservedResultCount>0)&&<p className="delete-session-notice">{preview.preservedReferenceCount>0&&<>保留 {preview.preservedReferenceCount} 张全局、共享或预设使用的参考图。</>}{preview.preservedResultCount>0&&<>另有 {preview.preservedResultCount} 张生成图片正在被其他会话、全局参考图库或预设使用，将保留为参考素材。</>}</p>}
      {preview.removableReferences.length>0&&<section className="delete-reference-section" aria-label="可同时移除的参考图"><div className="panel-label"><span>以下参考图仅由此会话使用，是否同时移除？</span></div><div className="delete-reference-list">{preview.removableReferences.map(asset=><label key={asset.id} className="delete-reference-option"><input type="checkbox" checked={selected.includes(asset.id)} disabled={saving} onChange={event=>setSelected(ids=>event.target.checked?[...ids,asset.id]:ids.filter(id=>id!==asset.id))}/><img src={studio.imageUrl(asset,true)} alt=""/><span>{asset.title}</span></label>)}</div></section>}
      <p className="delete-session-notice">会话记录和移除的图片会打包送入 Windows 回收站。未勾选的参考图继续保留。</p>
    </>}
    {error&&<div role="alert"><p className="option-error">{error}</p><button className="button secondary small" type="button" disabled={saving} onClick={()=>void inspect()}><RefreshCw/>重新检查引用</button></div>}
  </div><footer className="modal-footer"><button className="button secondary" type="button" disabled={saving} onClick={onClose}>取消</button><button className="button danger" type="submit" disabled={!preview||loading||saving}>{saving?<LoaderCircle className="spin"/>:<Trash2/>}{saving?'正在删除':'删除会话'}</button></footer></form></Modal>;
}
