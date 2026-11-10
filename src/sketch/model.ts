export type Tool = 'select' | 'hand' | 'pen' | 'rect' | 'ellipse' | 'arrow' | 'text' | 'orbit' | 'move3d' | 'bend' | 'tilt' | 'twist';
export type ScenePart = 'figure' | 'ball' | 'box';
export interface SceneSelection { part:ScenePart; joint?:Joint }
export const sceneTools:Tool[] = ['select','orbit','move3d','bend','tilt','twist'];
export const jointAxis = (tool:Tool):0|1|2|null => tool==='bend'?0:tool==='tilt'?2:tool==='twist'?1:null;
export type Joint = 'torso' | 'head' | 'leftArm' | 'rightArm' | 'leftElbow' | 'rightElbow' | 'leftLeg' | 'rightLeg' | 'leftKnee' | 'rightKnee';
export const joints: Record<Joint, string> = { torso:'躯干', head:'头部', leftArm:'左肩', rightArm:'右肩', leftElbow:'左肘', rightElbow:'右肘', leftLeg:'左髋', rightLeg:'右髋', leftKnee:'左膝', rightKnee:'右膝' };
export type Rotation = [number, number, number];
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
export interface SceneData {
  camera: { azimuth:number; elevation:number; distance:number; targetX?:number; targetY:number; targetZ?:number; fov:number };
  figure: { visible:boolean; color:string; x:number; y:number; z:number; yaw:number; scale:number; pose:Record<Joint, Rotation>; body?:BodyShape; modelVersion?:1 };
  ball: { visible:boolean; color:string; x:number; y:number; z:number; size:number };
  box: { visible:boolean; color:string; x:number; y:number; z:number; size:number };
  ground: { visible:boolean; color:string };
}
export interface SketchLayer {
  id:string; kind:'scene'|'rect'|'ellipse'|'arrow'|'pen'|'text'|'image'; name:string;
  x:number; y:number; width:number; height:number; rotation:number; scaleX:number; scaleY:number;
  visible:boolean; locked:boolean; opacity:number; fill:string; stroke:string; strokeWidth:number;
  text?:string; fontSize?:number; points?:number[]; src?:string; scene?:SceneData;
}
export interface SketchDocument { version:1; name:string; width:number; height:number; background:string; layers:SketchLayer[] }
export const uid = () => crypto.randomUUID();
export function pose(name = '站立'): Record<Joint, Rotation> {
  const p = Object.fromEntries(Object.keys(joints).map(j => [j, [0,0,0]])) as Record<Joint,Rotation>;
  p.leftArm=[0,0,12]; p.rightArm=[0,0,-12];
  if(name==='运球') Object.assign(p,{torso:[15,0,0],head:[-10,0,0],leftArm:[-30,0,25],leftElbow:[-65,0,0],rightArm:[25,0,-15],rightElbow:[-25,0,0],leftLeg:[-30,0,5],leftKnee:[30,0,0],rightLeg:[35,0,-5],rightKnee:[90,0,0]});
  if(name==='跑步') Object.assign(p,{torso:[12,0,0],leftArm:[55,0,10],leftElbow:[-85,0,0],rightArm:[-50,0,-10],rightElbow:[-75,0,0],leftLeg:[-45,0,0],leftKnee:[20,0,0],rightLeg:[40,0,0],rightKnee:[100,0,0]});
  if(name==='坐姿') Object.assign(p,{leftLeg:[-90,0,8],rightLeg:[-90,0,-8],leftKnee:[90,0,0],rightKnee:[90,0,0],leftArm:[-20,0,8],rightArm:[-20,0,-8],leftElbow:[-65,0,0],rightElbow:[-65,0,0]});
  if(name==='举手') Object.assign(p,{leftArm:[0,0,155],rightArm:[0,0,-155],leftElbow:[-20,0,0],rightElbow:[-20,0,0]});
  return p;
}
export function sceneDefaults(): SceneData {
  return {camera:{azimuth:22,elevation:12,distance:4.4,targetY:1.05,fov:38},figure:{visible:true,color:'#e4e5e7',x:0,y:0,z:0,yaw:0,scale:1,pose:pose('运球'),body:bodyDefaults(),modelVersion:1},ball:{visible:true,color:'#d86d39',x:.78,y:1.15,z:.35,size:.22},box:{visible:false,color:'#8da5ad',x:-.8,y:.3,z:0,size:.6},ground:{visible:true,color:'#e8e7e3'}};
}
export function layerDefaults(kind: SketchLayer['kind'], overrides:Partial<SketchLayer> = {}): SketchLayer {
  return {id:uid(),kind,name:({scene:'3D 场景',rect:'方框',ellipse:'椭圆',arrow:'箭头',pen:'笔画',text:'文字',image:'图片'})[kind],x:160,y:160,width:240,height:150,rotation:0,scaleX:1,scaleY:1,visible:true,locked:false,opacity:1,fill:'transparent',stroke:'#ed783e',strokeWidth:5,...overrides};
}
export function initialSketch():SketchDocument {
  return {version:1,name:'构图草图',width:1024,height:768,background:'#ffffff',layers:[layerDefaults('scene',{x:0,y:0,width:1024,height:768,strokeWidth:0,scene:sceneDefaults()})]};
}
const color = (v:unknown) => typeof v==='string' && (/^#[\da-f]{6}$/i.test(v)||v==='transparent');
const number = (v:unknown,min:number,max:number) => typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
/** Validate portable files before they become editable state or image URLs. */
export function validateSketch(value:unknown):SketchDocument {
  const d=value as SketchDocument;
  const fail=()=>{throw new Error('草图文件无效或超出限制，当前草图未被替换。');};
  if(!d||d.version!==1||typeof d.name!=='string'||d.name.length>120||!number(d.width,256,4096)||!number(d.height,256,4096)||!Number.isInteger(d.width)||!Number.isInteger(d.height)||!color(d.background)||!Array.isArray(d.layers)||d.layers.length>200) return fail();
  const ids=new Set<string>();let scenes=0;
  for(const l of d.layers){
    if(!l||typeof l.id!=='string'||ids.has(l.id)||typeof l.name!=='string'||l.name.length>120||!['scene','rect','ellipse','arrow','pen','text','image'].includes(l.kind))return fail();ids.add(l.id);
    if(!number(l.x,-30000,30000)||!number(l.y,-30000,30000)||!number(l.width,1,16384)||!number(l.height,1,16384)||!number(l.scaleX,.01,100)||!number(l.scaleY,.01,100)||!number(l.rotation,-36000,36000)||!number(l.opacity,0,1)||!number(l.strokeWidth,0,100)||!color(l.fill)||!color(l.stroke)||typeof l.visible!=='boolean'||typeof l.locked!=='boolean')return fail();
    if(l.kind==='text'&&(typeof l.text!=='string'||l.text.length>10000||!number(l.fontSize,8,300)))return fail();
    if(['pen','arrow'].includes(l.kind)&&(!Array.isArray(l.points)||l.points.length<4||l.points.length>40000||l.points.length%2||l.points.some(n=>!number(n,-30000,30000))))return fail();
    if(l.kind==='image'&&(typeof l.src!=='string'||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(l.src)||l.src.length>16000000))return fail();
    if(l.kind==='scene'){
      const s=l.scene;if(++scenes>1||!s||!s.camera||!s.figure||!s.ball||!s.box||!s.ground)return fail();
      const c=s.camera;if(!number(c.azimuth,-360,360)||!number(c.elevation,-15,80)||!number(c.distance,2,12)||!number(c.targetY,-8,8)||!number(c.targetX??0,-8,8)||!number(c.targetZ??0,-8,8)||!number(c.fov,20,80))return fail();
      for(const o of [s.figure,s.ball,s.box])if(typeof o.visible!=='boolean'||!color(o.color)||o.color==='transparent'||!number(o.x,-4,4)||!number(o.y,-2,4)||!number(o.z,-4,4))return fail();
      if(!number(s.figure.yaw,-180,180)||!number(s.figure.scale,.4,2)||!number(s.ball.size,.05,1)||!number(s.box.size,.1,3)||typeof s.ground.visible!=='boolean'||!color(s.ground.color)||s.ground.color==='transparent')return fail();
      for(const key of Object.keys(joints) as Joint[]){const r=s.figure.pose?.[key];if(!Array.isArray(r)||r.length!==3||r.some(v=>!number(v,-180,180)))return fail();}
      // Old sketches have neither field and render with the default body. Never
      // silently accept a newer rig whose joint angles might mean something else.
      if(s.figure.modelVersion!==undefined&&s.figure.modelVersion!==1)return fail();
      if(s.figure.body!==undefined){
        if(!s.figure.body||typeof s.figure.body!=='object'||Array.isArray(s.figure.body))return fail();
        for(const [key,control] of Object.entries(bodyControls))if(!number(s.figure.body[key as keyof BodyShape],control.min,control.max))return fail();
      }
    }
  }
  if(JSON.stringify(d).length>48*1024*1024)return fail();
  return d;
}
