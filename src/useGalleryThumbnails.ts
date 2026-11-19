import { useEffect, useState, type RefObject } from 'react';
import type { Asset, StudioDocument } from './types';

const batchSize = 4;
const rasterMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function missingThumbnailKey(asset: Asset) {
  return !asset.demo && !asset.thumbnailPath && rasterMimes.has(asset.mime) && /^assets[\\/]/.test(asset.path)
    ? JSON.stringify([asset.id, asset.path])
    : undefined;
}

export function useGalleryThumbnails(
  panelRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  prepare: (ids: string[]) => Promise<StudioDocument>,
) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const panel = panelRef.current;
    if (!enabled || !panel) return;

    const observed = new Set<HTMLElement>();
    const visible = new Set<HTMLElement>();
    const attempted = new Set<string>();
    let active = true;
    let busy = false;
    let timer: number | undefined;

    function schedule() {
      if (!active || busy || timer !== undefined) return;
      timer = window.setTimeout(() => { timer = undefined; void load(); }, 0);
    }

    async function load() {
      const batch = [];
      for (const node of visible) {
        const { thumbnailId: id, thumbnailKey: key } = node.dataset;
        if (!id || !key || attempted.has(key)) continue;
        batch.push({ id, key });
        attempted.add(key);
        if (batch.length === batchSize) break;
      }
      if (!batch.length) return;
      busy = true;
      let unavailable = batch;
      try {
        const document = await prepare(batch.map(item => item.id));
        const available = new Set(document.assets.filter(asset => asset.thumbnailPath)
          .map(asset => JSON.stringify([asset.id, asset.path])));
        unavailable = batch.filter(item => !available.has(item.key));
      } catch {
        // A preview failure still allows the existing full-size image path.
      } finally {
        if (active && unavailable.length) {
          setFailed(previous => new Set([...previous, ...unavailable.map(item => item.key)]));
        }
        busy = false;
        schedule();
      }
    }

    const intersection = new IntersectionObserver(entries => {
      for (const { target, isIntersecting } of entries) {
        const node = target as HTMLElement;
        if (isIntersecting && observed.has(node)) visible.add(node);
        else visible.delete(node);
      }
      schedule();
    }, { root: panel, rootMargin: '140px 0px' });

    const observeCards = () => {
      const cards = new Set(panel.querySelectorAll<HTMLElement>('[data-thumbnail-id]'));
      for (const node of observed) {
        if (cards.has(node)) continue;
        intersection.unobserve(node);
        observed.delete(node);
        visible.delete(node);
      }
      for (const node of cards) {
        if (observed.has(node)) continue;
        observed.add(node);
        intersection.observe(node);
      }
      schedule();
    };

    const mutations = new MutationObserver(observeCards);
    mutations.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-thumbnail-key'] });
    observeCards();
    return () => {
      active = false;
      window.clearTimeout(timer);
      mutations.disconnect();
      intersection.disconnect();
    };
  }, [enabled, panelRef, prepare]);
  return failed;
}
