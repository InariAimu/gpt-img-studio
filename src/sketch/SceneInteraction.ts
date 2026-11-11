import * as T from 'three';
import { updateEntity, limitRotation, jointAxis, type Joint, type SceneData, type SceneSelection, type Tool } from './model';
import { Humanoid } from './Humanoid.ts';

export interface SceneEditor { selection:SceneSelection|null; tool:Tool; axes:boolean; grid:boolean }
type Handle = 'x'|'y'|'z'|'free'|'rotate';
type Objects = Map<string,T.Mesh|Humanoid>;
export type SceneGesture = (point:T.Vector2, snap:boolean)=>SceneData;
const axes=[new T.Vector3(1,0,0),new T.Vector3(0,1,0),new T.Vector3(0,0,1)];
const colors=[0xf05b61,0x3ebc82,0x4999ff];
const clamp=T.MathUtils.clamp;
const radians=T.MathUtils.degToRad;
const degrees=T.MathUtils.radToDeg;
const wrap=(v:number)=>((v+180)%360+360)%360-180;

/** Ray picking and edit-only helpers share exactly the camera used by the rendered layer. */
export class SceneInteraction {
  readonly helpers=new T.Group();
  private gizmo=new T.Group();
  private moveGizmo=new T.Group();
  private ring=new T.Group();
  private grid=new T.GridHelper(10,20,0x87909e,0x9aa1ab);
  private originAxes=new T.AxesHelper(.65);
  private ray=new T.Raycaster();

