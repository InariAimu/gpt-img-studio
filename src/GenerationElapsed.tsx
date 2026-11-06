import { useEffect, useState } from 'react';
import type { Job } from './types';

export function preparingGeneratedImage(job: Job, startedAt?: number) {
  return job.status === 'completed' && startedAt !== undefined && job.displayElapsedMs == null;
}

function formatElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes >= 60 ? `${Math.floor(minutes / 60)}:` : ''}${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export default function GenerationElapsed({ job, startedAt }: { job?: Job; startedAt?: number }) {
  const active = !!job && (job.status === 'running' || preparingGeneratedImage(job, startedAt));
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, job?.id]);
  if (!job) return null;
  const start = startedAt ?? Date.parse(job.createdAt);
  const measured = job.displayElapsedMs != null;
  const elapsed = active ? now - start : job.displayElapsedMs ?? Date.parse(job.finishedAt || '') - Date.parse(job.createdAt);
  if (!Number.isFinite(elapsed)) return null;
  const label = active ? '已用' : measured ? '总耗时' : job.status === 'completed' ? '生成耗时' : '耗时';
  const hint = measured || active ? '从提交 Prompt 到图片加载完成；后台生成计至图片可显示，不包含之后回看的等待时间。' : '历史记录仅包含生成与本地保存耗时，未记录图片加载显示时间。';
  return <span className="generation-elapsed" title={hint}> · {label} {formatElapsed(elapsed)}</span>;
}

export async function waitForGeneratedImages(urls: string[]) {
  if (!urls.length || urls.some(url => !url)) throw new Error('生成结果的图片路径不可用');
  await Promise.all(urls.map(async url => {
    const image = new Image();
    image.src = url;
    await image.decode();
  }));
  // Give the visible result a paint opportunity. Hidden windows must not wait for focus.
  if (document.visibilityState === 'visible') {
    await new Promise<void>(resolve => {
      let frame = 0;
      const finish = () => { window.clearTimeout(timeout); cancelAnimationFrame(frame); resolve(); };
      const timeout = window.setTimeout(finish, 100);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish); });
    });
  }
}
