import { ArrowUpRight, Upload } from 'lucide-react';
import type { Asset } from './types';
import type { Studio } from './useStudio';

export default function GalleryImportButton({asset,studio}:{asset:Asset;studio:Studio}) {
  if(asset.demo||asset.referenceOnly||!asset.sessionId||asset.model==='本地导入')return null;
  const link=asset.galleryImports?.at(-1);
  const busy=studio.galleryTasks.some(t=>t.items.some(i=>i.assetId===asset.id&&['queued','running'].includes(i.status)));
  return <span className="gallery-import-actions">
    <button className="button ghost small" disabled={busy} onClick={()=>studio.requestGalleryImport([asset.id])}><Upload/>{busy?'导入中':link?'再次导入…':'导入图库'}</button>
    {link&&<button className="button ghost small" title="在浏览器中打开图库帖子" onClick={()=>void studio.openGalleryPost(link.postUrl).catch(studio.report)}>已导入<ArrowUpRight/></button>}
  </span>;
}
