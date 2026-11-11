import { useEffect, useState } from 'react';
export const canvasSizes=['1536x1024','1024x1536','1024x1024'];
export default function CanvasSize({width,height,onChange}:{width:number;height:number;onChange:(width:number,height:number)=>void}){
  const [custom,setCustom]=useState(!canvasSizes.includes(`${width}x${height}`));
  const [w,setW]=useState(String(width)),[h,setH]=useState(String(height));
  useEffect(()=>{setW(String(width));setH(String(height));},[width,height]);
  const valid=[w,h].every(v=>/^\d+$/.test(v)&&Number(v)>=256&&Number(v)<=4096);
  return <div className="sketch-size-controls"><label className="sketch-field">画布尺寸<select aria-label="画布尺寸" value={custom?'custom':`${width}x${height}`} onChange={e=>{if(e.target.value==='custom'){setCustom(true);return;}setCustom(false);const [w,h]=e.target.value.split('x').map(Number);onChange(w,h);}}>
    {canvasSizes.map((size,i)=><option key={size} value={size}>{['横版','竖版','方形'][i]} · {size.replace('x',' × ')}</option>)}<option value="custom">自定义尺寸</option>
  </select></label>{custom&&<><div className="sketch-size-inputs"><label>宽<input aria-label="自定义画布宽度" type="number" min={256} max={4096} value={w} onChange={e=>setW(e.target.value)}/></label><span>×</span><label>高<input aria-label="自定义画布高度" type="number" min={256} max={4096} value={h} onChange={e=>setH(e.target.value)}/></label></div><button className="button secondary small" disabled={!valid||(Number(w)===width&&Number(h)===height)} onClick={()=>onChange(Number(w),Number(h))}>应用尺寸</button><p className="sketch-help">每边 256–4096 像素；二维图层保留位置，3D 场景适配画布。</p></>}</div>;
}
