import { useRef, useState } from 'react';
import { Ban, LoaderCircle, Undo2 } from 'lucide-react';
import type { Session } from './types';
import type { Studio } from './useStudio';

export default function SessionDiscardButton({sessions,studio}:{sessions:Session[];studio:Studio}) {
  const [saving,setSaving]=useState(false);
  const busy=useRef(false);
  const discarded=sessions.length>0&&sessions.every(session=>session.discarded);
  async function toggle() {
    if(busy.current||!sessions.length)return;
    busy.current=true;setSaving(true);
    try {
      await studio.mutate({type:'set_sessions_discarded',sessionIds:sessions.map(session=>session.id),discarded:!discarded});
      studio.notify(discarded?`已恢复 ${sessions.length} 个会话`:`已将 ${sessions.length} 个会话标记为废弃`);
    } catch(error) {studio.report(error);} finally {busy.current=false;setSaving(false);}
  }
  return <button type="button" className="button secondary small" disabled={saving||!sessions.length} title={discarded?'取消所选会话的废弃标记':'标记所选会话及全部版本为废弃，保留图片和记录'} onClick={()=>void toggle()}>{saving?<LoaderCircle className="spin"/>:discarded?<Undo2/>:<Ban/>}{discarded?'恢复会话':'标记废弃'}</button>;
}
