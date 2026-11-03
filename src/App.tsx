import { useEffect, useMemo, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Aperture, ArrowDownToLine, ArrowUpRight, Check, ChevronDown, ChevronRight, CircleAlert, CircleCheck, Clock3, Columns3, Folder, FolderInput, FolderOpen, GitBranch, Heart, ImagePlus, Images, Layers, ListChecks, LoaderCircle, Maximize2, MessageSquare, Minimize2, Minus, Moon, Plus, Search, Settings2, SlidersHorizontal, Sparkles, Sun, WandSparkles, X } from 'lucide-react';
import { AssetCard, AssetInspector, Empty, Modal, timeLabel } from './components';
import { Lightbox } from './Lightbox';
import { desktop, useStudio, type Studio } from './useStudio';
import Workspace from './Workspace';
import Settings from './Settings';
import SessionMoveDialog from './SessionMoveDialog';
import type { Asset, Page } from './types';

type DialogState = { kind: 'create' | 'workspace'; workspaceId?: string } | { kind: 'preset'; assetId: string } | {kind:'move';sessionId:string} | null;
function readNavigation() { try { return JSON.parse(localStorage.getItem('image-studio.navigation') || '{}') as { page?: Page; sessionId?: string; workspaceId?: string }; } catch { return {}; } }