  private editor:SceneEditor|null=null;
  private data:SceneData|null=null;
  constructor(scene:T.Scene,private camera:T.PerspectiveCamera,private objects:Objects){
    scene.add(this.helpers);this.helpers.add(this.grid,this.originAxes,this.gizmo);this.gizmo.add(this.moveGizmo,this.ring);
    this.grid.position.y=-.035;this.originAxes.position.y=.005;
    for(const m of [this.grid.material,this.originAxes.material].flat()){m.transparent=true;m.opacity=.45;m.depthWrite=false;}
    const addMesh=(parent:T.Group,g:T.BufferGeometry,color:number,handle:Handle)=>{
      const m=new T.Mesh(g,new T.MeshBasicMaterial({color,depthTest:false,depthWrite:false,transparent:true,opacity:.95}));
      m.userData.handle=handle;m.renderOrder=1000;parent.add(m);return m;
    };
    axes.forEach((axis,i)=>{
      const a=new T.Group();a.quaternion.setFromUnitVectors(axes[1],axis);this.moveGizmo.add(a);
      addMesh(a,new T.CylinderGeometry(.018,.018,.75,8),colors[i],(['x','y','z'] as const)[i]).position.y=.375;
      addMesh(a,new T.ConeGeometry(.065,.19,16),colors[i],(['x','y','z'] as const)[i]).position.y=.8;
      const label=document.createElement('canvas');label.width=64;label.height=64;const ctx=label.getContext('2d')!;
      ctx.font='bold 44px Arial';ctx.textAlign='center';ctx.textBaseline='middle';ctx.lineWidth=5;ctx.strokeStyle='#fff';ctx.strokeText('XYZ'[i],32,32);ctx.fillStyle=`#${colors[i].toString(16)}`;ctx.fillText('XYZ'[i],32,32);
      const sprite=new T.Sprite(new T.SpriteMaterial({map:new T.CanvasTexture(label),depthTest:false,depthWrite:false}));sprite.scale.setScalar(.25);sprite.position.copy(axis).multiplyScalar(1.05);sprite.renderOrder=1001;this.moveGizmo.add(sprite);
    });
    addMesh(this.moveGizmo,new T.BoxGeometry(.13,.13,.13),0xffc354,'free');
    addMesh(this.ring,new T.TorusGeometry(1,.027,8,96),0xffb74d,'rotate');
    const disk=addMesh(this.ring,new T.CircleGeometry(1,64),0xffb74d,'rotate');delete disk.userData.handle;(disk.material as T.MeshBasicMaterial).opacity=.07;(disk.material as T.MeshBasicMaterial).side=T.DoubleSide;
    for(let i=0;i<12;i++){
      const tick=addMesh(this.ring,new T.BoxGeometry(.035,.12,.01),0xffb74d,'rotate');const angle=i*Math.PI/6;tick.position.set(Math.sin(angle)*.94,Math.cos(angle)*.94,0);tick.rotation.z=-angle;
    }
  }
  private rayAt(point:T.Vector2){this.ray.setFromCamera(point,this.camera);return this.ray.ray;}
  private partOf(object:T.Object3D):SceneSelection|null {
    for(let o:T.Object3D|null=object;o;o=o.parent)if(o.userData.entityId)return {entityId:o.userData.entityId};
    return null;
  }
  pick(point:T.Vector2):SceneSelection|null {
    this.rayAt(point);
    const hits=this.ray.intersectObjects([...this.objects.values()].filter(o=>o.visible&&!o.userData.locked),true);
    if(!hits.length)return null;
    const selection=this.partOf(hits[0].object);if(!selection)return null;
    const object=this.objects.get(selection.entityId);
    if(object instanceof Humanoid)selection.joint=object.pickJoint(hits[0]);
    return selection;
  }
  pickHandle(point:T.Vector2):Handle|null {
    if(!this.gizmo.visible||!this.helpers.visible)return null;this.rayAt(point);
    const root=this.ring.visible?this.ring:this.moveGizmo;
    return this.ray.intersectObjects(root.children,true).find(h=>h.object.userData.handle)?.object.userData.handle??null;
  }
  private object(selection:SceneSelection,rotation=false){
    const root=this.objects.get(selection.entityId)!;
    return rotation&&root instanceof Humanoid&&selection.joint?root.pivots[selection.joint]??root:root;
  }
  private frame(selection:SceneSelection,index:0|1|2){
    const object=this.object(selection,true),q=object.parent!.getWorldQuaternion(new T.Quaternion());
    // Euler XYZ: the axes for Y and Z include the earlier Euler rotations.
    if(index>0)q.multiply(new T.Quaternion().setFromAxisAngle(axes[0],object.rotation.x));
    if(index===2)q.multiply(new T.Quaternion().setFromAxisAngle(axes[1],object.rotation.y));
    return {origin:object.getWorldPosition(new T.Vector3()),axis:axes[index].clone().applyQuaternion(q).normalize()};
  }
  update(data:SceneData,editor:SceneEditor|null){
    this.data=data;this.editor=editor;this.helpers.visible=!!editor;
    for(const [id,object] of this.objects){
      const selected=editor?.selection?.entityId===id&&object.visible&&!object.userData.locked;
      if(object instanceof Humanoid)object.highlight(selected?(jointAxis(editor!.tool)!==null?editor!.selection!.joint??'all':'all'):null);
      else (object.material as T.MeshStandardMaterial).emissive.set(selected?0x55202a:0);
    }
    this.gizmo.visible=false;
    if(!editor)return;
    this.grid.visible=editor.grid;this.originAxes.visible=editor.axes;
    const selection=editor.selection,index=jointAxis(editor.tool),rotating=index!==null;
    const e=data.entities.find(e=>e.id===selection?.entityId);
    if(!selection||!e?.visible||e.locked||!this.objects.has(e.id)||editor.tool==='orbit')return;
    this.gizmo.visible=true;
    const origin=this.object(selection,rotating).getWorldPosition(new T.Vector3());this.gizmo.position.copy(origin);
    const size=clamp(this.camera.position.distanceTo(origin)*Math.tan(radians(this.camera.fov/2))*.32,.2,1.2);
    this.gizmo.scale.setScalar(size);this.moveGizmo.visible=!rotating;this.ring.visible=rotating;
    if(rotating)this.ring.quaternion.setFromUnitVectors(axes[2],this.frame(selection,index).axis);
    this.helpers.updateMatrixWorld(true);
  }
  /** A gesture stores its starting pose. React renders never reset its drag baseline. */
  begin(selection:SceneSelection,tool:Tool,point:T.Vector2,handle:Handle|null):SceneGesture|null {
    if(!this.data)return null;
    const base=this.data,start=point.clone(),index=jointAxis(tool),entity=base.entities.find(e=>e.id===selection.entityId);
    if(!entity||entity.locked||!this.objects.has(entity.id))return null;
    const humanoid=this.objects.get(entity.id);
    const displayedPose=entity.kind==='figure'&&entity.contacts.length&&humanoid instanceof Humanoid?{...entity.pose,...humanoid.readPose()}:entity.kind==='figure'?entity.pose:null;
    if(index!==null){
      const joint=entity.kind==='figure'?selection.joint:undefined,{origin,axis}=this.frame(selection,index),plane=new T.Plane().setFromNormalAndCoplanarPoint(axis,origin);
      const startOnPlane=this.rayAt(start).intersectPlane(plane,new T.Vector3());
      const center=origin.clone().project(this.camera),radius=this.gizmo.scale.x;
      let radial=startOnPlane?.clone().sub(origin);
      if(!radial||radial.length()<.04||radial.length()>radius*5){
        radial=this.camera.getWorldDirection(new T.Vector3()).cross(axis);if(radial.length()<.01)radial=axes[0].clone().cross(axis);if(radial.length()<.01)radial=axes[1].clone().cross(axis);
      }
      radial.normalize();const edge=origin.clone().addScaledVector(radial,radius).project(this.camera);
      const tangent3=origin.clone().addScaledVector(axis.clone().cross(radial).normalize(),radius).project(this.camera);
      const tangent=new T.Vector2(tangent3.x-center.x,tangent3.y-center.y).normalize();
      const screenRadius=Math.max(.08,new T.Vector2(edge.x-center.x,edge.y-center.y).length());
      const usePlane=!!startOnPlane&&Math.abs(axis.dot(this.camera.getWorldDirection(new T.Vector3())))>.25&&startOnPlane.distanceTo(origin)>.04;
      let last=0,total=0;
      return (p,snap)=>{
        let angle:number;
        const hit=usePlane?this.rayAt(p).intersectPlane(plane,new T.Vector3()):null;
        if(hit){const v=hit.sub(origin).normalize();const current=Math.atan2(axis.dot(radial!.clone().cross(v)),radial!.dot(v));total+=Math.atan2(Math.sin(current-last),Math.cos(current-last));last=current;angle=degrees(total);}
        else angle=degrees(p.clone().sub(start).dot(tangent)/screenRadius);
        const original=entity.kind==='figure'&&joint?displayedPose![joint]:entity.rotation;
        let value=original[index]+angle;if(snap)value=Math.round(value/15)*15;
        const r=[...original] as [number,number,number];r[index]=clamp(value,-180,180);
        return updateEntity(base,entity.id,e=>e.kind==='figure'&&joint?{...e,pose:{...displayedPose!,[joint]:limitRotation(joint,r)},contacts:[],poseId:undefined}:{...e,rotation:r});
      };
    }
    const origin=this.object(selection).getWorldPosition(new T.Vector3()),axisIndex=handle==='x'?0:handle==='y'?1:handle==='z'?2:null;
    const axis=axisIndex===null?null:axes[axisIndex];let normal=axes[1].clone();
    const direction=this.camera.getWorldDirection(new T.Vector3());
    if(axis){normal=direction.clone().addScaledVector(axis,-direction.dot(axis));if(normal.length()<.05)return null;normal.normalize();}
    else if(Math.abs(direction.dot(normal))<.12)normal.copy(direction);
    const plane=new T.Plane().setFromNormalAndCoplanarPoint(normal,origin),anchor=this.rayAt(start).intersectPlane(plane,new T.Vector3());if(!anchor)return null;
    return (p,snap)=>{
      const hit=this.rayAt(p).intersectPlane(plane,new T.Vector3());if(!hit)return base;
      let delta=hit.sub(anchor);if(axis)delta=axis.clone().multiplyScalar(delta.dot(axis));else delta.y=0;
      const next={...entity};for(const key of ['x','y','z'] as const){let value=entity[key]+delta[key];if(snap&&(axis?axis[key]!==0:key!=='y'))value=Math.round(value*10)/10;next[key]=clamp(value,-20,20);}
      if(next.kind==='figure')next.supportId=undefined;
      return updateEntity(base,entity.id,()=>next);
    };
  }
  cameraGesture(mode:'orbit'|'pan'|'zoom',point:T.Vector2):SceneGesture|null {
    if(!this.data)return null;const base=this.data,c=base.camera,start=point.clone();
    const right=axes[0].clone().applyQuaternion(this.camera.quaternion),up=axes[1].clone().applyQuaternion(this.camera.quaternion);
    const halfHeight=c.distance*Math.tan(radians(c.fov/2));
    return p=>{
      const delta=p.clone().sub(start);
      if(mode==='orbit')return {...base,camera:{...c,azimuth:wrap(c.azimuth-delta.x*100),elevation:clamp(c.elevation-delta.y*75,-15,80)}};
      if(mode==='zoom')return {...base,camera:{...c,distance:clamp(c.distance*Math.exp(-delta.y),2,40)}};
      const offset=right.clone().multiplyScalar(-delta.x*halfHeight*this.camera.aspect).addScaledVector(up,-delta.y*halfHeight);
      return {...base,camera:{...c,targetX:clamp((c.targetX??0)+offset.x,-20,20),targetY:clamp(c.targetY+offset.y,-20,20),targetZ:clamp((c.targetZ??0)+offset.z,-20,20)}};
    };
  }
  dispose(){

    this.helpers.traverse(o=>{
      if(o instanceof T.Mesh||o instanceof T.LineSegments||o instanceof T.Sprite){
        if('geometry' in o)o.geometry.dispose();
        for(const m of [o.material].flat()){if('map' in m)(m.map as T.Texture|null)?.dispose();m.dispose();}
      }
    });this.helpers.removeFromParent();
  }
}
