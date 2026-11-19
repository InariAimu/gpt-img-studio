import test from 'node:test';
import assert from 'node:assert/strict';
import { invalidModelAssignments, modelsForRole, textModel } from '../src/modelProviders.ts';
import { SettingsWrites } from '../src/settingsWrites.ts';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('serializes rapid changes and keeps the newest visible settings until saved', async () => {
  const first = deferred(), writes = [], applied = [], busy = [];
  const queue = new SettingsWrites({
    save: async value => { writes.push(value); return writes.length === 1 ? first.promise : value; },
    changed() {}, saved: (value, optimistic) => applied.push(optimistic ?? value), failed() {}, busy: value => busy.push(value),
  });
  const a = queue.enqueue({ theme: 'dark' });
  const b = queue.enqueue({ theme: 'light' });
  await Promise.resolve();
  assert.deepEqual(writes, [{ theme: 'dark' }]);
  first.resolve({ theme: 'dark' });
  await Promise.all([a, b]);
  assert.deepEqual(writes, [{ theme: 'dark' }, { theme: 'light' }]);
  assert.deepEqual(applied, [{ theme: 'light' }, { theme: 'light' }]);
  assert.equal(queue.optimistic, undefined);
  assert.equal(busy.at(-1), false);
});

test('an older failure does not discard a newer edit or stop later writes', async () => {
  const first = deferred(), failures = [];
  let count = 0;
  const queue = new SettingsWrites({ save: async value => ++count === 1 ? first.promise : value, changed() {}, saved() {}, failed: (_, optimistic) => failures.push(optimistic), busy() {} });
  const a = queue.enqueue('invalid');
  const rejected = assert.rejects(a, /invalid/);
  const b = queue.enqueue('valid');
  first.reject(new Error('invalid'));
  await Promise.all([rejected, b]);
  assert.deepEqual(failures, ['valid']);
  assert.equal(await queue.enqueue('next'), 'next');
});

test('a latest failure clears optimism and allows rollback and retry', async () => {
  const failures = [];
  const queue = new SettingsWrites({ save: async () => { throw new Error('disk error'); }, changed() {}, saved() {}, failed: (_, optimistic) => failures.push(optimistic), busy() {} });
  await assert.rejects(queue.enqueue('edit'), /disk error/);
  assert.deepEqual(failures, [undefined]);
  assert.equal(queue.optimistic, undefined);
  await queue.idle();
});

test('credential writes retain the endpoint snapshot and finish after navigation', async () => {
  const seen = [], first = deferred();
  const queue = new SettingsWrites({ save: async (settings, keys) => { seen.push({ settings, keys }); if (seen.length === 1) await first.promise; return settings; }, changed() {}, saved() {}, failed() {}, busy() {} });
  const a = queue.enqueue({ endpoint: 'first' }, { provider: 'test-only-key' });
  const b = queue.enqueue({ endpoint: 'second' });
  first.resolve();
  await queue.idle();
  await Promise.all([a, b]);
  assert.deepEqual(seen, [{ settings: { endpoint: 'first' }, keys: { provider: 'test-only-key' } }, { settings: { endpoint: 'second' }, keys: {} }]);
});

test('default model repair requires all invalid assignments to be replaced', () => {
  const image = { providerId: 'image-provider', modelId: 'image' };
  const missing = { providerId: 'image-provider', modelId: 'removed-text' };
  const replacement = { providerId: 'image-provider', modelId: 'responses-text' };
  const chat = { providerId: 'text-provider', modelId: 'chat-text' };
  const settings = {
    generation: { apiMode: 'responses' },
    providers: [
      { id: image.providerId, models: [{ ...textModel(image.modelId), kind: 'image' }, textModel(replacement.modelId)] },
      { id: chat.providerId, models: [textModel(chat.modelId, 'chat_completions')] },
    ],
    modelAssignments: { image, imageMain: missing, naming: missing, refine: missing },
  };

  assert.deepEqual(invalidModelAssignments(settings), ['imageMain', 'refine', 'naming']);
  settings.modelAssignments.naming = chat;
  settings.modelAssignments.refine = replacement;
  assert.deepEqual(invalidModelAssignments(settings), ['imageMain']);
  assert.deepEqual(modelsForRole(settings, settings.providers[1], 'imageMain'), []);
  settings.modelAssignments.imageMain = replacement;
  assert.deepEqual(invalidModelAssignments(settings), []);
  assert.equal(settings.modelAssignments.image, image);
});
