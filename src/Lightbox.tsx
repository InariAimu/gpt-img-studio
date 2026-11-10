import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, ArrowRight, Download, Expand, RotateCw, Scan, ZoomIn, ZoomOut } from 'lucide-react';
import { Modal } from './components';
import type { Asset, StudioDocument } from './types';
import type { Studio } from './useStudio';

type Transform = { scale: number; x: number; y: number; rotation: number };
export function Lightbox({ asset, document: library, imageUrl, onClose, onSelect, onExport }: { asset: Asset; document: StudioDocument; imageUrl: Studio['imageUrl']; onClose: () => void; onSelect: (id: string) => void; onExport?: () => void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>({ scale: 1, x: 0, y: 0, rotation: 0 });
  const current = useRef(transform); current.current = transform;
  const drag = useRef<{ id: number; x: number; y: number; originX: number; originY: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const src = imageUrl(asset);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const ratio = window.devicePixelRatio || 1;
  const index = library.assets.findIndex(a => a.id === asset.id);
  const navigation=useRef({assets:library.assets,index,onSelect}); navigation.current={assets:library.assets,index,onSelect};
  function apply(next: Transform) {
    const rect = viewport.current?.getBoundingClientRect(); if (!rect) return;
    const rotated = next.rotation % 180 !== 0;
    const limitX = Math.max(0, ((rotated ? asset.height : asset.width) * next.scale - rect.width) / 2);
    const limitY = Math.max(0, ((rotated ? asset.width : asset.height) * next.scale - rect.height) / 2);
    next = { ...next, x: Math.max(-limitX, Math.min(limitX, next.x)), y: Math.max(-limitY, Math.min(limitY, next.y)) };
    current.current = next; setTransform(next);
  }
  function fit(rotation = current.current.rotation) {
    const rect = viewport.current?.getBoundingClientRect(); if (!rect) return;
    const rotated = rotation % 180 !== 0;
    const scale = Math.min((rect.width - 32) / (rotated ? asset.height : asset.width), (rect.height - 32) / (rotated ? asset.width : asset.height), 1 / ratio);
    apply({ scale: Math.max(0.01 / ratio, scale), x: 0, y: 0, rotation });
  }
  function zoom(scale: number, clientX?: number, clientY?: number) {
    const rect = viewport.current?.getBoundingClientRect(); if (!rect) return;
    const previous = current.current;
    scale = Math.max(0.01 / ratio, Math.min(16 / ratio, scale));
    const x = clientX === undefined ? 0 : clientX - rect.left - rect.width / 2;
    const y = clientY === undefined ? 0 : clientY - rect.top - rect.height / 2;
    apply({ ...previous, scale, x: x - (x - previous.x) * scale / previous.scale, y: y - (y - previous.y) * scale / previous.scale });
  }
  function navigate(offset: number) { const value=navigation.current;const next=value.assets[value.index+offset];if(next)value.onSelect(next.id); }
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    fit(0);
    const observer = new ResizeObserver(() => fit()); observer.observe(element);
    const wheel = (event: WheelEvent) => { event.preventDefault(); zoom(current.current.scale * Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.0025), event.clientX, event.clientY); };
    element.addEventListener('wheel', wheel, { passive: false });
    const key = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || (event.target as HTMLElement).matches('input,textarea,select')) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); navigate(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); navigate(1); }
      if (['+', '='].includes(event.key)) { event.preventDefault(); zoom(current.current.scale * 1.25); }
      if (event.key === '-') { event.preventDefault(); zoom(current.current.scale / 1.25); }
      if (event.key === '0') { event.preventDefault(); fit(); }
      if (event.key === '1') { event.preventDefault(); apply({ ...current.current, scale: 1 / ratio, x: 0, y: 0 }); }
    };
    window.addEventListener('keydown', key);
    return () => { observer.disconnect(); element.removeEventListener('wheel', wheel); window.removeEventListener('keydown', key); };
  }, [asset.id, asset.width, asset.height, onSelect]);
  return <Modal title={asset.title} onClose={onClose} className="lightbox">
    <div className="lightbox-body">
    <div ref={viewport} className={`lightbox-viewport ${dragging ? 'dragging' : ''}`} aria-label="图片查看区域" onDoubleClick={() => Math.abs(current.current.scale * ratio - 1) < 0.01 ? fit() : apply({ ...current.current, scale: 1 / ratio, x: 0, y: 0 })}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id:event.pointerId, x:event.clientX, y:event.clientY, originX:current.current.x, originY:current.current.y }; setDragging(true); }}
      onPointerMove={event => { const start=drag.current; if (start?.id !== event.pointerId) return; apply({ ...current.current, x:start.originX+event.clientX-start.x, y:start.originY+event.clientY-start.y }); }}
      onPointerUp={() => { drag.current=null; setDragging(false); }} onPointerCancel={() => { drag.current=null; setDragging(false); }} onLostPointerCapture={() => { drag.current=null; setDragging(false); }}>
      <img className="image-checkerboard" src={src} alt={asset.title} draggable={false} data-loaded={loadedSrc === src}
        onLoad={() => setLoadedSrc(src)} onError={() => setLoadedSrc(null)}
        style={{ width:asset.width, height:asset.height, '--image-scale':transform.scale, transform:`translate(-50%,-50%) translate(${transform.x}px,${transform.y}px) rotate(${transform.rotation}deg) scale(${transform.scale})` } as CSSProperties} />
    </div>
    <div className="lightbox-toolbar"><span className="lightbox-size">{asset.width} × {asset.height}</span><div className="lightbox-controls">
      <button className="icon-button" aria-label="缩小图片" title="缩小（−）" onClick={() => zoom(current.current.scale / 1.25)}><ZoomOut /></button><output aria-label="图片缩放比例">{Math.round(transform.scale * ratio * 100)}%</output><button className="icon-button" aria-label="放大图片" title="放大（+）" onClick={() => zoom(current.current.scale * 1.25)}><ZoomIn /></button>
      <span className="toolbar-divider" /><button className="button ghost small" title="适应窗口（0）" onClick={() => fit()}><Scan />适应窗口</button><button className="button ghost small" title="原始像素（1）" onClick={() => apply({ ...current.current, scale:1/ratio, x:0, y:0 })}>1:1</button><button className="icon-button" aria-label="顺时针旋转图片" onClick={() => fit((current.current.rotation+90)%360)}><RotateCw /></button>
      <button className="icon-button" aria-label="全屏查看图片" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void viewport.current?.parentElement?.requestFullscreen().catch(() => {}); }}><Expand /></button>
      {onExport && <button className="icon-button" aria-label="导出查看中的原图" disabled={asset.demo} onClick={onExport}><Download /></button>}
    </div><div className="lightbox-navigation"><button className="icon-button" aria-label="上一张图片" disabled={index<=0} onClick={() => navigate(-1)}><ArrowLeft /></button><span>{index+1} / {library.assets.length}</span><button className="icon-button" aria-label="下一张图片" disabled={index>=library.assets.length-1} onClick={() => navigate(1)}><ArrowRight /></button></div></div>
    </div>
  </Modal>;
}
