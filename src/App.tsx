import { OptionSelect } from './OptionSelect';
import ErrorDetails from './ErrorDetails';
import { useEffect, useMemo, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ArrowDownToLine, ArrowUpRight, Check, CircleAlert, CircleCheck, Clock3, Columns3, FolderInput, Heart, ImagePlus, Images, Layers, ListChecks, LoaderCircle, Maximize2, Minimize2, Minus, Moon, Pencil, Plus, Search, Settings2, SlidersHorizontal, Sun, Trash2, WandSparkles, X } from 'lucide-react';
import { AssetCard, AssetInspector, Empty, Modal, timeLabel } from './components';
import { Lightbox } from './Lightbox';
import { messageReferences } from './messageReferences';
import { assetStackKey, stackAssets } from './assetStacks';
import { desktop, useStudio, type Studio } from './useStudio';
import Workspace from './Workspace';
import WorkspaceTree from './WorkspaceTree';
import Settings, { type SettingsTab } from './Settings';
import SyncStatus from './SyncStatus';
import SessionMoveDialog from './SessionMoveDialog';
import SessionDeleteDialog from './SessionDeleteDialog';
import WorkspaceDeleteDialog from './WorkspaceDeleteDialog';
import BatchSessionDialog from './BatchSessionDialog';
import GalleryImportDialog from './GalleryImportDialog';
import Tasks, { type TaskTab } from './Tasks';
import PhotoWall, { type PreviewSize } from './PhotoWall';
import type { Asset, Page, StudioDocument, WorkspaceDeletePreview } from './types';

type DialogState = { kind: 'create' | 'workspace'; workspaceId?: string } | { kind: 'preset'; assetId: string } | {kind:'move';sessionId:string} | {kind:'delete';sessionId:string} | {kind:'rename-workspace';workspaceId:string} | {kind:'delete-workspace';workspaceId:string;preview:WorkspaceDeletePreview} | null;
function isGeneratedAsset(asset:Asset){return !asset.demo&&!!asset.sessionId&&asset.model!=='本地导入'&&!asset.referenceOnly;}
function readNavigation() { try { return JSON.parse(localStorage.getItem('image-studio.navigation') || '{}') as { page?: Page; sessionId?: string; workspaceId?: string }; } catch { return {}; } }
function readGalleryView():{mode:'cards'|'wall';size:PreviewSize} {
  try {const saved=JSON.parse(localStorage.getItem('image-studio.gallery-view')||'{}');return {mode:saved.mode==='wall'?'wall':'cards',size:saved.size==='large'||saved.size==='xlarge'?saved.size:'normal'};}catch{return {mode:'cards',size:'normal'};}
}

