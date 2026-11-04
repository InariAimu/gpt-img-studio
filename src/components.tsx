import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Copy, Download, GitBranch, Heart, Image as ImageIcon, Layers, Maximize2, Pencil, WandSparkles, X } from 'lucide-react';
import { AutoSaveInput } from './AutoSaveInput';
import type { Asset, PromptLayer } from './types';
import type { Studio } from './useStudio';

export function Modal({ title, children, onClose, className = '' }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className={`modal ${className}`} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === ref.current) onClose(); }}>
    <header className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><X /></button></header>{children}
  </dialog>;
}
export function Empty({ icon, title, description, children }: { icon?: ReactNode; title: string; description: string; children?: ReactNode }) {
  return <div className="empty"><div className="empty-icon">{icon || <ImageIcon />}</div><h3>{title}</h3><p>{description}</p>{children}</div>;
}
export function AssetCard({ asset, studio, active, versions = 1, onSelect, onOpen }: { asset: Asset; studio: Studio; active?: boolean; versions?: number; onSelect: () => void; onOpen: () => void }) {
  const workspace = studio.document.workspaces.find(w => w.id === asset.workspaceId);
  return <article className={`asset-card ${active ? 'selected' : ''}`}>
    <button className="asset-main" onClick={onSelect} onDoubleClick={onOpen} aria-label={`查看 ${asset.title}`} aria-pressed={active}>
      <span className="asset-frame"><img src={studio.imageUrl(asset, true)} alt={asset.title} loading="lazy" draggable={false} />
        {asset.demo && <span className="sample-badge">示例</span>}{versions > 1 && <span className="version-badge"><Layers size={12} />{versions} 个版本</span>}
      </span><span className="asset-title">{asset.title}</span><span className="asset-subtitle">{workspace?.name || '本地导入'}<span>·</span>{asset.width} × {asset.height}</span>
    </button><button className={`favorite-button ${asset.favorite ? 'is-favorite' : ''}`} aria-label={asset.favorite ? `取消收藏 ${asset.title}` : `收藏 ${asset.title}`} onClick={() => void studio.mutate({ type: 'favorite', id: asset.id }).catch(studio.report)}><Heart size={14} fill={asset.favorite ? 'currentColor' : 'none'} /></button>
  </article>;
}
export function PromptDetails({ asset, studio, compact = false }: { asset: Asset; studio: Studio; compact?: boolean }) {
  const [layer, setLayer] = useState<PromptLayer>('originalPrompt');
  const [copied, setCopied] = useState(false);
  const labels: [PromptLayer, string][] = [['originalPrompt', '原始意图'], ['submittedPrompt', '实际提交'], ['revisedPrompt', 'API 修订']];
  async function copy() {
    if (!asset[layer]) return;
    try { await navigator.clipboard.writeText(asset[layer]!); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch (error) { studio.report(error); }
  }
  return <div className={`prompt-details ${compact ? 'compact' : ''}`}>
    <div className="prompt-tabs" role="group" aria-label="Prompt 来源">{labels.map(([key, label]) => <button key={key} aria-pressed={layer === key} onClick={() => setLayer(key)}>{label}</button>)}<button className="copy-prompt icon-button" aria-label="复制当前 Prompt" onClick={() => void copy()} disabled={!asset[layer]}>{copied ? <Check /> : <Copy />}</button></div>
    <div className={`prompt-body ${!asset[layer] ? 'muted' : ''}`}>{asset[layer] || (layer === 'revisedPrompt' ? '服务未返回修订文本' : '此图片没有关联的 Prompt')}</div>
    <div className="prompt-provenance">{layer === 'originalPrompt' ? '最初的创作意图' : layer === 'submittedPrompt' ? '实际提交给生成服务的文本' : '仅展示服务返回的修订文本'}{asset.demo && ' · 设计示例'}</div>
  </div>;
}
export function AssetInspector({ asset, studio, onClose, onOpen, onBranch, onPreset, onSession, onSelect }: { asset: Asset; studio: Studio; onClose: () => void; onOpen: () => void; onBranch: () => void; onPreset: () => void; onSession: () => void; onSelect: (id: string) => void }) {
  const versions = studio.document.assets.filter(a => a.groupId === asset.groupId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const workspace = studio.document.workspaces.find(w => w.id === asset.workspaceId);
  const session = studio.document.sessions.find(s => s.id === asset.sessionId);
  return <aside className="inspector" aria-label="图片详情"><div className="inspector-heading"><span>作品详情</span><button className="icon-button" aria-label="关闭详情" onClick={onClose}><X /></button></div>
    <button className="inspector-preview" onClick={onOpen} aria-label="放大查看原图"><img src={studio.imageUrl(asset)} alt={asset.title} /><span className="preview-expand"><Maximize2 size={14} /></span></button>
    {asset.demo?<div className="inspector-name">{asset.title}<span className="subtle-badge">示例</span></div>:<label className="inspector-name editable-asset-name" title="修改显示名称，按 Enter 或移开焦点保存"><AutoSaveInput key={asset.id} aria-label="图片名称" className="asset-name-input" value={asset.title} maxLength={200} onCommit={async title=>{try{await studio.mutate({type:'rename_asset',id:asset.id,title});}catch(error){studio.report(error);throw error;}}}/><Pencil aria-hidden="true"/></label>}
    <button className="breadcrumb-link" disabled={!session} onClick={onSession}>{workspace?.name || '本地图库'}{session && <> / {session.title}</>}</button>
    <dl className="properties"><dt>模型</dt><dd>{asset.model}</dd><dt>原图尺寸</dt><dd>{asset.width} × {asset.height}</dd><dt>质量</dt><dd>{qualityLabel(asset.quality)}</dd><dt>保存状态</dt><dd><span className="status-dot" />{asset.demo ? '内置示例插画' : '原图已保存到本地'}</dd></dl>
    <PromptDetails key={asset.id} asset={asset} studio={studio} />
    <div className="inspector-actions"><button className="button secondary" onClick={onBranch}><GitBranch />派生创作</button><button className="button secondary" onClick={() => void studio.exportImage(asset).catch(studio.report)} disabled={asset.demo}><Download />导出</button></div>
    <button className="button primary full" onClick={onPreset}><WandSparkles />保存为效果预设</button>
    {!asset.demo && <button className="button ghost full" onClick={() => void studio.mutate({ type: 'toggle_reference', id: asset.id }).catch(studio.report)}><ImageIcon />{asset.isReference ? '从全局参考图移除' : '加入全局参考图'}</button>}
    <div className="inspector-section"><span>版本记录</span><span className="muted">{versions.length}</span></div><div className="version-thumbnails">{versions.map((version, index) => <button key={version.id} onClick={() => onSelect(version.id)} aria-label={`查看版本 ${index + 1}`} aria-pressed={version.id === asset.id}><img src={studio.imageUrl(version, true)} alt="" /><span>v{index + 1}</span></button>)}</div>
  </aside>;
}
export function ResultInformation({ asset, studio, onBranch, onPreset, onOpen, expanded = false }: { asset: Asset; studio: Studio; onBranch: () => void; onPreset: () => void; onOpen: () => void; expanded?: boolean }) {
  return <div className="result-information"><div className="result-meta"><span>{asset.model}</span><span>{asset.width} × {asset.height}</span><span>{qualityLabel(asset.quality)}</span><span className="saved-state"><span className="status-dot" />{asset.demo ? '示例插画' : '本地已保存'}</span></div>
    <div className="result-toolbar"><button className="button ghost small" onClick={onBranch}><GitBranch />从此图派生</button><button className="button ghost small" onClick={onPreset}><WandSparkles />保存效果</button><button className="button ghost small" onClick={onOpen}><Maximize2 />原图</button><button className="button ghost small" onClick={() => void studio.exportImage(asset).catch(studio.report)} disabled={asset.demo}><Download />导出</button></div>
    <details className="result-record" open={expanded}><summary><ChevronDown size={14} />Prompt 与生成记录{asset.demo && <span className="subtle-badge">示例</span>}</summary><PromptDetails asset={asset} studio={studio} compact /><dl className="properties inline-properties"><dt>参考图</dt><dd>{asset.referenceIds.length} 张</dd><dt>上下文</dt><dd>{asset.previousResponseId ? 'Responses · 接续上一轮' : asset.responseId ? 'Responses · 独立生成' : asset.demo ? '示例记录' : '独立生成'}</dd>{asset.responseId && <><dt>Response ID</dt><dd>{asset.responseId}</dd></>}{asset.previousResponseId && <><dt>接续自</dt><dd>{asset.previousResponseId}</dd></>}</dl></details>
  </div>;
}
export function qualityLabel(quality: string) { return ({ auto: '自动质量', low: '低质量', medium: '标准质量', high: '高质量', xhigh: '超高质量', max: '最高质量', original: '原始文件' } as Record<string, string>)[quality] || quality; }
export function timeLabel(value: string) { return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)); }
