import * as T from 'three';
import asset from './assets/humanoid.json' with { type: 'json' };
import type { BodyShape, Joint, Rotation } from './model';

const rest = asset.joints.reduce<T.Vector3[]>((list, _, i) => {
  if (i % 3 === 0) list.push(new T.Vector3().fromArray(asset.joints, i));
  return list;
}, []);
const jointNames = asset.bones as ('pelvis' | Joint)[];
const jointOf = (bone: number): Joint => jointNames[bone] === 'pelvis' ? 'torso' : jointNames[bone] as Joint;

/** Continuous CC0 human surface, fitted and rebound before applying the stored pose. */
export class Humanoid extends T.Group {
  readonly pivots = {} as Record<Joint, T.Bone>;
  readonly mesh: T.SkinnedMesh<T.BufferGeometry, T.MeshStandardMaterial>;
  readonly skeleton: T.Skeleton;
  groundOffset = 1.06;
  private shapeKey = '';
  private poseKey = '';
  private highlightKey = '';
  private boundsDirty = true;

  constructor(body: BodyShape) {
    super();
    const geometry = new T.BufferGeometry();
    geometry.setAttribute('position', new T.Float32BufferAttribute(asset.positions, 3));
    geometry.setAttribute('skinIndex', new T.Uint16BufferAttribute(asset.skinIndices, 4));
    geometry.setAttribute('skinWeight', new T.Float32BufferAttribute(asset.skinWeights, 4));
    geometry.setAttribute('color', new T.Float32BufferAttribute(new Float32Array(asset.positions.length).fill(1), 3));
    geometry.setIndex(asset.indices);
    this.mesh = new T.SkinnedMesh(geometry, new T.MeshStandardMaterial({color:'#e4e5e7',roughness:.82,vertexColors:true}));
    this.mesh.name = 'Continuous humanoid';
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.mesh.normalizeSkinWeights();
    const bones = jointNames.map(name => {const bone = new T.Bone();bone.name = name;return bone;});
    bones.forEach((bone, i) => {
      (asset.parents[i] < 0 ? this : bones[asset.parents[i]]).add(bone);
      if (i > 0) {this.pivots[jointOf(i)] = bone;bone.userData.joint = jointOf(i);}
    });
    this.skeleton = new T.Skeleton(bones, bones.map(() => new T.Matrix4()));
    this.add(this.mesh);
    this.mesh.bind(this.skeleton, new T.Matrix4());
    this.setBody(body);
  }

  setBody(body: BodyShape) {
    const key = JSON.stringify(body);
    if (key === this.shapeKey) return;
    this.shapeKey = key;
    const shoulder = body.shoulders / 100, hip = body.hips / 100, arm = body.arms / 100;
    const leg = body.legs / 100, head = body.head / 100, fat = body.weight / 50;
    const centers = rest.map(v => v.clone());
    for (const [upper, lower] of [[3,4],[5,6]]) {
      centers[upper].x *= shoulder;
      centers[lower].copy(rest[lower]).sub(rest[upper]).multiplyScalar(arm).add(centers[upper]);
    }
    for (const [upper, lower] of [[7,8],[9,10]]) {
      centers[upper].x *= hip;
      centers[lower].copy(rest[lower]).sub(rest[upper]);
      centers[lower].y *= leg;
      centers[lower].add(centers[upper]);
    }
    const waistY = rest[1].y + .10, chestY = rest[3].y;
    const bodyWidth = (y: number) => y < waistY
      ? T.MathUtils.lerp(hip, body.waist / 100, T.MathUtils.smoothstep(y, -.04, waistY))
      : T.MathUtils.lerp(body.waist / 100, shoulder, T.MathUtils.smoothstep(y, waistY, chestY));
    const position = this.mesh.geometry.getAttribute('position') as T.BufferAttribute;
    const skinIndex = this.mesh.geometry.getAttribute('skinIndex'), skinWeight = this.mesh.geometry.getAttribute('skinWeight');
    const source = new T.Vector3(), local = new T.Vector3(), fitted = new T.Vector3();
    let minY = Infinity, maxY = -Infinity;
    // Blend local shape transforms with the same smooth weights as the skin.
    // Joint centers receive the identical limb length changes, so elbows/knees
    // stay inside the surface even when shape is edited while already posing.
    for (let vertex = 0; vertex < position.count; vertex++) {
      source.fromArray(asset.positions, vertex * 3);fitted.set(0,0,0);
      for (let slot = 0; slot < 4; slot++) {
        const bone = skinIndex.getComponent(vertex,slot), weight = skinWeight.getComponent(vertex,slot);
        if (!weight) continue;
        local.copy(source).sub(rest[bone]);
        if (bone === 2) local.multiplyScalar(head);
        else if (bone >= 3) {
          local.x *= 1 + fat * .16;local.z *= 1 + fat * .22;
          local.y *= bone < 7 ? arm : leg;
        } else {
          local.x *= bodyWidth(source.y) * (1 + fat * .13);
          local.z *= 1 + fat * .24;
        }
        fitted.addScaledVector(local.add(centers[bone]), weight);
      }
      position.setXYZ(vertex, fitted.x, fitted.y, fitted.z);
      minY = Math.min(minY, fitted.y);maxY = Math.max(maxY, fitted.y);
    }
    // Preserve the requested total height while the relative proportions change.
    const scale = 2.1 * (body.height / 175) / (maxY - minY);
    for (let vertex = 0; vertex < position.count; vertex++) {
      source.fromBufferAttribute(position, vertex).multiplyScalar(scale);position.setXYZ(vertex,source.x,source.y,source.z);
    }
    centers.forEach((center, i) => {
      center.multiplyScalar(scale);
      const parent = asset.parents[i];
      this.skeleton.bones[i].position.copy(center).sub(parent < 0 ? new T.Vector3() : centers[parent]);
      // Model-space bind matrices are independent of figure translation/yaw/scale.
      this.skeleton.boneInverses[i].makeTranslation(-center.x,-center.y,-center.z);
    });
    this.groundOffset = -minY * scale;
    position.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingBox();this.mesh.geometry.computeBoundingSphere();
    this.boundsDirty = true;
  }

