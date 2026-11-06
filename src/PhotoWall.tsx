import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Asset } from './types';

export type PreviewSize = 'normal' | 'large' | 'xlarge';
const heights: Record<PreviewSize,number> = {normal:150,large:225,xlarge:300};
const gap=4;
const ratio=(asset:Asset)=>asset.width>0&&asset.height>0?asset.width/asset.height:1;

export default function PhotoWall({assets,size,renderAsset}:{assets:Asset[];size:PreviewSize;renderAsset:(asset:Asset)=>ReactNode}) {
  const container=useRef<HTMLDivElement>(null);
  const [width,setWidth]=useState(0);
  useLayoutEffect(()=>{
    const node=container.current;
    if(!node)return;
    const observer=new ResizeObserver(entries=>setWidth(Math.floor(entries[0].contentRect.width)));
    observer.observe(node);
    return()=>observer.disconnect();
  },[]);
  const rows:{assets:Asset[];height:number}[]=[];
  const target=heights[size];
  let pending:Asset[]=[],totalRatio=0;
  function flush(last=false){
    if(!pending.length)return;
    const fitted=(width-gap*(pending.length-1))/totalRatio;
    rows.push({assets:pending,height:last?Math.min(target,fitted):fitted});
    pending=[];totalRatio=0;
  }
  if(width>0){
    for(const asset of assets){
      const nextRatio=totalRatio+ratio(asset);
      const nextHeight=(width-gap*pending.length)/nextRatio;
      const currentHeight=pending.length?(width-gap*(pending.length-1))/totalRatio:Infinity;
      // Choose the row break closest to the requested height, keeping source order.
      if(pending.length&&nextHeight<target&&Math.abs(currentHeight-target)<Math.abs(nextHeight-target))flush();
      pending.push(asset);totalRatio+=ratio(asset);
      if(totalRatio*target+gap*(pending.length-1)>=width)flush();
    }
    flush(true);
  }
  return <div className="photo-wall" ref={container}>{rows.map(row=><div className="photo-wall-row" key={row.assets[0].id} style={{height:row.height}}>{row.assets.map(asset=><div className="photo-wall-cell" key={asset.id} style={{width:row.height*ratio(asset)}}>{renderAsset(asset)}</div>)}</div>)}</div>;
}
