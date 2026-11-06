import { useEffect, useState } from 'react';
import { FolderInput, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import { Modal } from './components';
import { OptionSelect } from './OptionSelect';
import type { WorkspaceDeletePreview } from './types';
import type { Studio } from './useStudio';

export default function BatchSessionDialog({studio,workspaceId,sessionIds,operation,onClose,onCompleted}:{studio:Studio;workspaceId:string;sessionIds:string[];operation:'move'|'delete';onClose:()=>void;onCompleted:()=>void}) {
  const [target,setTarget]=useState('');
  const [preview,setPreview]=useState<WorkspaceDeletePreview|null>(null);
  const [loading,setLoading]=useState(operation==='delete');
  const [saving,setSaving]=useState(false),[error,setError]=useState('');
  const deleting=operation==='delete';
  const destinations=studio.document.workspaces.filter(w=>w.id!==workspaceId);
  const images=studio.document.assets.filter(a=>sessionIds.includes(a.sessionId)&&!a.demo&&a.model!=='本地导入'&&!a.referenceOnly).length;
  const busy=studio.document.jobs.some(j=>j.status==='running')||studio.document.sessions.some(s=>s.titleStatus==='pending');
  async function inspect(){setLoading(true);setError('');setPreview(null);try{setPreview(await studio.previewDeleteSessions(workspaceId,sessionIds));}catch(error){setError(String(error));}finally{setLoading(false);}}
  useEffect(()=>{if(deleting)void inspect();},[workspaceId,sessionIds,deleting]);
  async function submit(){
    if(saving||loading||(deleting?!preview:!target))return;
    setSaving(true);setError('');
    try{
      if(deleting)await studio.deleteSessions(workspaceId,sessionIds,preview!.token);
      else await studio.moveSessions(workspaceId,sessionIds,target);
      onCompleted();
    }catch(error){setError(String(error));if(deleting)setPreview(null);}finally{setSaving(false);}
  }
  return <Modal title={deleting?'批量删除会话':'批量移动会话'} onClose={()=>{if(!saving)onClose();}}><form onSubmit={event=>{event.preventDefault();void submit();}}><div className="modal-content">
    <div className="move-session-summary">{deleting?<Trash2/>:<FolderInput/>}<div><strong>已选 {sessionIds.length} 个会话 · {images} 张生成图片</strong><span>{studio.document.workspaces.find(w=>w.id===workspaceId)?.name}</span></div></div>
    {deleting?<>
      {loading&&<p className="delete-session-notice"><LoaderCircle className="spin" size={14}/>正在检查图片引用…</p>}
      {preview&&<><p className="modal-description">将删除 <strong>{preview.sessionCount} 个会话</strong>的全部版本和任务记录，移除 <strong>{preview.removedResultCount} 张生成图片</strong>。是否继续？</p><p className="delete-session-notice">关联的 {preview.referenceCount} 张参考图（去重）全部保留。</p>{preview.preservedResultCount>0&&<p className="delete-session-notice">另有 {preview.preservedResultCount} 张生成图片被其他会话、参考图库或预设使用，将保留为参考素材。</p>}<p className="delete-session-notice">移除的记录和图片会打包送入 Windows 回收站，工作区继续保留。</p></>}
    </>:<><label className="field"><span className="field-label">目标工作区</span><OptionSelect aria-label="批量移动的目标工作区" value={target} onValueChange={setTarget} disabled={saving} required><option value="" disabled>选择目标工作区</option>{destinations.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</OptionSelect></label><p className="move-session-description">所选会话的全部版本、输入和历史记录一起移动。共享参考图在各工作区保留独立引用，并复用原图文件。</p>{!destinations.length&&<p className="option-error">请先创建另一个工作区。</p>}</>}
    {busy&&<p className="option-error">请等待后台生成或命名完成后再操作。</p>}
    {error&&<div role="alert"><p className="option-error">{error}</p>{deleting&&<button className="button secondary small" type="button" disabled={saving||loading} onClick={()=>void inspect()}><RefreshCw/>重新检查数量</button>}</div>}
  </div><footer className="modal-footer"><button className="button secondary" type="button" disabled={saving} onClick={onClose}>取消</button><button className={`button ${deleting?'danger':'primary'}`} type="submit" disabled={saving||loading||busy||(deleting?!preview:!target)}>{saving?<LoaderCircle className="spin"/>:deleting?<Trash2/>:<FolderInput/>}{saving?'正在处理':deleting?'确认批量删除':'确认批量移动'}</button></footer></form></Modal>;
}
