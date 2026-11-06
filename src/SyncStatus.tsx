import { useEffect, useRef, useState } from 'react';
import { ChevronDown, CircleAlert, Cloud, CloudCheck, LoaderCircle, RefreshCw, Settings2 } from 'lucide-react';
import { desktop, type Studio } from './useStudio';

export default function SyncStatus({studio,onSettings}:{studio:Studio;onSettings:()=>void}) {
  const [open,setOpen]=useState(false);
  const root=useRef<HTMLDivElement>(null);
  const trigger=useRef<HTMLButtonElement>(null);
  const view=studio.sync;
  const busy=studio.syncBusy||!!view?.status.running;
  const paused=!!view?.status.pausedForGallery;
  const configured=!!view?.config.url&&!!view.hasToken;
  const issue=!!view?.status.error||!!view?.conflicts.length;
  const label=busy?'正在同步':paused?'导入中 · 同步暂停':!desktop?'同步预览':!view?'读取同步状态':!configured?'未配置同步':view.conflicts.length?`${view.conflicts.length} 项冲突`:view.status.error?'同步失败':view.pending?`${view.pending} 条待同步`:view.status.lastSuccess?'已同步':'等待同步';
  const Icon=busy?LoaderCircle:issue?CircleAlert:view?.status.lastSuccess&&!view.pending?CloudCheck:Cloud;
  useEffect(()=>{
    if(!open)return;
    const close=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};
    const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){setOpen(false);trigger.current?.focus();}};
    document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);};
  },[open]);
  async function synchronize(){try{await studio.syncNow();}catch(error){studio.report(error);}}
  return <div className="titlebar-sync" ref={root}>
    <button ref={trigger} className={`sync-indicator ${issue?'has-error':''}`} aria-label={`同步状态：${label}`} aria-expanded={open} aria-controls="titlebar-sync-panel" onClick={()=>{setOpen(!open);if(!open)void studio.refreshSync().catch(studio.report);}}>
      <Icon className={busy?'spin':''}/><span>{label}</span><ChevronDown className="sync-chevron"/>
    </button>
    <button className="sync-now" aria-label="立即同步" title="立即同步" disabled={!desktop||!configured||busy||paused} onClick={()=>void synchronize()}><RefreshCw className={busy?'spin':''}/></button>
    {open&&<section className="sync-popover" id="titlebar-sync-panel" aria-label="多设备同步状态">
      <div className="sync-popover-heading"><strong>多设备同步</strong><span>{view?.config.enabled?'每 300 秒':'手动同步'}</span></div>
      <p className="sync-server">{view?.config.url||'配置连接后，可在其他电脑接续创作'}</p>
      <p role="status">{paused?'图库导入期间暂停同步，任务结束后恢复定时同步。':busy?'正在同步创作记录与图片…':view?.status.lastSuccess?`最近成功：${new Date(view.status.lastSuccess).toLocaleTimeString()}`:'尚未完成同步'}</p>
      {configured&&<p>待上传 {view?.pending??0} 条记录{view?.status.lastSuccess?` · 上传 ${view.status.uploaded} 张 / 下载 ${view.status.downloaded} 张`:''}</p>}
      {!!view?.conflicts.length&&<p className="sync-problem">有 {view.conflicts.length} 项冲突，请在同步设置中处理。</p>}
      {view?.status.error&&<p className="sync-problem" role="alert">{view.status.error}</p>}
      <div className="sync-popover-actions"><button className="button secondary small" onClick={()=>{setOpen(false);onSettings();}}><Settings2/>同步设置</button><button className="button primary small" disabled={!desktop||!configured||busy||paused} onClick={()=>void synchronize()}>{busy?<LoaderCircle className="spin"/>:<RefreshCw/>}立即同步</button></div>
    </section>}
  </div>;
}