export default function App() {
  const studio = useStudio();
  const initial = useState(readNavigation)[0];
  const [page, setPage] = useState<Page>(initial.page && ['gallery', 'workspace-gallery', 'workspace', 'references', 'presets', 'jobs', 'settings'].includes(initial.page) ? initial.page : 'gallery');
  const [sessionId, setSessionId] = useState(initial.sessionId || 'demo-material');
  const [workspaceId, setWorkspaceId] = useState(initial.workspaceId || 'demo-plush');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [lightboxScope,setLightboxScope]=useState<string[]|null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [checkingWorkspace,setCheckingWorkspace]=useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [galleryWorkspace, setGalleryWorkspace] = useState('all');
  const [stack, setStack] = useState(true);
  const [galleryView,setGalleryView]=useState(readGalleryView);
  useEffect(()=>{try{localStorage.setItem('image-studio.gallery-view',JSON.stringify(galleryView));}catch{/* View preferences are optional. */}},[galleryView]);
  const [selecting,setSelecting]=useState(false);
  const [selectedSessions,setSelectedSessions]=useState<string[]>([]);
  const [batchDialog,setBatchDialog]=useState<{operation:'move'|'delete';workspaceId:string;sessionIds:string[]}|null>(null);
  const [showSamples, setShowSamples] = useState(true);
  const [referenceTab, setReferenceTab] = useState('global');
  const [taskTab,setTaskTab]=useState<TaskTab>('all');
  const [settingsTab,setSettingsTab]=useState<SettingsTab>('general');
  const doc = studio.document;
  const currentSession = doc.sessions.find(s => s.id === sessionId) || doc.sessions[0];
  const currentWorkspace = doc.workspaces.find(w => w.id === workspaceId) || doc.workspaces[0] || {id:'',name:'',createdAt:''};
  const workspaceGallery=page==='workspace-gallery'&&!!currentWorkspace.id;
  const isImageGallery=page==='gallery'||workspaceGallery;
  const isGallery=isImageGallery||page==='references';
  useEffect(()=>{if(page==='workspace-gallery'&&!currentWorkspace.id)setPage('gallery');},[page,currentWorkspace.id]);
  const galleryScopeId=workspaceGallery?currentWorkspace.id:null;
  useEffect(()=>{setSelecting(false);setSelectedSessions([]);},[page,galleryScopeId]);
  useEffect(()=>{setSelectedSessions([]);},[query,filter]);
  const selected = doc.assets.find(a => a.id === selectedId);
  const lightbox = doc.assets.find(a => a.id === lightboxId);
  const running = doc.jobs.filter(j => j.status === 'running').length + studio.galleryTasks.filter(t=>['queued','running'].includes(t.status)).length;
  const historyReferenceIds = new Set([...doc.sessions.flatMap(s => s.referenceIds), ...doc.assets.flatMap(a => a.referenceIds)]);

  useEffect(() => {
    document.documentElement.dataset.theme = doc.settings.theme;
    document.documentElement.style.setProperty('--accent-base', doc.settings.accent);
  }, [doc.settings.theme, doc.settings.accent]);
  useEffect(() => { localStorage.setItem('image-studio.navigation', JSON.stringify({ page, sessionId, workspaceId })); }, [page, sessionId, workspaceId]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'n') { event.preventDefault(); setDialog({ kind: 'create', workspaceId }); }
      if (event.ctrlKey && event.key.toLowerCase() === 'f' && (page === 'gallery'||page==='workspace-gallery')) { event.preventDefault(); document.getElementById('gallery-search')?.focus(); }
    };
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut);
  }, [page, workspaceId]);

  function openImage(id:string,scopeIds?:string[]){setLightboxScope(scopeIds??null);setLightboxId(id);}
  function openSession(id: string) {
    const session = doc.sessions.find(s => s.id === id);
    if (!session) return;
    setSessionId(id); setWorkspaceId(session.workspaceId); setPage('workspace');
  }
  function openWorkspace(id:string){
    if(!doc.workspaces.some(w=>w.id===id))return;
    setWorkspaceId(id);setPage('workspace-gallery');setQuery('');setFilter('all');setGalleryWorkspace('all');setStack(true);setSelectedId(null);
  }
  function workspaceDeleted(document:StudioDocument) {
    setSessionId('');setWorkspaceId(document.workspaces[0]?.id||'');setSelectedId(null);setLightboxId(null);
    setGalleryWorkspace('all');setQuery('');setFilter('all');setPage(document.workspaces.length?'workspace-gallery':'gallery');setDialog(null);
  }
  async function requestWorkspaceDelete() {
    if(checkingWorkspace||!currentWorkspace.id)return;
    setCheckingWorkspace(true);
    try {
      const preview=await studio.previewDeleteWorkspace(currentWorkspace.id);
      if(preview.sessionCount===0)workspaceDeleted(await studio.deleteWorkspace(currentWorkspace.id,preview.token));
      else setDialog({kind:'delete-workspace',workspaceId:currentWorkspace.id,preview});
    }catch(error){studio.report(error);}finally{setCheckingWorkspace(false);}
  }
  async function createSession(options: { workspaceId: string; title?: string; parentAssetId?: string; copyInputAssetId?: string; presetId?: string }) {
    try {
      const next = await studio.mutate({ type: 'create_session', ...options });
      const session = next.sessions.at(-1)!;
      setSessionId(session.id); setWorkspaceId(session.workspaceId); setPage('workspace'); setDialog(null);
      if (options.copyInputAssetId) {
        const source = doc.assets.find(asset=>asset.id===options.copyInputAssetId);
        studio.notify(source?.previousResponseId ? '已复制本轮输入；原会话的历史上下文不会带入，请检查提示词是否完整' : '已复制本轮输入到新会话，可修改后生成');
      }
    } catch (error) { studio.report(error); }
  }
  function branch(asset: Asset) { const title=doc.sessions.find(session=>session.id===asset.sessionId)?.title||asset.title; void createSession({ workspaceId: asset.workspaceId || currentWorkspace.id, parentAssetId: asset.id, title: `${title.slice(0, 20)} · 以图创作` }); }
  function copyInputs(asset: Asset) { const title=doc.sessions.find(session=>session.id===asset.sessionId)?.title||asset.title; void createSession({ workspaceId: asset.workspaceId || currentWorkspace.id, copyInputAssetId: asset.id, title: `${title.slice(0, 20)} · 输入副本` }); }
  async function importGallery(asReference: boolean) {
    try { const ids = await studio.importImages(asReference); if (ids.length) setSelectedId(ids[0]); } catch (error) { studio.report(error); }
  }
  const assets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const result = doc.assets.filter(asset => {
      if(workspaceGallery&&(asset.workspaceId!==galleryScopeId||!isGeneratedAsset(asset)))return false;
      if (page === 'references') {
        if (asset.demo) return false;
        if (referenceTab === 'global' && !asset.isReference) return false;
        if (referenceTab === 'history' && !historyReferenceIds.has(asset.id)) return false;
      }
      if (!showSamples && asset.demo) return false;
      if (filter === 'favorites' && !asset.favorite) return false;
      if (filter === 'generated' && !isGeneratedAsset(asset)) return false;
      if (filter === 'imported' && asset.model !== '本地导入') return false;
      if (!workspaceGallery && galleryWorkspace !== 'all' && asset.workspaceId !== galleryWorkspace) return false;
      const workspace = doc.workspaces.find(w => w.id === asset.workspaceId);
      const session = doc.sessions.find(s => s.id === asset.sessionId);
      return !normalized || `${asset.title} ${session?.title || ''} ${asset.originalPrompt} ${asset.submittedPrompt} ${workspace?.name || ''}`.toLowerCase().includes(normalized);
    });
    return stack && isImageGallery ? stackAssets(result) : result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [doc.assets, doc.workspaces, doc.sessions, query, page, showSamples, filter, galleryWorkspace, stack, referenceTab, workspaceGallery, galleryScopeId, isImageGallery]);
  const showInspector = selected && page === 'references' && assets.some(a => a.id === selected.id);
  const workspaceSessionIds=new Set(doc.sessions.filter(s=>s.workspaceId===galleryScopeId).map(s=>s.id));
  const visibleSessionIds=[...new Set(assets.map(a=>a.sessionId).filter(id=>workspaceSessionIds.has(id)))];
  const selectedSessionIds=selectedSessions.filter(id=>workspaceSessionIds.has(id)&&visibleSessionIds.includes(id));
  const selectedImageCount=doc.assets.filter(a=>selectedSessionIds.includes(a.sessionId)&&isGeneratedAsset(a)).length;
  function toggleSession(id:string){if(workspaceSessionIds.has(id))setSelectedSessions(ids=>ids.includes(id)?ids.filter(value=>value!==id):[...ids,id]);}
  const renderAsset=(asset:Asset)=><AssetCard key={asset.id} asset={asset} studio={studio} title={isImageGallery ? doc.sessions.find(session=>session.id===asset.sessionId)?.title : undefined} showFormatBadge={workspaceGallery} showSubtitle={!isImageGallery} wall={isImageGallery&&galleryView.mode==='wall'} selecting={workspaceGallery&&selecting} active={workspaceGallery&&selecting?selectedSessionIds.includes(asset.sessionId):page==='references' ? asset.id===selectedId : undefined} versions={stack&&isImageGallery ? doc.assets.filter(a=>assetStackKey(a)===assetStackKey(asset)&&(!workspaceGallery||(a.workspaceId===galleryScopeId&&isGeneratedAsset(a)))).length : 1} onSelect={() => { if(workspaceGallery&&selecting)toggleSession(asset.sessionId); else if (!isImageGallery) setSelectedId(asset.id); else if (doc.sessions.some(session=>session.id===asset.sessionId)) openSession(asset.sessionId); else openImage(asset.id); }} onOpen={page==='references' ? ()=>openImage(asset.id) : undefined} />;

  return <div className="app-shell">
    <Titlebar studio={studio} onSyncSettings={()=>{setSettingsTab('sync');setPage('settings');}} />
    <aside className="sidebar"><div className="sidebar-top"><nav aria-label="主要导航">{([
      ['gallery', Images, '图库'], ['references', ImagePlus, '参考图'], ['presets', WandSparkles, '效果预设'], ['jobs', ListChecks, '任务'],
    ] as const).map(([key, Icon, label]) => <button key={key} className={`nav-item ${page === key ? 'active' : ''}`} aria-current={page === key ? 'page' : undefined} onClick={() => { setPage(key); setQuery(''); setFilter('all'); setGalleryWorkspace('all'); }}><Icon /><span>{label}</span>{key === 'jobs' && running > 0 && <span className="nav-count">{running}</span>}</button>)}</nav>
      <div className="workspace-caption"><span>工作区</span><button className="icon-button" aria-label="新建工作区" onClick={() => setDialog({ kind: 'workspace' })}><Plus /></button></div>
      <WorkspaceTree studio={studio} currentId={workspaceGallery || page === 'workspace' ? workspaceId : undefined} onOpen={openWorkspace} onRename={id => setDialog({kind:'rename-workspace',workspaceId:id})} onCreate={id => setDialog({kind:'create',workspaceId:id})} />
    </div><div className="sidebar-bottom"><button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => setPage('settings')}><Settings2 /><span>设置</span><span className="version-label">v0.1</span></button>
      <div className="sidebar-status" aria-label="图库与保存状态">
        <div className="local-state"><span className={`status-dot ${studio.loadError ? 'error' : ''}`} /><span>{studio.loadError ? '图库载入失败' : desktop ? `本地图库${studio.ready ? '已就绪' : '读取中'}` : '浏览器预览'}</span></div>
        <div className="sidebar-storage-summary">{desktop && <><span>本地保存</span><span aria-hidden="true">·</span></>}<span>{doc.assets.filter(a => !a.demo).length} 张本地图片</span></div>
        <div className="sidebar-save-state">{running ? <button onClick={() => setPage('jobs')}><LoaderCircle className="spin" /><span>{running} 个任务</span></button> : <><Check /><span>{desktop ? '创作记录自动保存' : 'Windows 桌面版可使用全部功能'}</span></>}</div>
      </div>
    </div></aside>
    <main className="main-panel">
      {!studio.ready && <div className="loading-screen">{studio.loadError ? <><CircleAlert /><h2>无法读取本地图库</h2><p>{studio.loadError}</p><button className="button secondary" onClick={() => void studio.refresh().catch(studio.report)}>重试</button></> : <><LoaderCircle className="spin" /><p>正在打开你的创作空间…</p></>}</div>}
      {studio.ready && <>
        {isGallery && <><header className={`page-header ${workspaceGallery?'workspace-gallery-header':''}`}><div><h1>{workspaceGallery?<span className="workspace-gallery-title" title={currentWorkspace.name}>{currentWorkspace.name}</span>:page==='gallery'?'所有图片':'参考图库'}<span className="heading-count">{assets.length}</span></h1></div><div className="header-actions">{workspaceGallery?<><button className="button secondary" aria-label="重命名当前工作区" onClick={()=>setDialog({kind:'rename-workspace',workspaceId:currentWorkspace.id})}><Pencil/>重命名</button><button className="button danger" aria-label="删除当前工作区" disabled={checkingWorkspace} onClick={()=>void requestWorkspaceDelete()}>{checkingWorkspace?<LoaderCircle className="spin"/>:<Trash2/>}{checkingWorkspace?'正在检查':'删除工作区'}</button></>:<button className="button secondary" onClick={()=>void importGallery(page==='references')}><ArrowDownToLine/>{page==='references'?'导入参考图':'导入图片'}</button>}{isImageGallery&&<button className="button primary" onClick={()=>setDialog({kind:'create',workspaceId:currentWorkspace.id})}><Plus/>新建创作</button>}</div></header>
          <div className={`gallery-layout ${showInspector ? 'has-inspector' : ''}`}><section className="gallery-panel" aria-label={page === 'references' ? '参考图列表' : '图片列表'}>
            <div className="gallery-toolbar"><label className="search-input"><Search /><input id="gallery-search" aria-label="搜索图片" placeholder={workspaceGallery?'搜索此工作区的图片、Prompt…':'搜索图片、Prompt、工作区…'} value={query} onChange={e => setQuery(e.target.value)} /><kbd>Ctrl F</kbd></label>{isImageGallery&&<><OptionSelect className="gallery-view-select" aria-label="展示模式" title="展示模式" value={galleryView.mode} onValueChange={mode=>setGalleryView(current=>({...current,mode:mode==='wall'?'wall':'cards'}))}><option value="cards">卡片模式</option><option value="wall">照片墙密铺</option></OptionSelect><OptionSelect className="gallery-size-select" aria-label="预览图大小" title="预览图大小" value={galleryView.size} onValueChange={size=>setGalleryView(current=>({...current,size:size as PreviewSize}))}><option value="normal">小</option><option value="large">中</option><option value="xlarge">大</option></OptionSelect></>}{isImageGallery && <div className="segment" role="group" aria-label="版本显示方式"><button aria-pressed={!stack} aria-label="平铺显示" disabled={selecting&&workspaceGallery} onClick={() => setStack(false)}><Columns3 /></button><button aria-pressed={stack} aria-label="堆叠版本" disabled={selecting&&workspaceGallery} onClick={() => setStack(true)}><Layers /></button></div>}{workspaceGallery&&<div className="filter-tabs" role="group" aria-label="筛选工作区图片">{[['all','全部'],['favorites','收藏']].map(([value,label])=><button className={filter===value?'selected':''} aria-pressed={filter===value} key={value} onClick={()=>setFilter(value)}>{value==='favorites'&&<Heart size={12}/>}{label}</button>)}</div>}{workspaceGallery&&<button className="button secondary" aria-pressed={selecting} disabled={!selecting&&!visibleSessionIds.length} onClick={()=>{setSelecting(value=>!value);setSelectedSessions([]);setStack(true);}}>{selecting?<X/>:<ListChecks/>}{selecting?'退出多选':'多选'}</button>}</div>
            {!workspaceGallery&&<div className="gallery-filters"><div className="filter-tabs">{page === 'references' ? <><button className={referenceTab === 'global' ? 'selected' : ''} onClick={() => setReferenceTab('global')}>全局参考图</button><button className={referenceTab === 'history' ? 'selected' : ''} onClick={() => setReferenceTab('history')}>会话历史引用</button></> : <>{[['all', '全部'], ['favorites', '收藏'], ['generated', '已生成'], ['imported', '本地导入']].map(([value, label]) => <button className={filter === value ? 'selected' : ''} key={value} onClick={() => setFilter(value)}>{value === 'favorites' && <Heart size={12} />}{label}</button>)}</>}</div><div className="gallery-filter-actions"><OptionSelect className="workspace-filter" aria-label="筛选工作区" value={galleryWorkspace} onValueChange={value=> setGalleryWorkspace(value)}><option value="all">全部工作区</option>{doc.workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</OptionSelect>{isImageGallery&&<label className="sample-toggle"><input type="checkbox" checked={showSamples} onChange={e => setShowSamples(e.target.checked)} />显示示例</label>}</div></div>}
            {workspaceGallery&&selecting&&<div className="gallery-batch-bar" role="region" aria-label="批量会话操作"><div className="gallery-batch-summary"><strong aria-live="polite">已选 {selectedSessionIds.length} 个会话 · {selectedImageCount} 张生成图片</strong><span>按会话选择，包含全部版本；更改筛选会清空选择。</span></div><div className="gallery-batch-actions"><button className="button secondary small" disabled={!visibleSessionIds.length} onClick={()=>setSelectedSessions(selectedSessionIds.length===visibleSessionIds.length?[]:visibleSessionIds)}>{selectedSessionIds.length===visibleSessionIds.length&&visibleSessionIds.length?'取消全选':'全选当前结果'}</button><button className="button secondary small" disabled={!selectedSessionIds.length} onClick={()=>setBatchDialog({operation:'move',workspaceId:currentWorkspace.id,sessionIds:selectedSessionIds})}><FolderInput/>移动到…</button><button className="button secondary small" disabled={!selectedSessionIds.length} onClick={()=>studio.requestGalleryImport(doc.assets.filter(a=>selectedSessionIds.includes(a.sessionId)&&isGeneratedAsset(a)).map(a=>a.id),assets.filter(a=>selectedSessionIds.includes(a.sessionId)).map(a=>a.id))}><ArrowUpRight/>导入图库…</button><button className="button danger small" disabled={!selectedSessionIds.length} onClick={()=>setBatchDialog({operation:'delete',workspaceId:currentWorkspace.id,sessionIds:selectedSessionIds})}><Trash2/>批量删除</button></div></div>}
            {isImageGallery&&galleryView.mode==='wall'?<PhotoWall assets={assets} size={galleryView.size} renderAsset={renderAsset}/>:<div className="asset-grid" data-preview-size={isImageGallery?galleryView.size:'normal'}>{assets.map(renderAsset)}</div>}
            {!assets.length && <Empty title={query || filter !== 'all' ? '没有匹配的图片' : page === 'references' ? '为下一次创作准备素材' : workspaceGallery?'工作区还没有生成图片':'你的第一张作品，从这里开始'} description={query || filter !== 'all' ? '换一个关键词或筛选条件试试。' : page === 'references' ? '导入图片，或在作品详情中将图片加入全局参考图库。' : workspaceGallery?'在此工作区开始创作，生成的作品会汇集在这里。':'新建创作，或导入已有的图片。'}>{workspaceGallery?<button className="button secondary" onClick={()=>setDialog({kind:'create',workspaceId:currentWorkspace.id})}><Plus/>新建创作</button>:<button className="button secondary" onClick={() => void importGallery(page === 'references')}><Plus />导入图片</button>}</Empty>}
          </section>{showInspector && <AssetInspector asset={selected} studio={studio} onClose={() => setSelectedId(null)} onOpen={() => openImage(selected.id)} onBranch={() => branch(selected)} onCopyInputs={()=>copyInputs(selected)} onPreset={() => setDialog({ kind: 'preset', assetId: selected.id })} onSession={() => openSession(selected.sessionId)} onSelect={setSelectedId} />}</div>
        </>}
        {page === 'workspace' && currentSession && <Workspace key={currentSession.id} studio={studio} session={currentSession} onWorkspace={openWorkspace} onOpen={openImage} onBranch={branch} onCopyInputs={copyInputs} onPreset={asset => setDialog({ kind: 'preset', assetId: asset.id })} onSettings={() => setPage('settings')} onMove={id=>setDialog({kind:'move',sessionId:id})} onDelete={id=>setDialog({kind:'delete',sessionId:id})} />}
        {page === 'presets' && <><header className="page-header"><div><h1>效果预设<span className="heading-count">{doc.presets.length}</span></h1></div><span className="muted">从作品详情保存你的常用效果</span></header><div className="presets-scroll"><div className="preset-intro"><WandSparkles /><div><h2>从一个喜欢的效果开始</h2><p>载入 Prompt 与生成参数，换上你的参考图，即可再次创作。</p></div></div><div className="preset-grid">{doc.presets.map(preset => { const cover = doc.assets.find(a => a.id === preset.assetId); return <article className="preset-card" key={preset.id}><div className="preset-cover">{cover && <img src={studio.imageUrl(cover, true)} alt={preset.name} />}{cover?.demo && <span className="sample-badge">示例效果</span>}</div><div className="preset-body"><h3>{preset.name}</h3><p>{preset.description}</p><div className="preset-details"><span>{preset.size.replace('x', ' × ')}</span><span>{preset.referenceIds.length ? `${preset.referenceIds.length} 张参考图` : '替换参考图使用'}</span></div><button className="button secondary full" onClick={() => void createSession({ workspaceId: currentWorkspace.id, presetId: preset.id, title: preset.name })}><WandSparkles />使用这个效果<ArrowUpRight /></button></div></article>; })}</div></div></>}
        {page === 'jobs' && <Tasks studio={studio} tab={taskTab} onTab={setTaskTab} onSession={openSession}/>}
        {page === 'settings' && <Settings studio={studio} tab={settingsTab} setTab={setSettingsTab} />}
      </>}
    </main>
    {studio.apiError && <Modal title="API 请求未完成" className="api-error-modal" onClose={() => studio.setApiError(null)}><ErrorDetails error={studio.apiError} /></Modal>}
    <div className="toast-container" aria-live="polite">{studio.toasts.map(toast => <div className={`toast ${toast.error ? 'error' : ''}`} key={toast.id}>{toast.error ? <CircleAlert /> : <Check />}<span>{toast.message}</span>{toast.detail && <button className="button ghost small" onClick={() => studio.setApiError(toast.detail!)}>查看详情</button>}</div>)}</div>
    {lightbox && <Lightbox asset={lightbox} document={lightboxScope===null?doc:{...doc,assets:messageReferences(doc.assets,lightboxScope)}} imageUrl={studio.imageUrl} onClose={()=>{setLightboxId(null);setLightboxScope(null);}} onSelect={setLightboxId} onExport={() => void studio.exportImage(lightbox).catch(studio.report)} />}
    {dialog?.kind==='move'&&<SessionMoveDialog studio={studio} sessionId={dialog.sessionId} onClose={()=>setDialog(null)} onMoved={(id,ws)=>{setSessionId(id);setWorkspaceId(ws);setPage('workspace');setDialog(null);}}/>}
    {dialog?.kind==='delete'&&<SessionDeleteDialog studio={studio} sessionId={dialog.sessionId} onClose={()=>setDialog(null)} onDeleted={ws=>{setSessionId('');setWorkspaceId(ws);setSelectedId(null);setPage('workspace-gallery');setDialog(null);}}/>}
    {dialog?.kind==='delete-workspace'&&<WorkspaceDeleteDialog key={dialog.workspaceId} studio={studio} workspaceId={dialog.workspaceId} initialPreview={dialog.preview} onClose={()=>setDialog(null)} onDeleted={workspaceDeleted}/>}
    {studio.galleryDraft&&<GalleryImportDialog studio={studio} {...studio.galleryDraft} onClose={()=>studio.setGalleryDraft(null)} onSettings={()=>{studio.setGalleryDraft(null);setPage('settings');setSettingsTab('gallery');}} onQueued={()=>{studio.setGalleryDraft(null);setSelecting(false);setSelectedSessions([]);setPage('jobs');setTaskTab('gallery');}}/>}
    {batchDialog&&<BatchSessionDialog studio={studio} {...batchDialog} onClose={()=>setBatchDialog(null)} onCompleted={()=>{setBatchDialog(null);setSelecting(false);setSelectedSessions([]);}}/>}
    {dialog && dialog.kind!=='move' && dialog.kind!=='delete' && dialog.kind!=='delete-workspace' && <CreationDialog key={dialog.kind} dialog={dialog} studio={studio} currentWorkspaceId={workspaceId} onClose={() => setDialog(null)} onSession={(id, ws) => { setSessionId(id); setWorkspaceId(ws); setPage('workspace'); setDialog(null); }} onCreateSession={createSession} />}
  </div>;
}

