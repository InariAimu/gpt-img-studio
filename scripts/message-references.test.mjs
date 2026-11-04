import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { messageReferences } from '../src/messageReferences.ts';

const {assets}=JSON.parse(readFileSync(new URL('../src/data/seed.json',import.meta.url),'utf8'));
test('reference previews preserve submitted order rather than library order',()=>{
  const ids=['demo-botanic','demo-fox-v1'];
  assert.deepEqual(messageReferences(assets,ids).map(asset=>asset.id),ids);
});
test('missing and duplicate references never expand the preview to unrelated images',()=>{
  const ids=['missing','demo-botanic','demo-botanic','demo-fox-v1'];
  assert.deepEqual(messageReferences(assets,ids).map(asset=>asset.id),['demo-botanic','demo-fox-v1']);
  assert.deepEqual(messageReferences(assets,['missing']),[]);
  assert.deepEqual(messageReferences(assets,[]),[]);
});
test('preview lookup keeps historical IDs and source assets unchanged',()=>{
  const ids=['demo-fox-v1'];const before=JSON.stringify(assets);
  assert.equal(messageReferences(assets,ids)[0],assets.find(asset=>asset.id==='demo-fox-v1'));
  assert.deepEqual(ids,['demo-fox-v1']);assert.equal(JSON.stringify(assets),before);
});
