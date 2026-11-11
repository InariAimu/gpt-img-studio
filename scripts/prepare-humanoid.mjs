// Rebuild the bundled CC0 mesh from pinned MakeHuman data; no generator code is copied.
// node scripts/prepare-humanoid.mjs [download-cache-directory]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Matrix4, Quaternion, Vector3 } from 'three';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = path.resolve(process.argv[2] ?? path.join(root, 'output/humanoid-source'));
const revision = 'a8bc2d54ff0ac92e78ff71431b1023eda42bf482';
const source = `https://raw.githubusercontent.com/makehumancommunity/makehuman/${revision}/`;
await fs.mkdir(cache, { recursive: true });
async function read(name, remote) {
  const file = path.join(cache, name);
  try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetch(source + remote);
  if (!response.ok) throw new Error(`${remote}: ${response.status}`);
  const text = await response.text();
  await fs.writeFile(file, text);
  return text;
}
const [obj, rigText, weightsText, license] = await Promise.all([
  read('base.obj', 'makehuman/data/3dobjs/base.obj'),
  read('default.mhskel', 'makehuman/data/rigs/default.mhskel'),
  read('weights.mhw', 'makehuman/data/rigs/default_weights.mhw'),
  read('LICENSE.ASSETS.md', 'LICENSE.ASSETS.md'),
]);
const rig = JSON.parse(rigText), weights = JSON.parse(weightsText);
if (rig.license !== 'CC0' || weights.license !== 'CC0') throw new Error('Unexpected asset license');
const vertices = [], faces = [];
let group = '';
for (const line of obj.split('\n')) {
  const [kind, ...values] = line.trim().split(/\s+/);
  if (kind === 'v') vertices.push(new Vector3(...values.map(Number)));
  if (kind === 'g') group = values[0];
  if (kind === 'f' && group === 'body') {
    const face = values.map(v => Number(v.split('/')[0]) - 1);
    for (let i = 1; i < face.length - 1; i++) faces.push(face[0], face[i], face[i + 1]);
  }
}
const joint = (bone, endpoint = 'head') => {
  const ids = [rig.joints[rig.bones[bone][endpoint]]].flat();
  return ids.reduce((sum, i) => sum.add(vertices[i]), new Vector3()).divideScalar(ids.length);
};
// Preserve the first eleven indices; add chest, neck, clavicles, wrists and ankles.
const names = ['pelvis', 'torso', 'head', 'leftArm', 'leftElbow', 'rightArm', 'rightElbow', 'leftLeg', 'leftKnee', 'rightLeg', 'rightKnee'];
const parents = [-1, 0, 1, 1, 3, 1, 5, 0, 7, 0, 9];
const origin = joint('spine05');
const centers = [origin.clone(), joint('spine04'), joint('neck01')];
const transforms = [new Matrix4(), new Matrix4(), new Matrix4()];
// Bake the source's bent A-pose into arms-down rest coordinates. User joint angles
// therefore keep their existing meaning (0 = relaxed, +X = bend backwards).
for (const side of ['L', 'R']) {
  const shoulder = joint(`upperarm01.${side}`), elbow = joint(`lowerarm01.${side}`), wrist = joint(`lowerarm02.${side}`, 'tail');
  const upperQ = new Quaternion().setFromUnitVectors(elbow.clone().sub(shoulder).normalize(), new Vector3(0, -1, 0));
  const lowerQ = new Quaternion().setFromUnitVectors(wrist.clone().sub(elbow).normalize(), new Vector3(0, -1, 0));
  const nextElbow = elbow.clone().sub(shoulder).applyQuaternion(upperQ).add(shoulder);
  const transform = (q, from, to) => new Matrix4().compose(to.clone().sub(from.clone().applyQuaternion(q)), q, new Vector3(1, 1, 1));
  centers.push(shoulder, nextElbow);
  transforms.push(transform(upperQ, shoulder, shoulder), transform(lowerQ, elbow, nextElbow));
}
for (const side of ['L', 'R']) {
  centers.push(joint(`upperleg01.${side}`), joint(`lowerleg01.${side}`));
  transforms.push(new Matrix4(), new Matrix4());
}
// Additional rest centers use the same baked arm transforms as their parents.
for (const [name, source, parent, transform] of [
  ['chest','spine02',1,null], ['neck','neck01',11,null],
  ['leftClavicle','clavicle.L',11,null], ['rightClavicle','clavicle.R',11,null],
  ['leftWrist','wrist.L',4,4], ['rightWrist','wrist.R',6,6],
  ['leftAnkle','foot.L',8,null], ['rightAnkle','foot.R',10,null],
]) {
  names.push(name);parents.push(parent);
  const matrix=transform===null?new Matrix4():transforms[transform].clone();
  centers.push(joint(source).applyMatrix4(matrix));transforms.push(matrix);
}
centers[2]=joint('head');
parents[2]=12; parents[3]=13; parents[5]=14;
function boneIndex(name) {
  const side = name.endsWith('.L') ? 'left' : 'right';
  if (name.startsWith('upperarm')) return names.indexOf(`${side}Arm`);
  if (/^(wrist|finger)/.test(name)) return names.indexOf(`${side}Wrist`);
  if (/^lowerarm/.test(name)) return names.indexOf(`${side}Elbow`);
  if (name.startsWith('upperleg')) return names.indexOf(`${side}Leg`);
  if (/^(foot|toe)/.test(name)) return names.indexOf(`${side}Ankle`);
  if (/^lowerleg/.test(name)) return names.indexOf(`${side}Knee`);
  if (/^head/.test(name)) return 2;
  if (/^neck/.test(name)) return 12;
  if (/^(clavicle|shoulder)/.test(name)) return names.indexOf(`${side}Clavicle`);
  if (/^(spine0[123]|breast)/.test(name)) return 11;
  if (/^(spine|breast|clavicle|shoulder)/.test(name)) return 1;
  if (/^(root|pelvis)/.test(name)) return 0;
  const parent = rig.bones[name]?.parent;
  if (!parent) throw new Error(`Unmapped skin bone: ${name}`);
  return boneIndex(parent);
}
const influences = vertices.map(() => new Map());
for (const [name, entries] of Object.entries(weights.weights)) {
  const bone = boneIndex(name);
  for (const [vertex, weight] of entries) influences[vertex].set(bone, (influences[vertex].get(bone) ?? 0) + weight);
}
const used = [...new Set(faces)].sort((a, b) => a - b), remap = new Map(used.map((id, i) => [id, i]));
const skinIndices = [], skinWeights = [], position = [];
for (const id of used) {
  const entries = [...influences[id]].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const total = entries.reduce((sum, entry) => sum + entry[1], 0);
  if (!total) throw new Error(`Unweighted vertex ${id}`);
  const v = new Vector3();
  for (let slot = 0; slot < 4; slot++) {
    const [index, raw] = entries[slot] ?? [0, 0], weight = raw / total;
    skinIndices.push(index); skinWeights.push(weight);
    v.addScaledVector(vertices[id].clone().applyMatrix4(transforms[index]), weight);
  }
  position.push(v.sub(origin));
}
const minY = Math.min(...position.map(v => v.y)), maxY = Math.max(...position.map(v => v.y));
const scale = 2.1 / (maxY - minY);
const round = value => Math.round(value * 100000) / 100000;
const asset = {
  version: 2,
  source: `https://github.com/makehumancommunity/makehuman/tree/${revision}`,
  bones: names,
  parents,
  joints: centers.flatMap(v => v.clone().sub(origin).multiplyScalar(scale).toArray().map(round)),
  positions: position.flatMap(v => v.multiplyScalar(scale).toArray().map(round)),
  indices: faces.map(id => remap.get(id)),
  skinIndices,
  skinWeights: skinWeights.map(round),
};
const destination = path.join(root, 'src/sketch/assets');
await fs.mkdir(destination, { recursive: true });
await fs.writeFile(path.join(destination, 'humanoid.json'), JSON.stringify(asset));
await fs.writeFile(path.join(destination, 'LICENSE-CC0.txt'), license);
console.log(`${used.length} vertices, ${faces.length / 3} triangles; ${JSON.stringify(asset).length} bytes`);
