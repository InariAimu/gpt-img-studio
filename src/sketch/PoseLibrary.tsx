import { useEffect, useMemo, useRef, useState } from 'react';
import { Box3, Vector3 } from 'three';
import { Star, Trash2 } from 'lucide-react';
import { Modal } from '../components';
import { entityDefaults, sceneDefaults, type FigureEntity, type SavedPose } from './model.ts';
import { applyPreset, posePresets, type PosePreset } from './poses.ts';
import { SketchRenderer } from './renderer';

export function PoseLibrary({target,saved,favorites,onFavorite,onRemove,onApply,onClose}:{target:string|null;saved:SavedPose[];favorites:string[];onFavorite:(id:string)=>void;onRemove:(id:string)=>void;onApply:(p:PosePreset)=>void;onClose:()=>void}){
  const [category,setCategory]=useState('全部'),[query,setQuery]=useState(''),[family,setFamily]=useState('全部'),[page,setPage]=useState(0),[previews,setPreviews]=useState<Record<string,string>>({}),[error,setError]=useState('');
  const renderer=useRef<SketchRenderer|null>(null);
  const all=useMemo(()=>[...posePresets,...saved.map(p=>({...p,category:'自定义' as const,family:'我的姿势',tags:[p.name]}))],[saved]);
  const filtered=all.filter(p=>(category==='全部'||category==='收藏'&&favorites.includes(p.id)||category===p.category)&&(family==='全部'||p.family===family)&&`${p.name} ${p.tags.join(' ')}`.includes(query.trim()));
  const pages=Math.max(1,Math.ceil(filtered.length/12)),current=Math.min(page,pages-1),visible=filtered.slice(current*12,current*12+12);
  const families=[...new Set(all.filter(p=>category==='全部'||category==='收藏'&&favorites.includes(p.id)||p.category===category).map(p=>p.family))];
  const previewKey=visible.map(p=>p.id).join('|');
  useEffect(()=>{try{renderer.current=new SketchRenderer();}catch{setError('姿势预览暂不可用，仍可按名称应用。');}return()=>{renderer.current?.dispose();renderer.current=null;};},[]);
  useEffect(()=>{
    let cancelled=false;
    const timer=setTimeout(()=>{
      const r=renderer.current;if(!r)return;
      const images:Record<string,string>={};
      for(const p of visible){
        if(previews[p.id])continue;
        const scene=sceneDefaults(),figure=applyPreset({...entityDefaults('figure'),id:'preview'} as FigureEntity,p);scene.entities=[figure];scene.ground.visible=false;
        r.render(scene,200,156);const object=r.objects.get(figure.id)!;
        const bounds=new Box3().setFromObject(object),center=bounds.getCenter(new Vector3()),size=bounds.getSize(new Vector3());
        scene.camera={...scene.camera,azimuth:28,elevation:12,targetX:center.x,targetY:center.y,targetZ:center.z,distance:Math.max(2,Math.max(size.y,size.x*.8,size.z*.8)*2.6)};
        images[p.id]=r.render(scene,200,156).toDataURL('image/webp');
      }
      if(!cancelled)setPreviews(previous=>({...previous,...images}));
    },0);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[previewKey]);
  return <Modal title="分类姿势库" className="sketch-pose-modal" onClose={onClose}>
    <div className="sketch-pose-browser"><p className="sketch-help">{target?`应用到「${target}」，保留体型与水平位置。`:'选择一个姿势添加新人物。'} · {posePresets.length} 个内置姿势</p>
      <div className="sketch-pose-filters"><label className="sketch-field">分类<select aria-label="姿势分类" value={category} onChange={e=>{setCategory(e.target.value);setFamily('全部');setPage(0);}}>{['全部','日常','运动','军事','收藏','自定义'].map(v=><option key={v}>{v}</option>)}</select></label><label className="sketch-field">动作<select aria-label="动作分类" value={family} onChange={e=>{setFamily(e.target.value);setPage(0);}}><option>全部</option>{families.map(v=><option key={v}>{v}</option>)}</select></label><label className="sketch-field">搜索<input aria-label="搜索姿势" placeholder="站立、驾驶、游泳…" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/></label></div>
      {error&&<p role="status">{error}</p>}
      <div className="sketch-pose-cards">{visible.map(p=><article key={p.id}><button className="sketch-pose-apply" aria-label={`${target?'应用':'添加人物并应用'}姿势 ${p.name}`} onClick={()=>onApply(p)}>{previews[p.id]?<img src={previews[p.id]} alt={`${p.name}白模预览`}/>:<div className="sketch-pose-placeholder">预览中…</div>}<strong>{p.name}</strong><span>{p.category} · {p.family}</span></button><div className="sketch-pose-card-actions"><button className="icon-button" aria-label={`${favorites.includes(p.id)?'取消收藏':'收藏'}姿势 ${p.name}`} aria-pressed={favorites.includes(p.id)} onClick={()=>onFavorite(p.id)}><Star fill={favorites.includes(p.id)?'currentColor':'none'}/></button>{p.category==='自定义'&&<button className="icon-button" aria-label={`删除自定义姿势 ${p.name}`} onClick={()=>onRemove(p.id)}><Trash2/></button>}</div></article>)}</div>
      {!visible.length&&<p className="sketch-help">没有匹配的姿势。</p>}
      <div className="sketch-pose-pages"><button className="button secondary small" disabled={current===0} onClick={()=>setPage(current-1)}>上一页</button><span aria-live="polite">{filtered.length} 个姿势 · {current+1} / {pages}</span><button className="button secondary small" disabled={current+1>=pages} onClick={()=>setPage(current+1)}>下一页</button></div>
    </div>
  </Modal>;
}
