import type { Asset } from './types';

export function assetStackKey(asset: Asset): string {
  return asset.sessionId && asset.model !== '本地导入' && !asset.referenceOnly
    ? `session:${asset.sessionId}`
    : `asset:${asset.id}`;
}

export function countAssetStacks(assets: readonly Asset[]) {
  const counts = new Map<string, number>();
  for (const asset of assets) {
    const key = assetStackKey(asset);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function stackAssets(assets: readonly Asset[]): Asset[] {
  const seen = new Set<string>();
  return [...assets]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .filter(asset => {
      const key = assetStackKey(asset);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