export default function App() {
  const studio = useStudio();
  const initial = useState(readNavigation)[0];
  const [page, setPage] = useState<Page>(initial.page && ['gallery', 'workspace', 'references', 'presets', 'jobs', 'settings'].includes(initial.page) ? initial.page : 'gallery');
  const [sessionId, setSessionId] = useState(initial.sessionId || 'demo-material');
  const [workspaceId, setWorkspaceId] = useState(initial.workspaceId || 'demo-plush');
  const [selectedId, setSelectedId] = useState<string | null>('demo-fox-v3');
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [galleryWorkspace, setGalleryWorkspace] = useState('all');
  const [stack, setStack] = useState(false);
  const [showSamples, setShowSamples] = useState(true);
  const [referenceTab, setReferenceTab] = useState('global');
  const [expanded, setExpanded] = useState<string[]>(['demo-plush']);
  const doc = studio.document;
  const currentSession = doc.sessions.find(s => s.id === sessionId) || doc.sessions[0];
  const currentWorkspace = doc.workspaces.find(w => w.id === workspaceId) || doc.workspaces[0];
  const selected = doc.assets.find(a => a.id === selectedId);
  const lightbox = doc.assets.find(a => a.id === lightboxId);
  const running = doc.jobs.filter(j => j.status === 'running').length;
  const historyReferenceIds = new Set([...doc.sessions.flatMap(s => s.referenceIds), ...doc.assets.flatMap(a => a.referenceIds)]);

  useEffect(() => {
    document.documentElement.dataset.theme = doc.settings.theme;
    document.documentElement.style.setProperty('--accent-base', doc.settings.accent);
  }, [doc.settings.theme, doc.settings.accent]);
  useEffect(() => { localStorage.setItem('image-studio.navigation', JSON.stringify({ page, sessionId, workspaceId })); }, [page, sessionId, workspaceId]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'n') { event.preventDefault(); setDialog({ kind: 'create', workspaceId }); }
      if (event.ctrlKey && event.key.toLowerCase() === 'f' && page === 'gallery') { event.preventDefault(); document.getElementById('gallery-search')?.focus(); }
    };
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut);
  }, [page, workspaceId]);

  function openSession(id: string) {
    const session = doc.sessions.find(s => s.id === id);
    if (!session) return;
    setSessionId(id); setWorkspaceId(session.workspaceId); setPage('workspace');
    setExpanded(previous => previous.includes(session.workspaceId) ? previous : [...previous, session.workspaceId]);
  }
  async function createSession(options: { workspaceId: string; title?: string; parentAssetId?: string; presetId?: string }) {
    try {
      const next = await studio.mutate({ type: 'create_session', ...options });
      const session = next.sessions.at(-1)!;
      setSessionId(session.id); setWorkspaceId(session.workspaceId); setExpanded(previous => [...new Set([...previous, session.workspaceId])]); setPage('workspace'); setDialog(null);
    } catch (error) { studio.report(error); }
  }
  function branch(asset: Asset) { void createSession({ workspaceId: asset.workspaceId || currentWorkspace.id, parentAssetId: asset.id, title: `${asset.title.slice(0, 14)} · 派生` }); }
  async function importGallery(asReference: boolean) {
    try { const ids = await studio.importImages(asReference); if (ids.length) setSelectedId(ids[0]); } catch (error) { studio.report(error); }
  }
  const assets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    let result = doc.assets.filter(asset => {
      if (page === 'references') {
        if (asset.demo) return false;
        if (referenceTab === 'global' && !asset.isReference) return false;
        if (referenceTab === 'history' && !historyReferenceIds.has(asset.id)) return false;
      }
      if (!showSamples && asset.demo) return false;
      if (filter === 'favorites' && !asset.favorite) return false;
      if (filter === 'generated' && (asset.demo || asset.model === '本地导入' || asset.referenceOnly)) return false;
      if (filter === 'imported' && asset.model !== '本地导入') return false;
      if (galleryWorkspace !== 'all' && asset.workspaceId !== galleryWorkspace) return false;
      const workspace = doc.workspaces.find(w => w.id === asset.workspaceId);
      return !normalized || `${asset.title} ${asset.originalPrompt} ${asset.submittedPrompt} ${workspace?.name || ''}`.toLowerCase().includes(normalized);
    }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    if (stack && page === 'gallery') { const seen = new Set<string>(); result = result.filter(a => { if (seen.has(a.groupId)) return false; seen.add(a.groupId); return true; }); }
    return result;
  }, [doc.assets, doc.workspaces, doc.sessions, query, page, showSamples, filter, galleryWorkspace, stack, referenceTab]);
  const showInspector = selected && (page === 'gallery' || page === 'references') && assets.some(a => a.id === selected.id);

  return <div className="app-shell">
    <Titlebar report={studio.report} />
    <aside className="sidebar"><div className="sidebar-top"><div className="sidebar-caption">创作空间</div><nav aria-label="主要导航">{([
      ['gallery', Images, '图库'], ['workspace', Sparkles, '创作工作区'], ['references', ImagePlus, '参考图'], ['presets', WandSparkles, '效果预设'], ['jobs', ListChecks, '生成任务'],
    ] as const).map(([key, Icon, label]) => <button key={key} className={`nav-item ${page === key ? 'active' : ''}`} aria-current={page === key ? 'page' : undefined} onClick={() => { setPage(key); setQuery(''); setFilter('all'); setGalleryWorkspace('all'); }}><Icon /><span>{label}</span>{key === 'jobs' && running > 0 && <span className="nav-count">{running}</span>}</button>)}</nav>
      <div className="workspace-caption"><span>工作区</span><button className="icon-button" aria-label="新建工作区" onClick={() => setDialog({ kind: 'workspace' })}><Plus /></button></div>
      <div className="workspace-tree">{doc.workspaces.map(workspace => <div key={workspace.id} className="workspace-node"><div className={`workspace-row ${workspaceId === workspace.id && page === 'workspace' ? 'current' : ''}`}><button className="tree-chevron" aria-label={`${expanded.includes(workspace.id) ? '收起' : '展开'} ${workspace.name}`} onClick={() => setExpanded(ids => ids.includes(workspace.id) ? ids.filter(id => id !== workspace.id) : [...ids, workspace.id])}>{expanded.includes(workspace.id) ? <ChevronDown /> : <ChevronRight />}</button><button className="workspace-link" onClick={() => { const session = doc.sessions.find(s => s.workspaceId === workspace.id); if (session) openSession(session.id); }}>
        {expanded.includes(workspace.id) ? <FolderOpen /> : <Folder />}<span>{workspace.name}</span></button><button className="tree-add icon-button" aria-label={`在 ${workspace.name} 新建会话`} onClick={() => setDialog({ kind: 'create', workspaceId: workspace.id })}><Plus /></button></div>
        {expanded.includes(workspace.id) && <div className="session-list">{doc.sessions.filter(s => s.workspaceId === workspace.id).map(session => <div key={session.id} className={`session-row ${sessionId===session.id&&page==='workspace'?'selected':''}`}><button className="session-item" aria-current={sessionId === session.id && page === 'workspace' ? 'page' : undefined} onClick={() => openSession(session.id)}>{session.parentAssetId ? <GitBranch /> : <MessageSquare />}<span>{session.title}</span></button><button className="icon-button session-move" aria-label={`移动会话 ${session.title}`} title="移动到其他工作区" disabled={doc.workspaces.length<2} onClick={()=>setDialog({kind:'move',sessionId:session.id})}><FolderInput/></button></div>)}</div>}
      </div>)}</div>
    </div><div className="sidebar-bottom"><button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => setPage('settings')}><Settings2 /><span>设置</span><span className="version-label">v0.1</span></button><div className="local-state"><span className="status-dot" />本地图库{studio.ready ? '已就绪' : '读取中'}</div></div></aside>
    <main className="main-panel">
      {!studio.ready && <div className="loading-screen">{studio.loadError ? <><CircleAlert /><h2>无法读取本地图库</h2><p>{studio.loadError}</p><button className="button secondary" onClick={() => void studio.refresh().catch(studio.report)}>重试</button></> : <><LoaderCircle className="spin" /><p>正在打开你的创作空间…</p></>}</div>}
      {studio.ready && <>
        {(page === 'gallery' || page === 'references') && <><header className="page-header"><div><div className="page-eyebrow">{page === 'gallery' ? '你的灵感，逐步成形' : '素材跟着创作走'}</div><h1>{page === 'gallery' ? '所有图片' : '参考图库'}<span className="heading-count">{assets.length}</span></h1></div><div className="header-actions"><button className="button secondary" onClick={() => void importGallery(page === 'references')}><ArrowDownToLine />{page === 'references' ? '导入参考图' : '导入图片'}</button>{page === 'gallery' && <button className="button primary" onClick={() => setDialog({ kind: 'create', workspaceId })}><Plus />新建创作</button>}</div></header>
          <div className={`gallery-layout ${showInspector ? 'has-inspector' : ''}`}><section className="gallery-panel" aria-label={page === 'references' ? '参考图列表' : '图片列表'}>
            <div className="gallery-toolbar"><label className="search-input"><Search /><input id="gallery-search" aria-label="搜索图片" placeholder="搜索图片、Prompt、工作区…" value={query} onChange={e => setQuery(e.target.value)} /><kbd>Ctrl F</kbd></label>{page === 'gallery' && <div className="segment" role="group" aria-label="版本显示方式"><button aria-pressed={!stack} aria-label="平铺显示" onClick={() => setStack(false)}><Columns3 /></button><button aria-pressed={stack} aria-label="堆叠版本" onClick={() => setStack(true)}><Layers /></button></div>}</div>
            <div className="gallery-filters"><div className="filter-tabs">{page === 'references' ? <><button className={referenceTab === 'global' ? 'selected' : ''} onClick={() => setReferenceTab('global')}>全局参考图</button><button className={referenceTab === 'history' ? 'selected' : ''} onClick={() => setReferenceTab('history')}>会话历史引用</button></> : <>{[['all', '全部'], ['favorites', '收藏'], ['generated', '已生成'], ['imported', '本地导入']].map(([value, label]) => <button className={filter === value ? 'selected' : ''} key={value} onClick={() => setFilter(value)}>{value === 'favorites' && <Heart size={12} />}{label}</button>)}</>}</div><select className="workspace-filter" aria-label="筛选工作区" value={galleryWorkspace} onChange={e => setGalleryWorkspace(e.target.value)}><option value="all">全部工作区</option>{doc.workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></div>
            {page === 'gallery' && <div className="gallery-section-label"><span>最近作品 <span className="muted">· {stack ? '按版本组展示' : '按生成时间排列'}</span></span><label className="sample-toggle"><input type="checkbox" checked={showSamples} onChange={e => setShowSamples(e.target.checked)} />显示示例</label></div>}
            <div className="asset-grid">{assets.map(asset => <AssetCard key={asset.id} asset={asset} studio={studio} active={asset.id === selectedId} versions={stack ? doc.assets.filter(a => a.groupId === asset.groupId).length : 1} onSelect={() => setSelectedId(asset.id)} onOpen={() => setLightboxId(asset.id)} />)}</div>
            {!assets.length && <Empty title={query || filter !== 'all' ? '没有匹配的图片' : page === 'references' ? '为下一次创作准备素材' : '你的第一张作品，从这里开始'} description={query || filter !== 'all' ? '换一个关键词或筛选条件试试。' : page === 'references' ? '导入图片，或在作品详情中将图片加入全局参考图库。' : '新建创作，或导入已有的图片。'}><button className="button secondary" onClick={() => void importGallery(page === 'references')}><Plus />导入图片</button></Empty>}
          </section>{showInspector && <AssetInspector asset={selected} studio={studio} onClose={() => setSelectedId(null)} onOpen={() => setLightboxId(selected.id)} onBranch={() => branch(selected)} onPreset={() => setDialog({ kind: 'preset', assetId: selected.id })} onSession={() => openSession(selected.sessionId)} onSelect={setSelectedId} />}</div>
        </>}
        {page === 'workspace' && currentSession && <Workspace key={currentSession.id} studio={studio} session={currentSession} onOpen={setLightboxId} onBranch={branch} onPreset={asset => setDialog({ kind: 'preset', assetId: asset.id })} onSettings={() => setPage('settings')} onMove={id=>setDialog({kind:'move',sessionId:id})} />}
        {page === 'presets' && <><header className="page-header"><div><div className="page-eyebrow">少一点重复，多一点创作</div><h1>效果预设<span className="heading-count">{doc.presets.length}</span></h1></div><span className="muted">从作品详情保存你的常用效果</span></header><div className="presets-scroll"><div className="preset-intro"><WandSparkles /><div><h2>从一个喜欢的效果开始</h2><p>载入 Prompt 与生成参数，换上你的参考图，即可再次创作。</p></div></div><div className="preset-grid">{doc.presets.map(preset => { const cover = doc.assets.find(a => a.id === preset.assetId); return <article className="preset-card" key={preset.id}><div className="preset-cover">{cover && <img src={studio.imageUrl(cover, true)} alt={preset.name} />}{cover?.demo && <span className="sample-badge">示例效果</span>}</div><div className="preset-body"><h3>{preset.name}</h3><p>{preset.description}</p><div className="preset-details"><span>{preset.size.replace('x', ' × ')}</span><span>{preset.referenceIds.length ? `${preset.referenceIds.length} 张参考图` : '替换参考图使用'}</span></div><button className="button secondary full" onClick={() => void createSession({ workspaceId: currentWorkspace.id, presetId: preset.id, title: preset.name })}><WandSparkles />使用这个效果<ArrowUpRight /></button></div></article>; })}</div></div></>}
        {page === 'jobs' && <><header className="page-header"><div><div className="page-eyebrow">每一次生成都有迹可循</div><h1>生成任务</h1></div><span className="subtle-badge">{running ? `${running} 个任务进行中` : '没有进行中的任务'}</span></header><div className="jobs-scroll">{!doc.jobs.length ? <Empty title="任务会在这里留下记录" description="开始生成后，可以离开会话页面，在这里查看任务状态与结果。" icon={<ListChecks />}><button className="button primary" onClick={() => setDialog({ kind: 'create', workspaceId })}><Plus />新建创作</button></Empty> : <div className="job-list">{doc.jobs.map(job => <article className={`job-row ${job.status}`} key={job.id}><div className="job-status-icon">{job.status === 'running' ? <LoaderCircle className="spin" /> : job.status === 'completed' ? <CircleCheck /> : <CircleAlert />}</div><div className="job-content"><div className="job-heading"><strong>{job.prompt.slice(0, 60)}</strong><span className="subtle-badge">{{ running: '正在生成', completed: '已完成', failed: '未完成', interrupted: '已中断' }[job.status]}</span></div><div className="job-subline">{timeLabel(job.createdAt)}<span>·</span>{doc.sessions.find(s => s.id === job.sessionId)?.title || '创作会话'}{job.assetIds.length > 0 && <><span>·</span>{job.assetIds.length} 张图片已保存</>}</div>{job.error && <p className="job-error">{job.error}</p>}{job.status === 'running' && <div className="indeterminate-track"><span /></div>}</div><button className="button secondary small" onClick={() => openSession(job.sessionId)}>查看会话<ArrowUpRight /></button></article>)}</div>}</div></>}
        {page === 'settings' && <Settings studio={studio} />}
      </>}
    </main>
    <footer className="statusbar"><span className={`status-dot ${studio.loadError ? 'error' : ''}`} /><span>{studio.loadError ? '图库载入失败' : desktop ? '本地保存' : '浏览器预览'}</span><span className="statusbar-separator" />{doc.assets.filter(a => !a.demo).length} 张本地图片<span className="statusbar-right">{running ? <button onClick={() => setPage('jobs')}><LoaderCircle className="spin" />{running} 个生成任务</button> : <><Check size={12} />{desktop ? '创作记录自动保存' : 'Windows 桌面版可使用全部功能'}</>}</span></footer>
    <div className="toast-container" aria-live="polite">{studio.toasts.map(toast => <div className={`toast ${toast.error ? 'error' : ''}`} key={toast.id}>{toast.error ? <CircleAlert /> : <Check />}<span>{toast.message}</span></div>)}</div>
    {lightbox && <Lightbox asset={lightbox} document={doc} imageUrl={studio.imageUrl} onClose={() => setLightboxId(null)} onSelect={setLightboxId} onExport={() => void studio.exportImage(lightbox).catch(studio.report)} />}
    {dialog?.kind==='move'&&<SessionMoveDialog studio={studio} sessionId={dialog.sessionId} onClose={()=>setDialog(null)} onMoved={(id,ws)=>{setSessionId(id);setWorkspaceId(ws);setExpanded(previous=>[...new Set([...previous,ws])]);setPage('workspace');setDialog(null);}}/>}
    {dialog && dialog.kind!=='move' && <CreationDialog key={dialog.kind} dialog={dialog} studio={studio} currentWorkspaceId={workspaceId} onClose={() => setDialog(null)} onSession={(id, ws) => { setSessionId(id); setWorkspaceId(ws); setExpanded(previous => [...new Set([...previous, ws])]); setPage('workspace'); setDialog(null); }} onCreateSession={createSession} />}
  </div>;
}

