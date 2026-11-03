import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';
import { Aperture, ArrowUp, Check, ChevronDown, Columns2, FolderInput, ImagePlus, LoaderCircle, MessageSquare, Plus, SlidersHorizontal, Sparkles, WandSparkles, X } from 'lucide-react';
import { AssetCard, Empty, Modal, PromptDetails, ResultInformation, timeLabel } from './components';
import type { Asset, ContextMode, Session } from './types';
import { desktop, type Studio } from './useStudio';
import { availableQualities, extendedSizes, flexibleSizes, qualityOptions, sizeCaption, standardSizes, validateImageSize } from './imageOptions';

export default function Workspace({ studio, session, onOpen, onBranch, onPreset, onSettings, onMove }: { studio: Studio; session: Session; onOpen: (id: string) => void; onBranch: (asset: Asset) => void; onPreset: (asset: Asset) => void; onSettings: () => void; onMove: (sessionId:string)=>void }) {
  const [draft, setDraft] = useState(session.draft);
  const [original, setOriginal] = useState(session.originalPrompt || session.draft);
  const [referenceIds, setReferenceIds] = useState(session.referenceIds);
  const [context, setContext] = useState<ContextMode>(session.contextMode);
  const [size, setSize] = useState(session.size || 'auto');
  const [quality, setQuality] = useState(session.quality || 'auto');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [customSize, setCustomSize] = useState(!!session.size && ![...standardSizes, ...extendedSizes].some(option => option.value === session.size));
  const [customWidth, setCustomWidth] = useState(session.size?.split('x')[0] || '1024');
  const [customHeight, setCustomHeight] = useState(session.size?.split('x')[1] || '1024');
  const [pasting, setPasting] = useState(false);
  const [naming, setNaming] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [view, setView] = useState<'conversation' | 'results' | 'compare'>('conversation');
  const [picking, setPicking] = useState(false);
  const [refineMode, setRefineMode] = useState('faithful');
  const [refining, setRefining] = useState(false);
  const [candidate, setCandidate] = useState<{ prompt: string; model: string; source: string } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const threadRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ draft, original, referenceIds, context, size, quality });
  const moveInProgress=useRef(false),saveTimeout=useRef(0),editorBusy=useRef(false);
  editorBusy.current=pasting||refining||generating;
  latest.current = { draft, original, referenceIds, context, size, quality };
  const sessionAssets = useMemo(() => studio.document.assets.filter(a => a.sessionId === session.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [studio.document.assets, session.id]);
  const referenceAssets = referenceIds.map(id => studio.document.assets.find(a => a.id === id)).filter((a): a is Asset => !!a);
  const runningJob = studio.document.jobs.find(j => j.sessionId === session.id && j.status === 'running');
  const failedJob = studio.document.jobs.find(j => j.sessionId === session.id && ['failed', 'interrupted'].includes(j.status));
  const workspace = studio.document.workspaces.find(w => w.id === session.workspaceId);
  const canContinue = (!session.lastProviderId || session.lastProviderId === studio.document.settings.generation.providerId) && !!session.lastResponseId && studio.document.settings.generation.apiMode === 'responses' && session.lastProviderBaseUrl === studio.document.settings.generation.baseUrl && session.lastMainModel === studio.document.settings.generation.mainModel;
  const initial = useRef(true);
  const model = studio.document.settings.generation.model;
  const supportsCustom = flexibleSizes(model);
  const sizes = supportsCustom ? [...standardSizes, ...extendedSizes] : standardSizes;
  const qualities = availableQualities(model);
  const sizeError = validateImageSize(size, model);

  useEffect(() => {
    if (!availableQualities(model).some(option => option.value === quality)) setQuality('auto');
    if (!flexibleSizes(model) && !standardSizes.some(option => option.value === size)) { setSize('auto'); setCustomSize(false); }
  }, [model]);
  useEffect(() => { const el=textareaRef.current; if (el) { el.style.height='auto'; el.style.height=`${Math.min(el.scrollHeight,160)}px`; } }, [draft]);
  useEffect(() => {
    if (!generating || !runningJob) return;
    setDraft(''); setOriginal(''); setReferenceIds([]); setCandidate(null);
    latest.current = { ...latest.current, draft:'', original:'', referenceIds:[] };
  }, [generating, runningJob?.id]);
  useEffect(() => {
    if (!optionsOpen) return;
    const dismiss=(event: PointerEvent) => { if (!optionsRef.current?.contains(event.target as Node)) setOptionsOpen(false); };
    const escape=(event: KeyboardEvent) => { if (event.key==='Escape') setOptionsOpen(false); };
    window.addEventListener('pointerdown',dismiss); window.addEventListener('keydown',escape);
    return () => { window.removeEventListener('pointerdown',dismiss); window.removeEventListener('keydown',escape); };
  }, [optionsOpen]);

  useEffect(() => {
    if (!desktop || moveInProgress.current) return;
    if (initial.current) { initial.current = false; return; }
    const timeout = window.setTimeout(() => {
      void studio.mutate({ type: 'update_session', id: session.id, draft, originalPrompt: original, referenceIds, contextMode: context, size, quality }).catch(studio.report);
    }, 650);
    saveTimeout.current=timeout;
    return () => window.clearTimeout(timeout);
  }, [draft, original, referenceIds, context, size, quality, session.id, studio.mutate, studio.report]);
  useEffect(() => () => {
    if (!desktop || moveInProgress.current) return;
    const value = latest.current;
    if (value.draft !== session.draft || value.original !== session.originalPrompt || value.referenceIds.join() !== session.referenceIds.join() || value.context !== session.contextMode || value.size !== session.size || value.quality !== session.quality) {
      void studio.mutate({ type: 'update_session', id: session.id, draft: value.draft, originalPrompt: value.original, referenceIds: value.referenceIds, contextMode: value.context, size: value.size, quality: value.quality }).catch(studio.report);
    }
  }, [session.id]);
  useEffect(()=>studio.registerSessionEditor(session.id,async action=>{
    if(moveInProgress.current||editorBusy.current)throw new Error('请等待图片输入或 Prompt 优化处理完成后再移动');
    moveInProgress.current=true;window.clearTimeout(saveTimeout.current);
    try {
      const value=latest.current;
      await studio.mutate({type:'update_session',id:session.id,draft:value.draft,originalPrompt:value.original,referenceIds:value.referenceIds,contextMode:value.context,size:value.size,quality:value.quality});
      const document=await studio.mutate(action);
      const current=document.sessions.find(s=>s.id===session.id);
      if(current){latest.current={...value,referenceIds:current.referenceIds};setReferenceIds(current.referenceIds);}
      return document;
    } finally {moveInProgress.current=false;}
  }),[session.id,studio.registerSessionEditor,studio.mutate]);
  useEffect(() => {
    const element=threadRef.current;if(!element)return;
    let frame=0;
    const align=()=>{
      if(view!=='conversation'){element.scrollTop=0;return;}
      if(runningJob){element.scrollTop=element.scrollHeight;return;}
      const heading=element.querySelector('.conversation-turn:last-of-type .assistant-heading');
      if(heading)element.scrollTop+=heading.getBoundingClientRect().top-element.getBoundingClientRect().top-8;
    };
    const resize=()=>{
      element.style.setProperty('--result-image-height',`${Math.max(160,Math.min(470,element.clientHeight-80))}px`);
      cancelAnimationFrame(frame);frame=requestAnimationFrame(align);
    };
    const observer=new ResizeObserver(resize);observer.observe(element);resize();
    return()=>{observer.disconnect();cancelAnimationFrame(frame);};
  }, [sessionAssets.length, session.id, view, runningJob?.id]);
  useEffect(() => { if (!compareIds.length && sessionAssets.length) setCompareIds(sessionAssets.slice(-2).map(a => a.id)); }, [sessionAssets, compareIds.length]);

  async function importReferences() {
    try { const ids = await studio.importImages(false, session.workspaceId, session.id); setReferenceIds(current => [...new Set([...current, ...ids])].slice(0, 8)); } catch (error) { studio.report(error); }
  }
  async function pasteImages(event: ClipboardEvent<HTMLDivElement>) {
    const itemFiles=Array.from(event.clipboardData.items).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter((file):file is File=>!!file);
    const files=itemFiles.length?itemFiles:Array.from(event.clipboardData.files).filter(file=>file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    if (pasting) return;
    if (referenceIds.length+files.length>8) { studio.notify('每个会话最多添加 8 张参考图',true); return; }
    setPasting(true);
    try { const ids=await studio.importClipboardImages(files,session.workspaceId,session.id);setReferenceIds(current=>[...new Set([...current,...ids])]); }
    catch(error){studio.report(error);}finally{setPasting(false);}
  }
  async function nameSession() {
    setNaming(true);
    try {
      await studio.mutate({ type:'update_session',id:session.id,draft,originalPrompt:original,referenceIds,contextMode:context,size,quality });
      await studio.nameSession(session.id); studio.notify('会话已自动命名');
    } catch(error){studio.report(error);}finally{setNaming(false);}
  }
  async function refinePrompt() {
    if (!studio.hasRefineKey) { studio.notify('请先在设置中配置 Prompt 优化服务和密钥'); onSettings(); return; }
    setRefining(true);
    try { const source = draft; const result = await studio.refine(source, referenceIds, refineMode, session.id); setCandidate({ ...result, source }); } catch (error) { studio.report(error); } finally { setRefining(false); }
  }
  async function generate() {
    if (pasting || generating || runningJob) return;
    if (sizeError) { studio.notify(sizeError,true); return; }
    if (!draft.trim()) { studio.notify('先写下你想生成或修改的内容'); return; }
    if (!studio.hasImageKey) { studio.notify('请先在设置中配置生成服务和 API Key'); onSettings(); return; }
    setGenerating(true);
    try {
      const effectiveContext = canContinue ? context : 'new';
      await studio.mutate({ type: 'update_session', id: session.id, draft, originalPrompt: original || draft, referenceIds, contextMode: effectiveContext, size, quality });
      await studio.generate({ sessionId: session.id, prompt: draft, originalPrompt: original || draft, referenceIds, size, quality, contextMode: effectiveContext });
      setView('conversation'); if (studio.document.settings.generation.apiMode === 'responses') setContext('continue');
    } catch (error) { studio.report(error); } finally { setGenerating(false); }
  }
  const compared = compareIds.map(id => studio.document.assets.find(a => a.id === id)).filter((a): a is Asset => !!a);
  return <>
    <header className="page-header workspace-header"><div className="workspace-heading"><span className="workspace-breadcrumb" title={workspace?.name}>{workspace?.name || '工作区'}</span><span className="workspace-header-divider">/</span><h1 title={session.title}>{session.title}</h1></div><div className="segment" role="group" aria-label="工作区视图"><button aria-pressed={view === 'conversation'} onClick={() => setView('conversation')}><MessageSquare />会话</button><button aria-pressed={view === 'results'} onClick={() => setView('results')}><ImagePlus />结果</button><button aria-pressed={view === 'compare'} onClick={() => setView('compare')}><Columns2 />对比</button></div><div className="header-actions"><button className="icon-button" aria-label="移动当前会话" title="移动到其他工作区" onClick={()=>onMove(session.id)} disabled={studio.document.workspaces.length<2||!!runningJob||session.titleStatus==='pending'}><FolderInput/></button><button className="button ghost small" onClick={() => void nameSession()} disabled={naming || session.titleStatus==='pending' || (!draft.trim()&&!sessionAssets.length)} title={session.titleError || '用 Prompt 优化模型概括会话内容'}>{naming || session.titleStatus==='pending' ? <LoaderCircle className="spin" /> : <WandSparkles />}{naming || session.titleStatus==='pending' ? '正在命名' : '自动命名'}</button><span className="subtle-badge">{sessionAssets.length} 张作品</span></div></header>
    <div className="workspace-layout">
      <section className="workspace-stage" aria-label="会话内容">
        <div className="thread-scroll" ref={threadRef}>
          {view === 'conversation' && <div className="conversation-content">
            {!sessionAssets.length && !runningJob && <Empty title="从一个想法开始" description="添加参考图，写下 Prompt。生成结果和每一次修改都会留在这里。" icon={<Sparkles />} />}
            {sessionAssets.map((asset, index) => <article className="conversation-turn" key={asset.id}><div className="turn-heading"><span className="avatar user-avatar">你</span><span>{timeLabel(asset.createdAt)}</span><span className="turn-number">第 {index + 1} 次生成</span></div><div className="user-prompt">{asset.originalPrompt || asset.submittedPrompt || '导入的图片'}</div><div className="assistant-heading"><span className="assistant-mark"><Sparkles size={13} /></span><span>Image Studio</span><span className="muted">{asset.demo ? '设计示例' : '生成完成'}</span></div>
              <div className="result-card"><button className="conversation-image" aria-label={`放大 ${asset.title}`} onClick={() => onOpen(asset.id)}><img src={studio.imageUrl(asset)} alt={asset.title} loading="lazy" /></button>
              <ResultInformation asset={asset} studio={studio} expanded onOpen={() => onOpen(asset.id)} onBranch={() => onBranch(asset)} onPreset={() => onPreset(asset)} /></div>
            </article>)}
            {runningJob && <div className="pending-generation"><LoaderCircle className="spin" /><div>正在生成图片<p>可以切换页面，任务会继续运行。</p></div></div>}
            {failedJob && <div className="generation-error"><span>最近一次任务未完成</span><p>{failedJob.error}</p><button className="button secondary small" onClick={() => { setDraft(failedJob.prompt); setOriginal(failedJob.originalPrompt || failedJob.prompt); setReferenceIds(failedJob.referenceIds || []); setContext(failedJob.contextMode || 'new'); }}>重新载入此任务的输入</button></div>}
          </div>}
          {view === 'results' && <div className="results-grid">{[...sessionAssets].reverse().map(asset => <AssetCard key={asset.id} asset={asset} studio={studio} onSelect={() => onOpen(asset.id)} onOpen={() => onOpen(asset.id)} />)}{!sessionAssets.length && <Empty title="还没有生成结果" description="完成生成后，可以在这里集中浏览作品。" />}</div>}
          {view === 'compare' && <div className="comparison-content"><div className="comparison-title"><h2>并排比较</h2><p>选择两张结果，比较画面与实际提交的 Prompt。</p></div><div className="compare-selectors">{[0, 1].map(index => <label className="field" key={index}><span className="field-label">{index ? 'B · 对照结果' : 'A · 基准结果'}</span><select value={compareIds[index] || ''} onChange={e => setCompareIds(current => { const next = [...current]; next[index] = e.target.value; return next; })}><option value="">选择图片</option>{studio.document.assets.filter(a => a.workspaceId === session.workspaceId).map(asset => <option key={asset.id} value={asset.id}>{asset.title} · {timeLabel(asset.createdAt)}</option>)}</select></label>)}</div><div className="comparison-grid">{[0, 1].map(index => { const asset = compared[index]; return asset ? <article key={index}><button className="compare-image" aria-label={`放大对比图片 ${index ? 'B' : 'A'}`} onClick={() => onOpen(asset.id)}><img src={studio.imageUrl(asset)} alt={asset.title} /></button><div className="compare-caption"><strong>{index ? 'B' : 'A'} · {asset.title}</strong><span>{asset.width} × {asset.height}</span></div><PromptDetails key={asset.id} asset={asset} studio={studio} compact /></article> : <div className="compare-empty" key={index}>选择一张图片</div>; })}</div></div>}
        </div>
        <div className="composer-dock" onPaste={event => void pasteImages(event)} aria-label="Prompt 与图片输入区">
          {candidate && <section className="refine-candidate dock-candidate"><div className="panel-label"><span><Sparkles size={12} />优化建议</span><button className="icon-button" aria-label="关闭优化建议" onClick={() => setCandidate(null)}><X /></button></div><p>{candidate.prompt}</p><div className="candidate-footer"><span>{candidate.model}</span><button className="button secondary small" disabled={draft !== candidate.source} onClick={() => { setDraft(candidate.prompt); setCandidate(null); studio.notify('已采用建议，原始意图仍会保留'); }}><Check />采用建议</button></div>{draft !== candidate.source && <p className="muted">Prompt 已修改，请重新优化。</p>}</section>}
          <div className={`composer-card ${pasting ? 'pasting' : ''}`}>
            {referenceAssets.length > 0 && <div className="dock-references">{referenceAssets.map(asset => <div className="dock-reference" key={asset.id}><button className="dock-reference-preview" aria-label={`查看参考图 ${asset.title}`} onClick={() => onOpen(asset.id)}><img src={studio.imageUrl(asset, true)} alt={asset.title} /></button><span>{asset.title}</span><button className="icon-button" aria-label={`移除参考图 ${asset.title}`} onClick={() => setReferenceIds(ids => ids.filter(id => id !== asset.id))}><X /></button></div>)}<span className="reference-count">{referenceIds.length} / 8</span></div>}
            <div className="composer-input-row"><button className="composer-attach" aria-label="选择参考图" title="选择或导入参考图" onClick={() => setPicking(true)} disabled={referenceIds.length >= 8 || pasting}><Plus /></button><textarea ref={textareaRef} rows={1} id="prompt-editor" aria-label="Prompt" className="composer-textarea" placeholder="描述你想要的图片，或粘贴图片进行编辑…" value={draft} onChange={event => { setDraft(event.target.value); setOriginal(event.target.value); }} onKeyDown={event => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); void generate(); } }} /></div>
            <div className="composer-toolbar">
              <button className="composer-model" aria-label="配置图像模型" onClick={onSettings}><span className="composer-model-icon"><Aperture /></span><span>{model}</span><ChevronDown /></button>
              <div className="composer-options-anchor" ref={optionsRef}><button className="composer-tool" aria-label="生成选项" aria-expanded={optionsOpen} onClick={() => setOptionsOpen(value => !value)}><SlidersHorizontal /><span>{size==='auto'&&quality==='auto'?'自动':`${sizeCaption(size)} · ${qualityOptions.find(option=>option.value===quality)?.label||quality}`}</span></button>
                {optionsOpen && <section className="generation-options" role="dialog" aria-label="生成选项菜单"><div className="panel-label"><span>生成选项</span><button className="icon-button" aria-label="关闭生成选项" onClick={() => setOptionsOpen(false)}><X /></button></div>
                  <label className="field"><span className="field-label">图片尺寸</span><select aria-label="图片尺寸" value={customSize?'custom':size} onChange={event=>{if(event.target.value==='custom'){const parts=/^(\d+)x(\d+)$/.exec(size);const width=parts?.[1]||'1024',height=parts?.[2]||'1024';setCustomSize(true);setCustomWidth(width);setCustomHeight(height);setSize(`${width}x${height}`);}else{setCustomSize(false);setSize(event.target.value);}}}>{sizes.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}{supportsCustom&&<option value="custom">自定义尺寸…</option>}</select></label>
                  {customSize&&supportsCustom&&<><div className="form-columns custom-dimensions"><label className="field"><span className="field-label">宽度（px）</span><input aria-label="图片宽度" type="number" min={16} max={3840} step={16} value={customWidth} onChange={event=>{setCustomWidth(event.target.value);setSize(`${event.target.value}x${customHeight}`);}} /></label><label className="field"><span className="field-label">高度（px）</span><input aria-label="图片高度" type="number" min={16} max={3840} step={16} value={customHeight} onChange={event=>{setCustomHeight(event.target.value);setSize(`${customWidth}x${event.target.value}`);}} /></label></div><p className="option-help">16 的倍数 · 最长边 3840 · 比例不超过 3:1</p>{sizeError&&<p className="option-error" role="alert">{sizeError}</p>}</>}
                  <label className="field"><span className="field-label">图片质量</span><select aria-label="图片质量" value={quality} onChange={event=>setQuality(event.target.value)}>{qualities.map(option=><option value={option.value} key={option.value}>{option.label}</option>)}</select></label><p className="option-help">较高质量通常需要更长时间与更多费用。</p>
                </section>}
              </div>
              <button className="composer-tool refine-tool" aria-label="优化 Prompt" onClick={()=>void refinePrompt()} disabled={refining||!draft.trim()||pasting}>{refining?<LoaderCircle className="spin" />:<Sparkles />}<span>优化</span></button><select className="composer-refine-mode" aria-label="优化方式" value={refineMode} onChange={event=>setRefineMode(event.target.value)}><option value="faithful">忠实</option><option value="creative">创意</option></select>
              <span className="composer-toolbar-spacer" />
              <select className="composer-context" aria-label="会话上下文" value={canContinue?context:'new'} onChange={event=>setContext(event.target.value as ContextMode)}><option value="new">独立生成</option><option value="continue" disabled={!canContinue}>接续结果</option></select><button className="composer-send" aria-label="生成图片" title="生成图片（Ctrl+Enter）" disabled={generating||!!runningJob||pasting||!draft.trim()||!!sizeError} onClick={()=>void generate()}>{generating||runningJob||pasting?<LoaderCircle className="spin" />:<ArrowUp />}</button>
            </div>
          </div>
        </div>
      </section>
    </div>
    {picking && <Modal title="选择参考图" onClose={() => setPicking(false)} className="reference-picker"><div className="picker-topline"><p>全局参考图与本地图片 · 最多 8 张</p><button className="button secondary" onClick={() => void importReferences()}><Plus />导入图片</button></div><div className="picker-grid">{studio.document.assets.filter(a => !a.demo).map(asset => <button key={asset.id} className={`picker-item ${referenceIds.includes(asset.id) ? 'picked' : ''}`} aria-pressed={referenceIds.includes(asset.id)} onClick={() => setReferenceIds(current => current.includes(asset.id) ? current.filter(id => id !== asset.id) : current.length < 8 ? [...current, asset.id] : current)}><img src={studio.imageUrl(asset, true)} alt={asset.title} /><span>{asset.title}</span>{referenceIds.includes(asset.id) && <span className="picked-check"><Check size={13} /></span>}</button>)}</div>{!studio.document.assets.some(a => !a.demo) && <Empty title="导入你的第一张参考图" description="原文件会完整保存，并生成 WebP 预览副本。" icon={<ImagePlus />}><button className="button primary" onClick={() => void importReferences()}><Plus />导入参考图</button></Empty>}<footer className="modal-footer"><span className="muted">已选 {referenceIds.length} 张</span><button className="button primary" onClick={() => setPicking(false)}>完成选择</button></footer></Modal>}
  </>;
}
