import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import type { Asset } from './types';
import type { Studio } from './useStudio';

export default function UserMessage({text,referenceIds=[],assets,imageUrl,onOpen}:{text:string;referenceIds?:string[];assets:Asset[];imageUrl:Studio['imageUrl'];onOpen:(id:string,scopeIds:string[])=>void}){
  const [failed,setFailed]=useState<Set<string>>(()=>new Set());
  const byId=new Map(assets.map(asset=>[asset.id,asset]));
  return <div className="user-prompt">
    {!!referenceIds.length&&<div className="message-references" role="group" aria-label="本次提交的参考图">{referenceIds.map((id,index)=>{
      const asset=byId.get(id);
      const unavailable=!asset||failed.has(id);
      return <button className="message-reference" key={`${id}-${index}`} disabled={!asset} title={asset?.title||'参考图已不可用'} aria-label={asset?`查看参考图 ${index+1}：${asset.title}`:`参考图 ${index+1} 已不可用`} onClick={()=>asset&&onOpen(asset.id,referenceIds)}>
        {unavailable?<span className="message-reference-missing"><ImageOff/><span>{asset?'查看原图':'参考图不可用'}</span></span>:<img src={imageUrl(asset,true)} alt={asset.title} loading="lazy" draggable={false} onError={()=>setFailed(current=>new Set([...current,id]))}/>}
      </button>;
    })}</div>}
    <div className="user-prompt-text">{text}</div>
  </div>;
}
