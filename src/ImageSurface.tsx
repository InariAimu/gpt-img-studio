import { useState, type CSSProperties } from 'react';

/** Keep the checkerboard on the image rectangle, including when contain leaves gutters. */
export default function ImageSurface({ src, alt, width, height, noUpscale = false, loading = 'lazy' }: {
  src: string; alt: string; width: number; height: number;
  noUpscale?: boolean; loading?: 'lazy' | 'eager';
}) {
  const [loaded, setLoaded] = useState<{ src: string; width: number; height: number } | null>(null);
  const ready = loaded?.src === src;
  const imageWidth = ready ? loaded.width : width;
  const imageHeight = ready ? loaded.height : height;
  const ratio = imageWidth > 0 && imageHeight > 0 ? imageWidth / imageHeight : 1;
  return <span className="image-surface" style={{ '--image-ratio': ratio } as CSSProperties}>
    <img className="image-checkerboard" src={src} alt={alt} loading={loading} draggable={false} data-loaded={ready}
      style={noUpscale ? { maxWidth: width > 0 ? width : undefined, maxHeight: height > 0 ? height : undefined } : undefined}
      onLoad={event => setLoaded({ src, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
      onError={() => setLoaded(null)} />
  </span>;
}
