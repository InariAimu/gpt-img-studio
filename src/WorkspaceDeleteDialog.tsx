import { useState } from 'react';
import { LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import { Modal } from './components';
import type { StudioDocument, WorkspaceDeletePreview } from './types';
import type { Studio } from './useStudio';

export default function WorkspaceDeleteDialog({studio,workspaceId,initialPreview,onClose,onDeleted}:{studio:Studio;workspaceId:string;initialPreview:WorkspaceDeletePreview;onClose:()=>void;onDeleted:(document:StudioDocument)=>void}) {
  const [preview,setPreview]=useState<WorkspaceDeletePreview|null>(initialPreview);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const workspace=studio.document.workspaces.find(w=>w.id===workspaceId);
  async function inspect(){setBusy(true);setError('');try{setPreview(await studio.previewDeleteWorkspace(workspaceId));}catch(error){setError(String(error));}finally{setBusy(false);}}
  async function remove(){if(!preview||busy)return;setBusy(true);setError('');try{onDeleted(await studio.deleteWorkspace(workspaceId,preview.token));}catch(error){setError(String(error));setPreview(null);}finally{setBusy(false);}}
  return <Modal title="删除工作区" onClose={()=>{if(!busy)onClose();}}><form onSubmit={event=>{event.preventDefault();void remove();}}><div className="modal-content">
    <div className="move-session-summary"><Trash2/><div><strong>{workspace?.name || '工作区'}</strong><span>删除工作区及其中的创作会话</span></div></div>
    {preview&&<>
      <p className="modal-description">此工作区当前有 <strong>{preview.sessionCount} 个会话（Session）</strong>，关联 <strong>{preview.referenceCount} 张参考图</strong>（去重）。是否删除？</p>
      <p className="delete-session-notice">将删除工作区、其中的全部会话和任务记录，以及 {preview.removedResultCount} 张生成图片。参考图全部保留，可继续从参考图库使用。</p>
      {preview.preservedResultCount>0&&<p className="delete-session-notice">另有 {preview.preservedResultCount} 张生成图片被其他会话、参考图库或预设使用，将保留为参考素材。</p>}
      <p className="delete-session-notice">移除的记录和图片会打包送入 Windows 回收站。</p>
    </>}
    {error&&<div role="alert"><p className="option-error">{error}</p><button className="button secondary small" type="button" disabled={busy} onClick={()=>void inspect()}><RefreshCw/>重新检查数量</button></div>}
  </div><footer className="modal-footer"><button className="button secondary" type="button" disabled={busy} onClick={onClose}>取消</button><button className="button danger" type="submit" disabled={!preview||busy}>{busy?<LoaderCircle className="spin"/>:<Trash2/>}{busy?'正在处理':'删除工作区'}</button></footer></form></Modal>;
}
