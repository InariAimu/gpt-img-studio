import { blankPose, constrainPose, joints, legacyJoints, type Joint, type Pose, type Rotation } from './rig.ts';
export { joints, jointLimits, limitRotation, mirrorPose, constrainPose } from './rig.ts';
export type { Joint, Pose, Rotation } from './rig.ts';
export type Tool = 'select' | 'hand' | 'pen' | 'rect' | 'ellipse' | 'arrow' | 'text' | 'orbit' | 'move3d' | 'bend' | 'tilt' | 'twist';
export interface SceneSelection { entityId:string; joint?:Joint }
export const sceneTools:Tool[] = ['select','orbit','move3d','bend','tilt','twist'];
export const jointAxis = (tool:Tool):0|1|2|null => tool==='bend'?0:tool==='tilt'?2:tool==='twist'?1:null;
export const bodyControls = {
  height: {label:'身高（cm）',min:140,max:210,default:175},
  shoulders: {label:'肩宽（%）',min:80,max:125,default:100},
  waist: {label:'腰宽（%）',min:75,max:130,default:100},
  hips: {label:'胯宽（%）',min:80,max:125,default:100},
  arms: {label:'臂长（%）',min:80,max:120,default:100},
  legs: {label:'腿身比（%）',min:85,max:120,default:100},
  head: {label:'头身比（%）',min:85,max:120,default:100},
  weight: {label:'胖瘦',min:-50,max:50,default:0},
} as const;
export type BodyShape = Record<keyof typeof bodyControls,number>;
export const bodyDefaults = ():BodyShape => Object.fromEntries(Object.entries(bodyControls).map(([key,value])=>[key,value.default])) as BodyShape;
export const entityKinds = {figure:'人物',box:'长方体',ball:'球体',cylinder:'圆柱',cone:'圆锥',plane:'平面'} as const;
export type EntityKind = keyof typeof entityKinds;
interface EntityBase {id:string;name:string;visible:boolean;locked:boolean;color:string;x:number;y:number;z:number;rotation:Rotation}
export type Effector = 'leftWrist'|'rightWrist'|'leftAnkle'|'rightAnkle';
export interface Contact { joint:Effector; target:Rotation }
export interface FigureEntity extends EntityBase {kind:'figure';scale:number;pose:Pose;body:BodyShape;modelVersion:1|2;support:'ground'|'seat'|'free'|'legacy';supportId?:string;contacts:Contact[];poseId?:string}
export interface PrimitiveEntity extends EntityBase {kind:Exclude<EntityKind,'figure'>;dimensions:Rotation}
export type SceneEntity = FigureEntity|PrimitiveEntity;
export interface SceneData {
  camera: { azimuth:number; elevation:number; distance:number; targetX?:number; targetY:number; targetZ?:number; fov:number };
  entities:SceneEntity[];
  ground: { visible:boolean; color:string };
}
export interface SketchLayer {
  id:string; kind:'scene'|'rect'|'ellipse'|'arrow'|'pen'|'text'|'image'; name:string;
  x:number; y:number; width:number; height:number; rotation:number; scaleX:number; scaleY:number;
  visible:boolean; locked:boolean; opacity:number; fill:string; stroke:string; strokeWidth:number;
  text?:string; fontSize?:number; points?:number[]; src?:string; scene?:SceneData;
}
export interface SavedPose {id:string;name:string;pose:Pose;rotation:Rotation;support:FigureEntity['support'];contacts:Contact[];height?:number}
export interface SketchDocument { version:2; name:string; width:number; height:number; background:string; layers:SketchLayer[]; savedPoses:SavedPose[]; favoritePoses:string[] }
export const uid = () => crypto.randomUUID();
export function pose(name = '站立'): Record<Joint, Rotation> {
  const p = blankPose();
  p.leftArm=[0,0,12]; p.rightArm=[0,0,-12];
  if(name==='运球') Object.assign(p,{torso:[15,0,0],head:[-10,0,0],leftArm:[-30,0,25],leftElbow:[-65,0,0],rightArm:[25,0,-15],rightElbow:[-25,0,0],leftLeg:[-30,0,5],leftKnee:[30,0,0],rightLeg:[35,0,-5],rightKnee:[90,0,0]});
  if(name==='跑步') Object.assign(p,{torso:[12,0,0],leftArm:[55,0,10],leftElbow:[-85,0,0],rightArm:[-50,0,-10],rightElbow:[-75,0,0],leftLeg:[-45,0,0],leftKnee:[20,0,0],rightLeg:[40,0,0],rightKnee:[100,0,0]});
  if(name==='坐姿') Object.assign(p,{leftLeg:[-90,0,8],rightLeg:[-90,0,-8],leftKnee:[90,0,0],rightKnee:[90,0,0],leftArm:[-20,0,8],rightArm:[-20,0,-8],leftElbow:[-65,0,0],rightElbow:[-65,0,0]});
  if(name==='举手') Object.assign(p,{leftArm:[0,0,155],rightArm:[0,0,-155],leftElbow:[-20,0,0],rightElbow:[-20,0,0]});
  return p;
}
export function sceneDefaults(): SceneData {
  return {camera:{azimuth:22,elevation:12,distance:5,targetY:1.05,fov:38},entities:[entityDefaults('figure')],ground:{visible:true,color:'#e8e7e3'}};
}
export function entityDefaults(kind:EntityKind,name:string=entityKinds[kind]):SceneEntity {
  const base={id:uid(),name,kind,visible:true,locked:false,color:kind==='figure'?'#e4e5e7':'#8da5ad',x:0,y:kind==='figure'||kind==='plane'?0:.4,z:0,rotation:[0,0,0] as Rotation};
  return kind==='figure'?{...base,kind,scale:1,pose:pose(),body:bodyDefaults(),modelVersion:2,support:'ground',contacts:[]}:{...base,kind,dimensions:[.8,.8,.8]};
}
export function duplicateEntity(entity:SceneEntity):SceneEntity {
  return {...structuredClone(entity),id:uid(),name:`${entity.name.slice(0,110)} 副本`,locked:false,x:Math.min(20,entity.x+.6),z:Math.min(20,entity.z+.35)};
}
export function updateEntity(s:SceneData,id:string,update:(e:SceneEntity)=>SceneEntity):SceneData {
  return {...s,entities:s.entities.map(e=>e.id===id&&!e.locked?update(e):e)};
}
export function removeEntity(s:SceneData,id:string):SceneData {
  if(s.entities.find(e=>e.id===id)?.locked)return s;
  return {...s,entities:s.entities.filter(e=>e.id!==id).map(e=>e.kind==='figure'&&e.supportId===id?{...e,supportId:undefined}:e)};
}
export function layerDefaults(kind: SketchLayer['kind'], overrides:Partial<SketchLayer> = {}): SketchLayer {
  return {id:uid(),kind,name:({scene:'3D 场景',rect:'方框',ellipse:'椭圆',arrow:'箭头',pen:'笔画',text:'文字',image:'图片'})[kind],x:160,y:160,width:240,height:150,rotation:0,scaleX:1,scaleY:1,visible:true,locked:false,opacity:1,fill:'transparent',stroke:'#ed783e',strokeWidth:5,...overrides};
}
export function initialSketch():SketchDocument {
  return {version:2,name:'构图草图',width:1536,height:1024,background:'#ffffff',savedPoses:[],favoritePoses:[],layers:[layerDefaults('scene',{x:0,y:0,width:1536,height:1024,strokeWidth:0,scene:sceneDefaults()})]};
}
const color = (v:unknown) => typeof v==='string' && (/^#[\da-f]{6}$/i.test(v)||v==='transparent');
const number = (v:unknown,min:number,max:number) => typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const vector = (v:unknown,min:number,max:number):v is Rotation => Array.isArray(v)&&v.length===3&&v.every(n=>number(n,min,max));
export const MAX_ENTITIES=100, MAX_FIGURES=24;
const validPose=(p:Pose,constrained:boolean)=>p&&Object.keys(joints).every(key=>vector(p[key as Joint],-180,180))&&(!constrained||JSON.stringify(constrainPose(p))===JSON.stringify(Object.fromEntries(Object.keys(joints).map(k=>[k,p[k as Joint]]))));
const validContacts=(v:Contact[])=>Array.isArray(v)&&v.length<=4&&new Set(v.map(c=>c?.joint)).size===v.length&&v.every(c=>c&&['leftWrist','rightWrist','leftAnkle','rightAnkle'].includes(c.joint)&&vector(c.target,-4,4));
const fail=():never=>{throw new Error('草图文件无效或超出限制，当前草图未被替换。');};
/** Upgrade on read without overwriting the source. Retain the v1 rig and all hidden entities. */
function migrateLegacy(value:unknown):SketchDocument {
  const old=value as any;
  if(!Array.isArray(old.layers))return fail();
  const copy=structuredClone(old);
  copy.version=2;copy.savedPoses=[];copy.favoritePoses=[];
  for(const layer of copy.layers){
    if(layer?.kind!=='scene')continue;
    const s=layer.scene,f=s?.figure;
    if(!s||!f||!s.ball||!s.box||!s.camera||!s.ground)return fail();
    for(const e of [f,s.ball,s.box])if(!number(e.x,-4,4)||!number(e.y,-2,4)||!number(e.z,-4,4))return fail();
    if(!number(f.yaw,-180,180)||!number(f.scale,.4,2)||(f.modelVersion!==undefined&&f.modelVersion!==1))return fail();
    if(!legacyJoints.every(j=>vector(f.pose?.[j],-180,180))||!number(s.ball.size,.05,1)||!number(s.box.size,.1,3))return fail();
    const human={...entityDefaults('figure'),...f,id:uid(),kind:'figure',name:'人物 1',locked:false,rotation:[0,f.yaw,0],pose:{...blankPose(),...f.pose},body:f.body===undefined?bodyDefaults():f.body,modelVersion:1,support:'legacy',contacts:[]};
    delete human.yaw;
    const primitives=['ball','box'].map(kind=>{const o=s[kind];return {...entityDefaults(kind as EntityKind),...o,kind,name:kind==='ball'?'球体 1':'长方体 1',dimensions:[o.size,o.size,o.size]};});
    layer.scene={camera:s.camera,ground:s.ground,entities:[human,...primitives]};
  }
  return copy;
}
/** Validate portable files before they become editable state or image URLs. */
export function validateSketch(value:unknown):SketchDocument {
  const d=((value as any)?.version===1?migrateLegacy(value):value) as SketchDocument;
  if(!d||d.version!==2||typeof d.name!=='string'||d.name.length>120||!number(d.width,256,4096)||!number(d.height,256,4096)||!Number.isInteger(d.width)||!Number.isInteger(d.height)||!color(d.background)||!Array.isArray(d.layers)||d.layers.length>200) return fail();
  if(!Array.isArray(d.savedPoses)||d.savedPoses.length>200||!Array.isArray(d.favoritePoses)||d.favoritePoses.length>500||d.favoritePoses.some(id=>typeof id!=='string'||id.length>120))return fail();
  const savedIds=new Set<string>();
  for(const p of d.savedPoses){if(!p||typeof p.id!=='string'||p.id.length>120||savedIds.has(p.id)||typeof p.name!=='string'||p.name.length>80||!validPose(p.pose,true)||!vector(p.rotation,-180,180)||!['ground','seat','free','legacy'].includes(p.support)||!validContacts(p.contacts)||(p.height!==undefined&&!number(p.height,-20,20)))return fail();savedIds.add(p.id);}
  const ids=new Set<string>();let scenes=0;
  for(const l of d.layers){
    if(!l||typeof l.id!=='string'||l.id.length>120||ids.has(l.id)||typeof l.name!=='string'||l.name.length>120||!['scene','rect','ellipse','arrow','pen','text','image'].includes(l.kind))return fail();ids.add(l.id);
    if(!number(l.x,-30000,30000)||!number(l.y,-30000,30000)||!number(l.width,1,16384)||!number(l.height,1,16384)||!number(l.scaleX,.01,100)||!number(l.scaleY,.01,100)||!number(l.rotation,-36000,36000)||!number(l.opacity,0,1)||!number(l.strokeWidth,0,100)||!color(l.fill)||!color(l.stroke)||typeof l.visible!=='boolean'||typeof l.locked!=='boolean')return fail();
    if(l.kind==='text'&&(typeof l.text!=='string'||l.text.length>10000||!number(l.fontSize,8,300)))return fail();
    if(['pen','arrow'].includes(l.kind)&&(!Array.isArray(l.points)||l.points.length<4||l.points.length>40000||l.points.length%2||l.points.some(n=>!number(n,-30000,30000))))return fail();
    if(l.kind==='image'&&(typeof l.src!=='string'||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(l.src)||l.src.length>16000000))return fail();
    if(l.kind==='scene'){
      const s=l.scene;if(++scenes>1||!s||!s.camera||!s.ground||!Array.isArray(s.entities)||s.entities.length>MAX_ENTITIES)return fail();
      const c=s.camera;if(!number(c.azimuth,-360,360)||!number(c.elevation,-15,80)||!number(c.distance,2,40)||!number(c.targetY,-20,20)||!number(c.targetX??0,-20,20)||!number(c.targetZ??0,-20,20)||!number(c.fov,20,80))return fail();
      if(typeof s.ground.visible!=='boolean'||!color(s.ground.color)||s.ground.color==='transparent')return fail();
      const entities=new Set<string>();let figures=0;
      for(const e of s.entities){
        if(!e||typeof e.id!=='string'||!e.id||e.id.length>120||entities.has(e.id)||!Object.hasOwn(entityKinds,e.kind)||typeof e.name!=='string'||e.name.length>120||typeof e.visible!=='boolean'||typeof e.locked!=='boolean'||!color(e.color)||e.color==='transparent'||!number(e.x,-20,20)||!number(e.y,-20,20)||!number(e.z,-20,20)||!vector(e.rotation,-180,180))return fail();entities.add(e.id);
        if(e.kind==='figure'){
          if(++figures>MAX_FIGURES||![1,2].includes(e.modelVersion)||!number(e.scale,.4,2)||!validPose(e.pose,e.modelVersion===2)||!['ground','seat','free','legacy'].includes(e.support)||!validContacts(e.contacts)||(e.poseId!==undefined&&(typeof e.poseId!=='string'||e.poseId.length>120)))return fail();
          if(!e.body||typeof e.body!=='object'||Array.isArray(e.body))return fail();
          for(const [key,control] of Object.entries(bodyControls))if(!number(e.body[key as keyof BodyShape],control.min,control.max))return fail();
        }else if(!vector(e.dimensions,.02,20))return fail();
      }
      for(const e of s.entities)if(e.kind==='figure'&&e.supportId!==undefined&&(!entities.has(e.supportId)||e.supportId===e.id||s.entities.find(o=>o.id===e.supportId)?.kind==='figure'))return fail();
    }
  }
  if(JSON.stringify(d).length>48*1024*1024)return fail();
  return d;
}