function Titlebar({ report }: { report: Studio['report'] }) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => { if (!desktop) return; let stop: (() => void) | undefined; let active = true; const window = getCurrentWindow(); const refresh = () => void window.isMaximized().then(value => active && setMaximized(value)); refresh(); void window.onResized(refresh).then(fn => active ? stop = fn : fn()); return () => { active = false; stop?.(); }; }, []);
  async function act(action: 'minimize' | 'maximize' | 'close') { if (!desktop) return; try { const window = getCurrentWindow(); if (action === 'minimize') await window.minimize(); if (action === 'close') await window.close(); if (action === 'maximize') { await window.toggleMaximize(); setMaximized(await window.isMaximized()); } } catch (error) { report(error); } }
  return <header className="titlebar"><div className="titlebar-drag" data-tauri-drag-region onDoubleClick={() => void act('maximize')}><span className="brand-mark" data-tauri-drag-region><Aperture /></span><span className="brand-name" data-tauri-drag-region>Image Studio</span><span className="brand-caption" data-tauri-drag-region>创作 · 迭代 · 收藏</span></div><div className="window-controls"><button aria-label="最小化窗口" onClick={() => void act('minimize')}><Minus /></button><button aria-label={maximized ? '还原窗口' : '最大化窗口'} onClick={() => void act('maximize')}>{maximized ? <Minimize2 /> : <Maximize2 />}</button><button className="window-close" aria-label="关闭窗口" onClick={() => void act('close')}><X /></button></div></header>;
}