function Titlebar({ studio, onSyncSettings }: { studio: Studio; onSyncSettings:()=>void }) {
  const report=studio.report;
  const [maximized, setMaximized] = useState(false);
  useEffect(() => { if (!desktop) return; let stop: (() => void) | undefined; let active = true; const window = getCurrentWindow(); const refresh = () => void window.isMaximized().then(value => active && setMaximized(value)); refresh(); void window.onResized(refresh).then(fn => active ? stop = fn : fn()); return () => { active = false; stop?.(); }; }, []);
  async function act(action: 'minimize' | 'maximize' | 'close') { if (!desktop) return; try { const window = getCurrentWindow(); if (action === 'minimize') await window.minimize(); if (action === 'close') await window.close(); if (action === 'maximize') { await window.toggleMaximize(); setMaximized(await window.isMaximized()); } } catch (error) { report(error); } }
  return <header className="titlebar"><div className="titlebar-drag" data-tauri-drag-region onDoubleClick={() => void act('maximize')}><span className="brand-mark" data-tauri-drag-region><img src="/app-icon.png" alt="" width={24} height={24} draggable={false} data-tauri-drag-region /></span><span className="brand-name" data-tauri-drag-region>GPT Image Studio</span></div><SyncStatus studio={studio} onSettings={onSyncSettings}/><div className="window-controls"><button aria-label="最小化窗口" onClick={() => void act('minimize')}><Minus /></button><button aria-label={maximized ? '还原窗口' : '最大化窗口'} onClick={() => void act('maximize')}>{maximized ? <Minimize2 /> : <Maximize2 />}</button><button className="window-close" aria-label="关闭窗口" onClick={() => void act('close')}><X /></button></div></header>;
}