  setPose(pose: Record<Joint, Rotation>) {
    const key = JSON.stringify(pose);
    if (key === this.poseKey) return;
    this.poseKey = key;
    for (const [joint, bone] of Object.entries(this.pivots)) bone.rotation.set(...pose[joint as Joint].map(T.MathUtils.degToRad) as Rotation);
    this.boundsDirty = true;
  }

  updateBounds() {
    if (!this.boundsDirty) return;
    this.mesh.computeBoundingSphere();this.mesh.computeBoundingBox();
    this.boundsDirty = false;
  }

  /** Determine the body part at the actual deformed triangle, not a proxy volume. */
  pickJoint(hit: T.Intersection): Joint {
    if (!hit.face) return 'torso';
    const vertices = [hit.face.a,hit.face.b,hit.face.c];
    const points = vertices.map(index => this.mesh.getVertexPosition(index,new T.Vector3()));
    const bary = new T.Triangle(...points as [T.Vector3,T.Vector3,T.Vector3]).getBarycoord(this.mesh.worldToLocal(hit.point.clone()),new T.Vector3());
    const blend = bary?.toArray() ?? [1/3,1/3,1/3], scores = new Float32Array(jointNames.length);
    const indices = this.mesh.geometry.getAttribute('skinIndex'), weights = this.mesh.geometry.getAttribute('skinWeight');
    vertices.forEach((vertex,i) => {
      for (let slot = 0; slot < 4; slot++) {
        const bone = indices.getComponent(vertex,slot);
        scores[bone === 0 ? 1 : bone] += Math.max(0,blend[i]) * weights.getComponent(vertex,slot);
      }
    });
    return jointOf(scores.indexOf(Math.max(...scores)));
  }

  highlight(joint: Joint | 'all' | null) {
    const key = joint ?? '';
    if (key === this.highlightKey) return;
    this.highlightKey = key;
    const color = this.mesh.geometry.getAttribute('color') as T.BufferAttribute;
    const indices = this.mesh.geometry.getAttribute('skinIndex'), weights = this.mesh.geometry.getAttribute('skinWeight');
    for (let vertex = 0; vertex < color.count; vertex++) {
      let amount = joint === 'all' ? 1 : 0;
      if (joint && joint !== 'all') for (let slot = 0; slot < 4; slot++) {
        if (jointOf(indices.getComponent(vertex,slot)) === joint) amount += weights.getComponent(vertex,slot);
      }
      color.setXYZ(vertex, 1, 1 - amount * .56, 1 - amount * .43);
    }
    color.needsUpdate = true;
  }

  dispose() {
    this.skeleton.dispose();this.mesh.geometry.dispose();this.mesh.material.dispose();
  }
}
