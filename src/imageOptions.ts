// OpenAI image-generation guide, checked 2026-11-03:
// https://developers.openai.com/api/docs/guides/image-generation#customize-image-output
export const standardSizes = [
  { value: 'auto', label: '自动尺寸' },
  { value: '1024x1024', label: '方图 1:1 · 1024 × 1024' },
  { value: '1536x1024', label: '横图 3:2 · 1536 × 1024' },
  { value: '1024x1536', label: '竖图 2:3 · 1024 × 1536' },
];
export const extendedSizes = [
  { value: '1536x864', label: '宽屏 16:9 · 1536 × 864' },
  { value: '864x1536', label: '竖屏 9:16 · 864 × 1536' },
  { value: '2048x2048', label: '2K 方图 · 2048 × 2048' },
  { value: '2048x1152', label: '2K 横图 · 2048 × 1152' },
  { value: '3840x2160', label: '4K 横图 · 3840 × 2160（实验性）' },
  { value: '2160x3840', label: '4K 竖图 · 2160 × 3840（实验性）' },
];
export const qualityOptions = [
  { value: 'auto', label: '自动质量' }, { value: 'low', label: '低' },
  { value: 'medium', label: '标准' }, { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' }, { value: 'max', label: '最高' },
];
export function flexibleSizes(model: string) { return /(?:^|\/)gpt-image-2(?:\.|-|$)/i.test(model); }
export function availableQualities(model: string) { return /(?:^|\/)gpt-image-2\.5(?:-|$)/i.test(model) ? qualityOptions : qualityOptions.slice(0, 4); }
export function validateImageSize(size: string, model: string): string | null {
  if (standardSizes.some(option => option.value === size)) return null;
  if (!flexibleSizes(model)) return '此模型仅提供自动、方图、横图和竖图尺寸。';
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return '请填写有效的宽度和高度。';
  const width = Number(match[1]), height = Number(match[2]);
  if (!width || !height || width % 16 || height % 16) return '宽度和高度必须是 16 的倍数。';
  if (width > 3840 || height > 3840) return '任意边不能超过 3840 像素。';
  if (Math.max(width, height) > Math.min(width, height) * 3) return '长边与短边之比不能超过 3:1。';
  if (width * height < 655360 || width * height > 8294400) return '总像素数必须介于 655,360 与 8,294,400 之间。';
  return null;
}
export function sizeCaption(size: string) { return size === 'auto' ? '自动尺寸' : size.replace('x', ' × '); }