function CreationDialog({ dialog, studio, currentWorkspaceId, onClose, onSession, onCreateSession }: { dialog: Exclude<DialogState, null | {kind:'move'|'delete';sessionId:string} | {kind:'delete-workspace';workspaceId:string;preview:WorkspaceDeletePreview}>; studio: Studio; currentWorkspaceId: string; onClose: () => void; onSession: (sessionId: string, workspaceId: string) => void; onCreateSession: (options: { workspaceId: string; title: string }) => Promise<void> }) {
  const [name, setName] = useState(dialog.kind === 'preset' ? studio.document.assets.find(a => a.id === dialog.assetId)?.title || '' : dialog.kind==='rename-workspace'?studio.document.workspaces.find(w=>w.id===dialog.workspaceId)?.name||'':'');
  const [workspace, setWorkspace] = useState((dialog.kind === 'create' ? dialog.workspaceId || currentWorkspaceId : currentWorkspaceId) || 'new');
  const [newWorkspace, setNewWorkspace] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit() {
    setSaving(true);
    try {
      if(dialog.kind==='rename-workspace'){await studio.mutate({type:'rename_workspace',id:dialog.workspaceId,name});studio.notify('工作区名称已更新');onClose();}
      else if (dialog.kind === 'preset') { await studio.mutate({ type: 'save_preset', assetId: dialog.assetId, name }); studio.notify('已保存为效果预设'); onClose(); }
      else if (dialog.kind === 'workspace' || workspace === 'new') {
        const document = await studio.mutate({ type: 'create_workspace', name: dialog.kind === 'workspace' ? name : newWorkspace }); const session = document.sessions.at(-1)!;
        if (dialog.kind === 'create' && name.trim()) await studio.mutate({ type: 'update_session', id: session.id, title: name.trim() });
        onSession(session.id, session.workspaceId);
      } else await onCreateSession({ workspaceId: workspace, title: name.trim() || '新会话' });
    } catch (error) { studio.report(error); } finally { setSaving(false); }
  }
  return <Modal title={dialog.kind==='rename-workspace'?'重命名工作区':dialog.kind === 'preset' ? '保存为效果预设' : dialog.kind === 'workspace' ? '新建工作区' : '新建创作'} onClose={()=>{if(!saving)onClose();}}><form onSubmit={e => { e.preventDefault(); void submit(); }}><div className="modal-content"><p className="modal-description">{dialog.kind==='rename-workspace'?'更新工作区的显示名称。':dialog.kind === 'preset' ? '保存当前结果的 Prompt 和参数，下次换上参考图即可复用。' : dialog.kind === 'workspace' ? '围绕一个创作目标，组织多次实验和不同会话。' : '在工作区中开始一个独立会话，也可以从已有结果派生。'}</p>{dialog.kind === 'create' && <label className="field"><span className="field-label">工作区</span><OptionSelect value={workspace} onValueChange={value=> setWorkspace(value)}>{studio.document.workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}<option value="new">＋ 新建工作区</option></OptionSelect></label>}{dialog.kind === 'create' && workspace === 'new' && <label className="field"><span className="field-label">新工作区名称</span><input required value={newWorkspace} onChange={e => setNewWorkspace(e.target.value)} placeholder="例如：角色材质研究" /></label>}<label className="field"><span className="field-label">{dialog.kind === 'preset' ? '效果名称' : (dialog.kind === 'workspace'||dialog.kind==='rename-workspace') ? '工作区名称' : '会话名称'}</span><input autoFocus required={dialog.kind !== 'create'} maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder={(dialog.kind === 'workspace'||dialog.kind==='rename-workspace') ? '例如：魔幻卷轴商店' : dialog.kind === 'preset' ? '例如：柔软毛绒质感' : '例如：材质与光照'} /></label></div><footer className="modal-footer"><button type="button" className="button secondary" disabled={saving} onClick={onClose}>取消</button><button className="button primary" type="submit" disabled={saving||(dialog.kind==='rename-workspace'&&!name.trim())}>{saving && <LoaderCircle className="spin" />}{dialog.kind==='rename-workspace'?'保存名称':dialog.kind === 'preset' ? '保存效果' : '开始创作'}</button></footer></form></Modal>;
}
