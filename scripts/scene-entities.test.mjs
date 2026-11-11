import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { bodyDefaults, duplicateEntity, entityDefaults, initialSketch, removeEntity, validateSketch } from '../src/sketch/model.ts';
import { jointLimits, mirrorPose } from '../src/sketch/rig.ts';
import { posePresets, applyPreset } from '../src/sketch/poses.ts';
import { Humanoid } from '../src/sketch/Humanoid.ts';

test('entity copies own their pose and shape; removal respects locks and detaches seat references',()=>{
  const figure=entityDefaults('figure'),copy=duplicateEntity(figure),box=entityDefaults('box');
  copy.pose.leftElbow[0]=-90;copy.body.height=200;
  assert.equal(figure.pose.leftElbow[0],0);assert.equal(figure.body.height,175);assert.notEqual(figure.id,copy.id);
  const scene=initialSketch().layers[0].scene;scene.entities=[{...figure,support:'seat',supportId:box.id},copy,box];
  const after=removeEntity(scene,box.id);assert.equal(after.entities.length,2);assert.equal(after.entities[0].supportId,undefined);
  copy.locked=true;assert.equal(removeEntity(scene,copy.id),scene);
  const a=new Humanoid(figure.body),b=new Humanoid(copy.body);
  try{a.setPose(figure.pose);b.setPose(copy.pose);a.highlight('leftElbow');assert.notEqual(a.mesh.geometry,b.mesh.geometry);assert.notEqual(a.skeleton,b.skeleton);assert.equal(b.mesh.geometry.getAttribute('color').getY(0),1);}finally{a.dispose();b.dispose();}
});

test('72 categorized poses and mirrors obey all joint ranges; imported impossible joints fail',()=>{
  assert.equal(posePresets.length,72);assert.equal(new Set(posePresets.map(p=>p.id)).size,72);
  for(const category of ['日常','运动','军事'])assert.ok(posePresets.filter(p=>p.category===category).length>=18);
  for(const p of posePresets){
    const d=initialSketch();d.layers[0].scene.entities=[applyPreset(entityDefaults('figure'),p)];validateSketch(d);
    assert.deepEqual(mirrorPose(mirrorPose(p.pose)),p.pose);
    for(const [j,r] of Object.entries(p.pose))r.forEach((v,i)=>assert.ok(v>=jointLimits[j][0][i]&&v<=jointLimits[j][1][i],`${p.name}/${j}/${i}`));
  }
  const d=initialSketch();d.layers[0].scene.entities[0].pose.leftKnee[0]=-20;assert.throws(()=>validateSketch(d));
  const duplicate=initialSketch();duplicate.layers[0].scene.entities.push(structuredClone(duplicate.layers[0].scene.entities[0]));assert.throws(()=>validateSketch(duplicate));
});

test('grounded poses contact the floor for short and tall bodies, including horizontal roots',()=>{
  const h=new Humanoid(bodyDefaults()),v=new Vector3();
  try{
    for(const height of [140,210])for(const p of posePresets.filter(p=>p.support==='ground')){
      h.setBody({...bodyDefaults(),height,arms:height===140?80:120,legs:height===140?120:85});h.setPose(p.pose);
      h.position.set(0,0,0);h.rotation.set(...p.rotation.map(v=>v*Math.PI/180));h.scale.setScalar(1);h.updateMatrixWorld(true);
      const offset=h.supportOffset();h.position.y=offset;h.updateMatrixWorld(true);h.updateBounds();
      let min=Infinity;for(let i=0;i<h.mesh.geometry.getAttribute('position').count;i++){h.mesh.getVertexPosition(i,v);h.mesh.localToWorld(v);min=Math.min(min,v.y);}
      assert.ok(Math.abs(min)<1e-5,`${p.name}/${height}: ${min}`);
      assert.ok(Number.isFinite(h.mesh.boundingSphere.radius));
    }
  }finally{h.dispose();}
});

test('IK targets reduce endpoint error without bypassing hinge constraints and can be released',()=>{
  const h=new Humanoid(bodyDefaults());
  try{
    const p=posePresets.find(p=>p.id==='drive');h.setPose(p.pose);h.updateMatrixWorld(true);
    const target=new Vector3(...p.contacts[0].target),before=h.pivots.leftWrist.getWorldPosition(new Vector3()).distanceTo(target);
    h.solveContacts(p.contacts);const after=h.pivots.leftWrist.getWorldPosition(new Vector3()).distanceTo(target);
    assert.ok(after<before,`${after} < ${before}`);
    const resolved=h.readPose();for(const j of ['leftElbow','rightElbow']){assert.ok(resolved[j][0]>=-150&&resolved[j][0]<=0);assert.ok(Math.abs(resolved[j][1])<1e-6);assert.ok(Math.abs(resolved[j][2])<1e-6);}
    h.setPose(p.pose);h.updateMatrixWorld(true);assert.ok(Math.abs(h.pivots.leftWrist.getWorldPosition(new Vector3()).distanceTo(target)-before)<1e-6);
  }finally{h.dispose();}
});
