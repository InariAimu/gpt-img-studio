import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Box3, Raycaster, Vector3 } from 'three';
import { Humanoid } from '../src/sketch/Humanoid.ts';
import { bodyControls, bodyDefaults, initialSketch, pose, validateSketch } from '../src/sketch/model.ts';

const zeroPose = () => Object.fromEntries(Object.keys(pose()).map(key => [key,[0,0,0]]));
const update = human => {human.updateMatrixWorld(true);human.updateBounds();};
const vertices = human => Array.from({length:human.mesh.geometry.getAttribute('position').count},(_,i)=>human.mesh.getVertexPosition(i,new Vector3()));
const approx = (actual, expected, tolerance=1e-5) => assert.ok(Math.abs(actual-expected)<tolerance, `${actual} != ${expected}`);

test('old sketches retain their original rig and hidden objects; malformed body data is rejected', () => {
  const old=JSON.parse(fs.readFileSync(new URL('./fixtures/sketch-v1.json',import.meta.url)));
  const before=JSON.stringify(old),next=validateSketch(old);
  assert.equal(JSON.stringify(old),before);assert.equal(next.version,2);
  const s=next.layers[0].scene;
  assert.equal(s.entities.length,3);assert.equal(s.entities[2].visible,false);assert.equal(s.entities[0].modelVersion,1);
  for(const [joint,r] of Object.entries(old.layers[0].scene.figure.pose))assert.deepEqual(s.entities[0].pose[joint],r);
  for (const body of [null,{},[],{...bodyDefaults(),height:NaN},{...bodyDefaults(),arms:200}]) {
    const doc=initialSketch();doc.layers[0].scene.entities[0].body=body;assert.throws(()=>validateSketch(doc));
  }
  const future=initialSketch();future.layers[0].scene.entities[0].modelVersion=3;assert.throws(()=>validateSketch(future));
});

test('rest binding matches the continuous surface at parameter limits and under world transforms', () => {
  const human=new Humanoid(bodyDefaults());
  human.position.set(.6,1.7,-.4);human.rotation.set(.1,.7,-.2);human.scale.setScalar(1.6);
  const extremes = ['min','max'].map(limit=>Object.fromEntries(Object.entries(bodyControls).map(([key,control])=>[key,control[limit]])));
  try {
    for (const body of [bodyDefaults(),...extremes]) {
      human.setBody(body);human.setPose(zeroPose());update(human);
      const position=human.mesh.geometry.getAttribute('position');
      const posed=vertices(human),bounds=new Box3().setFromPoints(posed);
      approx(bounds.max.y-bounds.min.y,2.1*body.height/175);
      approx(bounds.min.y+human.groundOffset,0);
      posed.forEach((point,i)=>assert.ok(point.distanceTo(new Vector3().fromBufferAttribute(position,i))<1e-5));
      assert.ok(Number.isFinite(human.mesh.boundingSphere.radius));
      assert.equal(human.children.filter(child=>child.isSkinnedMesh).length,1);
    }
  } finally {human.dispose();}
});

test('body edits rebind joints without losing a bent pose; restoring parameters is exact', () => {
  const human=new Humanoid(bodyDefaults()), running=pose('跑步');
  try {
    human.setPose(running);update(human);const before=vertices(human);
    const initialLength=human.pivots.leftElbow.position.length()/human.pivots.head.position.length();
    human.setBody({...bodyDefaults(),arms:120,shoulders:125,legs:85,head:110});update(human);
    approx(human.pivots.leftElbow.position.length()/human.pivots.head.position.length(),initialLength*1.2);
    approx(human.pivots.leftElbow.rotation.x,running.leftElbow[0]*Math.PI/180);
    assert.ok(vertices(human).some((v,i)=>v.distanceTo(before[i])>.05));
    human.setBody(bodyDefaults());update(human);
    vertices(human).forEach((v,i)=>assert.ok(v.distanceTo(before[i])<1e-5));
  } finally {human.dispose();}
});

test('deformed triangle picking follows each limb and highlighting stays local', () => {
  const human=new Humanoid(bodyDefaults());
  try {
    human.setPose(pose('站立'));update(human);
    const ray=new Raycaster(), found=new Set();
    for(let x=-.7;x<=.7;x+=.04)for(let y=-.9;y<1.1;y+=.05){
      ray.set(new Vector3(x,y,3),new Vector3(0,0,-1));
      const hit=ray.intersectObject(human.mesh)[0];if(hit)found.add(human.pickJoint(hit));
    }
    for(const joint of ['head','torso','leftArm','leftElbow','rightArm','rightElbow','leftLeg','leftKnee','rightLeg','rightKnee']) assert.ok(found.has(joint),joint);
    human.highlight('leftElbow');const colors=human.mesh.geometry.getAttribute('color');
    let tinted=0,clear=0;for(let i=0;i<colors.count;i++){if(colors.getY(i)<.9)tinted++;if(colors.getY(i)===1)clear++;}
    assert.ok(tinted>0&&clear>tinted);
    human.highlight(null);for(let i=0;i<colors.count;i++)assert.equal(colors.getY(i),1);
  } finally {human.dispose();}
});