function CreationDialog({ dialog, studio, currentWorkspaceId, onClose, onSession, onCreateSession }: { dialog: Exclude<DialogState, null | {kind:'move';sessionId:string}>; studio: Studio; currentWorkspaceId: string; onClose: () => void; onSession: (sessionId: string, workspaceId: string) => void; onCreateSession: (options: { workspaceId: string; title: string }) => Promise<void> }) {
  const [name, setName] = useState(dialog.kind === 'preset' ? studio.document.assets.find(a => a.id === dialog.assetId)?.title || '' : '');
  const [workspace, setWorkspace] = useState(dialog.kind === 'create' ? dialog.workspaceId || currentWorkspaceId : currentWorkspaceId);
  const [newWorkspace, setNewWorkspace] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit() {
    setSaving(true);
    try {
      if (dialog.kind === 'preset') { await studio.mutate({ type: 'save_preset', assetId: dialog.assetId, name }); studio.notify('已保存为效果预设'); onClose(); }
      else if (dialog.kind === 'workspace' || workspace === 'new') {
        const document = await studio.mutate({ type: 'create_workspace', name: dialog.kind === 'workspace' ? name : newWorkspace }); const session = document.sessions.at(-1)!;
        if (dialog.kind === 'create' && name.trim()) await studio.mutate({ type: 'update_session', id: session.id, title: name.trim() });
        onSession(session.id, session.workspaceId);
      } else await onCreateSession({ workspaceId: workspace, title: name.trim() || '新会话' });
    } catch (error) { studio.report(error); } finally { setSaving(false); }
  }
  return <Modal title={dialog.kind === 'preset' ? '保存为效果预设' : dialog.kind === 'workspace' ? '新建工作区' : '新建创作'} onClose={onClose}><form onSubmit={e => { e.preventDefault(); void submit(); }}><div className="modal-content"><p className="modal-description">{dialog.kind === 'preset' ? '保存当前结果的 Prompt 和参数，下次换上参考图即可复用。' : dialog.kind === 'workspace' ? '围绕一个创作目标，组织多次实验和不同会话。' : '在工作区中开始一个独立会话，也可以从已有结果派生。'}</p>{dialog.kind === 'create' && <label className="field"><span className="field-label">工作区</span><select value={workspace} onChange={e => setWorkspace(e.target.value)}>{studio.document.workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}<option value="new">＋ 新建工作区</option></select></label>}{dialog.kind === 'create' && workspace === 'new' && <label className="field"><span className="field-label">新工作区名称</span><input required value={newWorkspace} onChange={e => setNewWorkspace(e.target.value)} placeholder="例如：角色材质研究" /></label>}<label className="field"><span className="field-label">{dialog.kind === 'preset' ? '效果名称' : dialog.kind === 'workspace' ? '工作区名称' : '会话名称'}</span><input autoFocus required={dialog.kind !== 'create'} maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder={dialog.kind === 'workspace' ? '例如：魔幻卷轴商店' : dialog.kind === 'preset' ? '例如：柔软毛绒质感' : '例如：材质与光照'} /></label></div><footer className="modal-footer"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" type="submit" disabled={saving}>{saving && <LoaderCircle className="spin" />}{dialog.kind === 'preset' ? '保存效果' : '开始创作'}</button></footer></form></Modal>;
}
