import type { Asset } from './types';

/** Preserve submission order and keep a reference preview inside its message. */
export function messageReferences(assets:Asset[],ids:readonly string[]):Asset[]{
  const byId=new Map(assets.map(asset=>[asset.id,asset]));
  const seen=new Set<string>();
  return ids.flatMap(id=>{
    const asset=byId.get(id);
    if(!asset||seen.has(id))return [];
    seen.add(id);return [asset];
  });
}
