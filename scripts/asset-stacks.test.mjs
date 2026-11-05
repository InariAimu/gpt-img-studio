import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assetStackKey, stackAssets } from '../src/assetStacks.ts';

const sample = JSON.parse(readFileSync(new URL('../src/data/seed.json', import.meta.url), 'utf8')).assets[0];
const image = (id, sessionId, day, extra = {}) => ({
  ...sample, id, sessionId, createdAt: `2026-11-${String(day).padStart(2, '0')}T12:00:00+08:00`,
  groupId: 'legacy-parent-group', demo: false, ...extra,
});

test('legacy parent, derived, and nested derived sessions have independent stacks and counts', () => {
  const assets = [
    image('parent-old', 'parent', 1),
    image('derived-new', 'derived', 4, { parentAssetId: 'parent-new' }),
    image('nested', 'nested', 5, { parentAssetId: 'derived-new' }),
    image('parent-new', 'parent', 3),
    image('derived-old', 'derived', 2, { parentAssetId: 'parent-new' }),
  ];
  const before = JSON.stringify(assets);
  const stacks = stackAssets(assets);
  assert.deepEqual(stacks.map(a => a.id), ['nested', 'derived-new', 'parent-new']);
  assert.deepEqual(stacks.map(cover => assets.filter(a => assetStackKey(a) === assetStackKey(cover)).length), [1, 2, 2]);
  assert.equal(JSON.stringify(assets), before);
});

test('legacy and newly generated images in the same derived session remain together', () => {
  const older = image('legacy', 'derived', 1);
  const newer = image('new', 'derived', 2, { groupId: 'derived' });
  assert.deepEqual(stackAssets([older, newer]).map(a => a.id), ['new']);
  assert.deepEqual(stackAssets([newer, older]).map(a => a.id), ['new']);
});

test('imports, reference copies, and images without sessions do not join a session stack', () => {
  const assets = [
    image('generated', 'session', 1),
    image('imported', 'session', 2, { model: '本地导入' }),
    image('copy', 'session', 3, { referenceOnly: true }),
    image('unassigned-one', '', 4),
    image('unassigned-two', '', 5),
    image('same-file-other-session', 'other-session', 6),
  ];
  assert.equal(stackAssets(assets).length, assets.length);
});
