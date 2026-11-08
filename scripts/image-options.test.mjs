import test from 'node:test';
import assert from 'node:assert/strict';
import { flexibleSizes, standardSizes, extendedSizes, validateImageSize } from '../src/imageOptions.ts';

test('GPT Image 2.6 keeps extended sizes and custom dimensions across model variants', () => {
  for (const model of ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.6', 'gpt-image-2.6-sunburst', 'openai/gpt-image-2.6-flare', 'GPT-IMAGE-2.6-SUNBURST']) {
    assert.equal(flexibleSizes(model), true, model);
    for (const { value } of [...standardSizes, ...extendedSizes]) assert.equal(validateImageSize(value, model), null, `${model}: ${value}`);
    assert.equal(validateImageSize('1600x1024', model), null);
  }
});

test('GPT Image 2.6 still rejects invalid sizes and legacy models retain their limits', () => {
  for (const size of ['3840x3840', '512x512', '1025x1024', '4096x2048', '400x2000']) assert.ok(validateImageSize(size, 'gpt-image-2.6-flare'), size);
  for (const model of ['gpt-image-1.5', 'gpt-image-1-mini', 'unrelated-model']) {
    assert.equal(flexibleSizes(model), false, model);
    assert.ok(validateImageSize('1536x864', model));
    assert.equal(validateImageSize('1024x1024', model), null);
  }
});
