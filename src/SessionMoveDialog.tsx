import { OptionSelect } from './OptionSelect';
import { useState } from 'react';
import { FolderInput, LoaderCircle } from 'lucide-react';
import { Modal } from './components';
import type { Studio } from './useStudio';

export default function SessionMoveDialog({studio,sessionId,onClose,onMoved}:{studio:Studio;sessionId:string;onClose:()=>void;onMoved:(sessionId:string,workspaceId:string)=>void}) {
  const [target,setTarget]=useState(''),[saving,setSaving]=useState(false);
  const session=studio.document.sessions.find(s=>s.id===sessionId);
  if(!session)return null;
  const workspace=studio.document.workspaces.find(w=>w.id===session.workspaceId);
  const destinations=studio.document.workspaces.filter(w=>w.id!==session.workspaceId);
  const images=studio.document.assets.filter(a=>a.sessionId===sessionId).length;
  const busy=studio.document.jobs.some(j=>j.status==='running')||studio.document.sessions.some(s=>s.titleStatus==='pending');
  async function move(){if(!target||saving)return;setSaving(true);try{await studio.moveSession(sessionId,target);onMoved(sessionId,target);}catch(error){studio.report(error);}finally{setSaving(false);}}
  return <Modal title="移动会话" onClose={()=>{if(!saving)onClose();}}><form onSubmit={event=>{event.preventDefault();void move();}}><div className="modal-content"><div className="move-session-summary"><FolderInput/><div><strong>{session.title}</strong><span>{workspace?.name} · {images} 张生成图片</span></div></div><label className="field"><span className="field-label">目标工作区</span><OptionSelect aria-label="目标工作区" value={target} onValueChange={value=>setTarget(value)} disabled={saving} required><option value="" disabled>选择目标工作区</option>{destinations.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</OptionSelect></label><p className="move-session-description">生成图片、会话输入和历史记录一起移动。共享参考图在各工作区保留独立引用，并复用原图文件。</p>{!destinations.length&&<p className="option-error">请先创建另一个工作区。</p>}{busy&&<p className="option-error">后台任务完成后即可移动。</p>}</div><footer className="modal-footer"><button className="button secondary" type="button" disabled={saving} onClick={onClose}>取消</button><button className="button primary" type="submit" disabled={!target||saving||busy}>{saving?<LoaderCircle className="spin"/>:<FolderInput/>}移动会话</button></footer></form></Modal>;
}
