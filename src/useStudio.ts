import { useCallback, useEffect, useRef, useState } from 'react';
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import seed from './data/seed.json';
import { SettingsWrites } from './settingsWrites';
import { waitForGeneratedImages } from './GenerationElapsed';
import { SYNC_INTERVAL_MS, type SyncView } from './syncState';
import { apiErrorInfo, errorSummary } from './apiErrors';
import { browserLibrary, browserCommand } from './sketch/library';
import type { Asset, Bootstrap, GalleryTask, GenerationRequest, Job, NetworkConfig, NetworkState, RefineResult, SessionDeletePreview, WorkspaceDeletePreview, Settings, StudioAction, StudioDocument, UsageSummary } from './types';

export const desktop = isTauri();
export interface Toast { id: number; message: string; error: boolean; detail?: string }
export function useStudio() {
  const [boot, setBoot] = useState<Bootstrap>({ document: seed as StudioDocument, dataDir: '', hasImageKey: false, hasRefineKey: false });
  const [ready, setReady] = useState(!desktop);
  const [loadError, setLoadError] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [apiError, setApiError] = useState<string | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [sync, setSync] = useState<SyncView>();
  const [syncBusy, setSyncBusy] = useState(false);
  const [galleryTasks,setGalleryTasks]=useState<GalleryTask[]>([]);
  const [galleryDraft,setGalleryDraft]=useState<{assetIds:string[];selectedIds:string[]}|null>(null);
  const [activeGenerations, setActiveGenerations] = useState<Record<string, { startedAt: number; previousJobs: Set<string> }>>({});
  const syncBusyRef = useRef(false);
  const bootRef = useRef(boot); bootRef.current = boot;
  const committedSettings = useRef(boot.document.settings);
  const settingsWrites = useRef<SettingsWrites<Settings, Bootstrap> | null>(null);
  const serial = useRef(0);
  const sketchEditors = useRef(new Map<string,()=>Promise<void>>());
  const registerSketchEditor=useCallback((id:string,flush:()=>Promise<void>)=>{sketchEditors.current.set(id,flush);return()=>{sketchEditors.current.delete(id);};},[]);
  const flushSketchEditors=useCallback(async()=>{for(const flush of sketchEditors.current.values())await flush();},[]);
  const sessionEditors = useRef(new Map<string,(action:StudioAction)=>Promise<StudioDocument>>());
  const notify = useCallback((message: string, error = false) => {
    const id = ++serial.current;
    const detail = error && apiErrorInfo(message) ? message : undefined;
    if (detail) setApiError(detail);
    setToasts(items => [...items.slice(-2), { id, message: errorSummary(message), error, detail }]);
    window.setTimeout(() => setToasts(items => items.filter(item => item.id !== id)), error ? 8000 : 4500);
  }, []);
  if (!settingsWrites.current) settingsWrites.current = new SettingsWrites({
    save: async (settings, providerKeys) => desktop
      ? invoke<Bootstrap>('save_settings', { settings, imageKey: null, refineKey: null, providerKeys })
      : { ...bootRef.current, document: { ...bootRef.current.document, settings } },
    changed: settings => {
      setSettingsError('');
      setBoot(previous => ({ ...previous, document: { ...previous.document, settings } }));
    },
    saved: (value, optimistic) => {
      committedSettings.current = value.document.settings;
      setBoot(previous => ({ ...value, document: {
        ...(value.document.revision >= previous.document.revision ? value.document : previous.document),
        settings: optimistic ?? value.document.settings,
      } }));
    },
    failed: (error, optimistic) => {
      if (optimistic) return;
      setBoot(previous => ({ ...previous, document: { ...previous.document, settings: committedSettings.current } }));
      const message = String(error);
      setSettingsError(message);
      notify(`设置保存失败，已恢复上次有效设置：${message}`, true);
    },
    busy: setSettingsSaving,
  });
  const accept = useCallback((document: StudioDocument) => {
    if (document.revision >= bootRef.current.document.revision) committedSettings.current = document.settings;
    setBoot(previous => document.revision >= previous.document.revision ? { ...previous, document: { ...document, settings: settingsWrites.current!.optimistic ?? document.settings } } : previous);
  }, []);
  const refresh = useCallback(async () => {
    if (!desktop) return;
    const value = await invoke<Bootstrap>('bootstrap');
    committedSettings.current = value.document.settings;
    setBoot(previous => ({ ...value, document: { ...(value.document.revision >= previous.document.revision ? value.document : previous.document), settings: settingsWrites.current!.optimistic ?? value.document.settings } }));
    setReady(true); setLoadError('');
  }, []);
  useEffect(() => {
    if (!desktop) return;
    let dispose: (() => void) | undefined; let active = true;
    void listen<StudioDocument>('studio:changed', event => { if (active) accept(event.payload); }).then(fn => active ? dispose = fn : fn());
    void refresh().catch(error => setLoadError(String(error)));
    return () => { active = false; dispose?.(); };
  }, [accept, refresh]);
  useEffect(()=>{if(!desktop)void browserLibrary(bootRef.current.document).then(accept).catch(error=>notify(String(error),true));},[accept,notify]);
  const refreshSync = useCallback(async () => {
    if (!desktop) return;
    const value = await invoke<SyncView>('sync_status');
    setSync(value); return value;
  }, []);
  const syncNow = useCallback(async () => {
    if (!desktop || syncBusyRef.current) return;
    syncBusyRef.current=true; setSyncBusy(true);
    try {
      for(const flush of sketchEditors.current.values())await flush();
      for(const editor of sessionEditors.current.values())await editor({type:'flush_session'});
      await settingsWrites.current!.idle();
      const value=await invoke<SyncView>('sync_now');
      setSync(value); await refresh(); return value;
    } catch(error) {
      await refreshSync().catch(()=>{}); throw error;
    } finally {syncBusyRef.current=false;setSyncBusy(false);}
  }, [refresh, refreshSync]);
  useEffect(() => {
    if (!desktop) return;
    let active=true, dispose:(()=>void)|undefined;
    void listen<SyncView>('studio:sync',e=>{if(active)setSync(e.payload);}).then(fn=>active?dispose=fn:fn());
    const isEditing=()=>!!document.activeElement?.matches('input,textarea,[contenteditable="true"]');
    const editingChanged=()=>queueMicrotask(()=>{if(active)void invoke('set_sync_editing',{editing:isEditing()}).catch(()=>{});});
    document.addEventListener('focusin',editingChanged);document.addEventListener('focusout',editingChanged);
    editingChanged();
    const tick=async()=>{
      if(!active||syncBusyRef.current||isEditing())return;
      try {
        const state=await refreshSync();
        if(!active||!state?.config.enabled||state.status.pausedForGallery||isEditing())return;
        await syncNow();
      }catch{/* The titlebar and sync page show errors; background attempts stay quiet. */}
    };
    const timer=window.setInterval(()=>void tick(),SYNC_INTERVAL_MS);
    return()=>{active=false;dispose?.();window.clearInterval(timer);document.removeEventListener('focusin',editingChanged);document.removeEventListener('focusout',editingChanged);};
  },[refreshSync,syncNow]);
  useEffect(()=>{
    if(!desktop||!ready)return;
    const timer=window.setTimeout(()=>void refreshSync().catch(()=>{}),500);
    return()=>window.clearTimeout(timer);
  },[ready,boot.document.revision,refreshSync]);
  const requireDesktop = useCallback(() => {
    if (!desktop) throw new Error('浏览器中仅提供界面预览，请在 Windows 桌面版使用此功能。');
  }, []);
  useEffect(()=>{
    if(!desktop)return;
    let active=true,dispose:(()=>void)|undefined;
    void listen<GalleryTask[]>('studio:gallery-tasks',e=>{if(active)setGalleryTasks(e.payload);}).then(fn=>{
      if(!active){fn();return;}dispose=fn;
      void invoke<GalleryTask[]>('gallery_tasks').then(v=>{if(active)setGalleryTasks(v);}).catch(error=>notify(String(error),true));
    });
    return()=>{active=false;dispose?.();};
  },[notify]);
  const requestGalleryImport=useCallback((assetIds:string[],selectedIds=assetIds)=>setGalleryDraft({assetIds,selectedIds}),[]);
  const enqueueGalleryImport=useCallback(async(assetIds:string[])=>{
    requireDesktop();await settingsWrites.current!.idle();
    const tasks=await invoke<GalleryTask[]>('enqueue_gallery_import',{assetIds});setGalleryTasks(tasks);
    notify(`已将 ${assetIds.length} 张图片加入图库导入队列`);
  },[requireDesktop,notify]);
  const controlGalleryImport=useCallback(async(taskId:string,action:'retry'|'cancel')=>{
    requireDesktop();setGalleryTasks(await invoke<GalleryTask[]>('control_gallery_import',{taskId,action}));
  },[requireDesktop]);
  const openGalleryPost=useCallback(async(url:string)=>{requireDesktop();await invoke('open_gallery_post',{url});},[requireDesktop]);
  const mutate = useCallback(async (action: StudioAction) => {
    if(!desktop&&action.type==='sketch_action'){const document=await browserCommand('sketch_action',action,bootRef.current.document) as StudioDocument;accept(document);return document;}
    requireDesktop();
    const document = action.type === 'delete_session'
      ? await invoke<StudioDocument>('delete_session', { sessionId: action.id, referenceIds: action.referenceIds, token: action.token })
      : action.type === 'delete_workspace'
      ? await invoke<StudioDocument>('delete_workspace', { workspaceId: action.id, token: action.token })
      : action.type === 'delete_sessions'
      ? await invoke<StudioDocument>('delete_sessions', { workspaceId: action.workspaceId, sessionIds: action.sessionIds, token: action.token })
      : await invoke<StudioDocument>('dispatch', { action });
    accept(document); return document;
  }, [accept, requireDesktop]);
  const registerSessionEditor = useCallback((id:string,execute:(action:StudioAction)=>Promise<StudioDocument>)=>{
    sessionEditors.current.set(id,execute);
    return ()=>{if(sessionEditors.current.get(id)===execute)sessionEditors.current.delete(id);};
  },[]);
  const moveSession = useCallback(async (id:string,workspaceId:string)=>{
    const action={type:'move_session',id,workspaceId};
    const editor=sessionEditors.current.values().next().value;
    const document=await(editor?editor(action):mutate(action));
    notify(`会话已移至「${document.workspaces.find(w=>w.id===workspaceId)?.name||'目标工作区'}」`);
    return document;
  },[mutate,notify]);
  const previewDeleteSession = useCallback(async (id:string) => {
    requireDesktop();
    const editor = sessionEditors.current.get(id);
    if (editor) await editor({type:'flush_session'});
    return invoke<SessionDeletePreview>('preview_session_delete', {sessionId:id});
  },[requireDesktop]);
  const deleteSession = useCallback(async (id:string,referenceIds:string[],token:string) => {
    await settingsWrites.current!.idle();
    const action = {type:'delete_session',id,referenceIds,token};
    const editor = sessionEditors.current.get(id);
    const document = await (editor ? editor(action) : mutate(action));
    notify('会话已删除，移除内容已送入系统回收站');
    return document;
  },[mutate,notify]);
  const saveSettings = useCallback((settings: Settings, providerKeys: Record<string,string> = {}) => settingsWrites.current!.enqueue(settings, providerKeys), []);
  const previewDeleteWorkspace = useCallback(async (id:string) => {
    requireDesktop();
    const editor = sessionEditors.current.values().next().value;
    if (editor) await editor({type:'flush_session'});
    return invoke<WorkspaceDeletePreview>('preview_workspace_delete', {workspaceId:id});
  }, [requireDesktop]);
  const deleteWorkspace = useCallback(async (id:string, token:string) => {
    await settingsWrites.current!.idle();
    const action = {type:'delete_workspace',id,token};
    const editor = sessionEditors.current.values().next().value;
    const document = await (editor ? editor(action) : mutate(action));
    notify('工作区已删除，参考图已保留；移除内容已送入系统回收站');
    return document;
  }, [mutate,notify]);
  const previewDeleteSessions = useCallback(async (workspaceId:string, sessionIds:string[]) => {
    requireDesktop();
    return invoke<WorkspaceDeletePreview>('preview_sessions_delete', {workspaceId,sessionIds});
  }, [requireDesktop]);
  const deleteSessions = useCallback(async (workspaceId:string, sessionIds:string[], token:string) => {
    await settingsWrites.current!.idle();
    const document = await mutate({type:'delete_sessions',workspaceId,sessionIds,token});
    notify(`已删除 ${sessionIds.length} 个会话，参考图已保留；移除内容已送入系统回收站`);
    return document;
  }, [mutate,notify]);
  const moveSessions = useCallback(async (sourceWorkspaceId:string, sessionIds:string[], workspaceId:string) => {
    const document = await mutate({type:'move_sessions',sourceWorkspaceId,sessionIds,workspaceId});
    notify(`已将 ${sessionIds.length} 个会话移至「${document.workspaces.find(w=>w.id===workspaceId)?.name||'目标工作区'}」`);
    return document;
  }, [mutate,notify]);
  const importImages = useCallback(async (asReference: boolean, workspaceId?: string, sessionId?: string) => {
    requireDesktop();
    const selection = await open({ multiple: true, directory: false, title: asReference ? '导入参考图' : '导入图片', filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
    if (!selection) return [];
    const result = await invoke<{ document: StudioDocument; assetIds: string[]; count: number; errors: string[] }>('import_assets', { paths: Array.isArray(selection) ? selection : [selection], asReference, workspaceId: workspaceId || null, sessionId: sessionId || null });
    accept(result.document);
    if (result.count) notify(`已导入 ${result.count} 张图片，原文件保留不变`);
    if (result.errors.length) notify(result.errors.join('；'), true);
    return result.assetIds;
  }, [accept, notify, requireDesktop]);
  const exportImage = useCallback(async (asset: Asset) => {
    requireDesktop();
    if (asset.demo) { notify('示例插画用于界面预览，请使用导入或生成的实际图片。'); return; }
    const extension = asset.path.split('.').pop() || 'png';
    const safeName = asset.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'image';
    const destination = await save({ title: '导出原图', defaultPath: `${safeName}.${extension}`, filters: [{ name: '原图', extensions: [extension] }] });
    if (!destination) return;
    await invoke('export_asset', { assetId: asset.id, destination }); notify('原图已导出');
  }, [notify, requireDesktop]);
  const refine = useCallback(async (prompt: string, referenceIds: string[], mode: string, sessionId: string) => {
    requireDesktop(); await settingsWrites.current!.idle(); return invoke<RefineResult>('refine_prompt', { prompt, referenceIds, mode, sessionId });
  }, [requireDesktop]);
  const importClipboardImages = useCallback(async (files: File[], workspaceId: string, sessionId: string) => {
    requireDesktop();
    const images = await Promise.all(files.map(async file => {
      if (file.size > 20 * 1024 * 1024) throw new Error('单张粘贴图片不能超过 20 MB。');
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('无法读取剪贴板中的图片。'));
        reader.readAsDataURL(file);
      });
      return { name: file.name || '粘贴的图片', data };
    }));
    const result = await invoke<{ document: StudioDocument; assetIds: string[] }>('import_image_data', { images, workspaceId, sessionId });
    accept(result.document); notify(`已添加 ${result.assetIds.length} 张参考图`);
    return result.assetIds;
  }, [requireDesktop, accept, notify]);
  const nameSession = useCallback(async (sessionId: string) => {
    requireDesktop(); await settingsWrites.current!.idle(); const document = await invoke<StudioDocument>('name_session', { sessionId }); accept(document); return document;
  }, [requireDesktop, accept]);
  const imageUrl = useCallback((asset: Asset, thumbnail = false) => {
    if (asset.path.startsWith('data:')) return asset.path;
    if (asset.demo) return asset.path;
    if (asset.mime === 'image/svg+xml' && !asset.thumbnailPath) return '';
    if (!boot.dataDir) return '';
    return convertFileSrc(`${boot.dataDir.replace(/[\\/]$/, '')}/${(thumbnail || asset.mime === 'image/svg+xml') && asset.thumbnailPath ? asset.thumbnailPath : asset.path}`);
  }, [boot.dataDir]);
  const generationStartedAt = (job?: Job) => {
    if (!job) return undefined;
    const active = activeGenerations[job.sessionId];
    return active && !active.previousJobs.has(job.id) ? active.startedAt : undefined;
  };
  const generate = useCallback(async (request: GenerationRequest) => {
    requireDesktop();
    await settingsWrites.current!.idle();
    const previousJobs = new Set(bootRef.current.document.jobs.map(job => job.id));
    const startedAt = Date.now(), started = performance.now();
    setActiveGenerations(current => ({ ...current, [request.sessionId]: { startedAt, previousJobs } }));
    try {
      let document = await invoke<StudioDocument>('generate', { request });
      accept(document);
      const job = document.jobs.find(job => job.sessionId === request.sessionId && !previousJobs.has(job.id) && job.status === 'completed');
      if (job) {
        try {
          const assets = job.assetIds.map(id => document.assets.find(asset => asset.id === id));
          await waitForGeneratedImages(assets.map(asset => asset ? imageUrl(asset) : ''));
        } catch {
          notify('生成完成，原图已保存；图片加载失败，请重新打开查看。', true);
          return document;
        }
        const elapsedMs = Math.round(performance.now() - started);
        try { document = await mutate({ type: 'record_generation_elapsed', id: job.id, elapsedMs }); }
        catch { notify('图片已生成并显示，但总耗时未能保存。', true); return document; }
      }
      notify('生成完成，原图已保存到本地图库');
      return document;
    } finally {
      setActiveGenerations(current => { const next = { ...current }; delete next[request.sessionId]; return next; });
    }
  }, [accept, imageUrl, mutate, notify, requireDesktop]);
  const report = useCallback((error: unknown) => notify(error instanceof Error ? error.message : String(error), true), [notify]);
  const listModels = useCallback(async (providerId: string) => { requireDesktop(); await settingsWrites.current!.idle(); return invoke<string[]>('list_provider_models',{providerId}); },[requireDesktop]);
  const usageRecords = useCallback(async () => { requireDesktop(); return invoke<UsageSummary>('usage_records'); },[requireDesktop]);
  const networkSettings = useCallback(async () => { requireDesktop(); await settingsWrites.current!.idle(); return invoke<NetworkState>('network_settings'); }, [requireDesktop]);
  const testNetworkSettings = useCallback(async (settings: NetworkConfig) => { requireDesktop(); return invoke<{ elapsedMs: number }>('test_network_settings', { settings }); }, [requireDesktop]);
  const exportUsage = useCallback(async () => { requireDesktop(); const destination=await save({title:'导出用量记录',defaultPath:'image-studio-usage.jsonl',filters:[{name:'JSON Lines',extensions:['jsonl']}]});if(destination){await invoke('export_usage',{destination});notify('用量日志已导出');} },[requireDesktop,notify]);
  const chooseDataDirectory = useCallback(async () => { requireDesktop(); return open({directory:true,multiple:false,title:'选择空的数据目录'}); },[requireDesktop]);
  const relocateData = useCallback(async (destination:string) => { requireDesktop(); await settingsWrites.current!.idle(); await invoke('relocate_data',{destination});notify('正在迁移数据并重启应用…'); },[requireDesktop,notify]);
  return { ...boot, accept, registerSketchEditor, flushSketchEditors, apiError, setApiError, galleryTasks, galleryDraft, setGalleryDraft, requestGalleryImport, enqueueGalleryImport, controlGalleryImport, openGalleryPost, ready, loadError, toasts, settingsSaving, settingsError, sync, syncBusy, syncNow, refreshSync, notify, report, refresh, mutate, saveSettings, importImages, importClipboardImages, nameSession, exportImage, generate, generationStartedAt, refine, imageUrl, listModels, usageRecords, networkSettings, testNetworkSettings, exportUsage, chooseDataDirectory, relocateData, moveSession, registerSessionEditor, previewDeleteSession, deleteSession, previewDeleteWorkspace, deleteWorkspace, previewDeleteSessions, deleteSessions, moveSessions };
}
export type Studio = ReturnType<typeof useStudio>;
