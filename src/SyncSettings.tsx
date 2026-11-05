import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Cloud, LoaderCircle, RefreshCw, Save } from 'lucide-react';
import { desktop, type Studio } from './useStudio';

import type { SyncConfig, SyncView } from './syncState';
const initial:SyncConfig={enabled:false,url:'https://gis.inariaimu.synology.me:41658',deviceId:'',direct:true};
const names:Record<string,string>={sessions:'会话',workspaces:'工作区',assets:'图片',presets:'预设',jobs:'任务记录',providers:'模型提供商'};
export default function SyncSettings({studio}:{studio:Studio}){
  const view=studio.sync;const [config,setConfig]=useState(initial);const [token,setToken]=useState('');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  useEffect(()=>{if(!desktop)return;let active=true;
    void studio.refreshSync().then(v=>{if(active&&v?.config.url)setConfig(v.config);}).catch(e=>active&&setError(String(e)));
    return()=>{active=false;};
  },[studio.refreshSync]);
  async function act(action:'save'|'sync'){
    setBusy(true);setError('');try{
      if(action==='save'){const v=await invoke<SyncView>('save_sync_config',{config,token:token||null});setConfig(v.config);setToken('');await studio.refreshSync();studio.notify('同步设置已保存');}
      else {await studio.syncNow();}
    }catch(e){setError(String(e));}finally{setBusy(false);}
  }
  async function resolve(key:string,useLocal:boolean){setBusy(true);setError('');try{await invoke('resolve_sync_conflict',{key,useLocal});await studio.refresh();await studio.refreshSync();}catch(e){setError(String(e));}finally{setBusy(false);}}
  async function importConnection(){setBusy(true);setError('');try{const path=await open({multiple:false,filters:[{name:'Studio 同步连接',extensions:['json']}]});if(!path)return;const v=await invoke<SyncView>('import_sync_config',{path});setConfig(v.config);setToken('');await studio.refreshSync();studio.notify('同步连接已导入');}catch(e){setError(String(e));}finally{setBusy(false);}}
  const disabled=busy||studio.syncBusy||view?.status.running||!desktop;
  const dirty=!!view&&JSON.stringify(config)!==JSON.stringify(view.config);
  return <section className="settings-section sync-settings" aria-labelledby="sync-title">
    <div className="settings-section-heading"><Cloud/><div><h2 id="sync-title">多设备同步</h2><p>在电脑之间接续创作，同步会话、草稿、参考图、生成结果与模型提供商。</p></div></div>
    <label className="sync-toggle"><input type="checkbox" checked={config.enabled} disabled={disabled} onChange={e=>setConfig({...config,enabled:e.target.checked})}/>启用自动同步（每 300 秒 / 5 分钟）</label>
    <p className="field-help">关闭自动同步后，仍可从标题栏或此处立即同步。</p>
    <label className="field"><span className="field-label">同步服务地址</span><input aria-label="同步服务地址" value={config.url} disabled={disabled} onChange={e=>setConfig({...config,url:e.target.value})} spellCheck={false}/></label>
    <label className="field"><span className="field-label">设备 ID</span><input aria-label="同步设备 ID" value={config.deviceId} disabled={disabled||!!view?.config.deviceId} onChange={e=>setConfig({...config,deviceId:e.target.value})} placeholder="填写服务端为本电脑分配的设备 ID" spellCheck={false}/></label>
    <label className="field"><span className="field-label">设备令牌</span><input aria-label="同步设备令牌" type="password" autoComplete="new-password" value={token} disabled={disabled} onChange={e=>setToken(e.target.value)} placeholder={view?.hasToken?'已保存，留空保持不变':'填写此设备对应的令牌'}/></label>
    <label className="sync-toggle"><input type="checkbox" checked={config.direct} disabled={disabled} onChange={e=>setConfig({...config,direct:e.target.checked})}/>同步服务直连（关闭后使用应用网络设置）</label>
    <p className="field-help">令牌保存在 Windows 凭据管理器。各电脑分别填写模型 API Key；界面设置、代理、用量与设备身份保留在本机。创作任务结束后再同步，原图会自动下载。</p>
    <div className="network-actions"><button className="button primary" disabled={disabled||!config.url||!config.deviceId} onClick={()=>void act('save')}><Save/>保存同步设置</button><button className="button secondary" disabled={disabled||!view?.hasToken||!view.config.url||dirty||!!token} onClick={()=>void act('sync')}>{studio.syncBusy||view?.status.running?<LoaderCircle className="spin"/>:<RefreshCw/>}立即同步</button><button className="button secondary" disabled={disabled} onClick={()=>void importConnection()}>导入连接文件</button></div>
    <p role="status" className="field-help">{view?.status.running?'正在同步…':view?.status.lastSuccess?`最近同步：${new Date(view.status.lastSuccess).toLocaleString()} · 上传 ${view.status.uploaded} 张，下载 ${view.status.downloaded} 张`:'尚未完成同步'}</p>
    {!!view?.pending&&<p className="field-help">待上传 {view.pending} 条记录</p>}
    {(error||view?.status.error)&&<p role="alert" className="network-result error">{error||view?.status.error}</p>}
    {!!view?.conflicts.length&&<div className="sync-conflicts"><h3>需要处理的冲突 · {view.conflicts.length}</h3><p className="field-help">双方内容均已保留，以下记录暂停上传。选择后，下次同步会继续。</p>{view.conflicts.map(c=><article className="sync-conflict" key={c.key}><strong>{names[c.key.split('/')[0]]||'记录'} · {String(c.local?.title||c.local?.name||c.remote?.title||c.remote?.name||c.key)}</strong><div className="sync-conflict-values">{([['本机',c.local],['服务器',c.remote]] as const).map(([label,value])=><div key={label}><b>{label}</b><pre>{value?String(value.draft??value.submittedPrompt??value.prompt??value.title??value.name??'记录已更新'):'已删除'}</pre></div>)}</div><div className="network-actions"><button className="button secondary small" disabled={disabled} onClick={()=>void resolve(c.key,true)}>保留本机版本</button><button className="button secondary small" disabled={disabled} onClick={()=>void resolve(c.key,false)}>采用服务器版本</button></div></article>)}</div>}
  </section>;
}
