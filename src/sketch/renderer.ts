import * as T from 'three';
import { type SceneData, type SceneEntity, type PrimitiveEntity } from './model.ts';
import { Humanoid } from './Humanoid.ts';
import { SceneInteraction, type SceneEditor } from './SceneInteraction';

export class SketchRenderer {
  readonly renderer = new T.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});
  readonly scene=new T.Scene();
  readonly camera=new T.PerspectiveCamera();
  readonly objects=new Map<string,T.Mesh|Humanoid>();
  readonly warnings=new Map<string,string>();
  private keys=new Map<string,string>();
  private groundMaterial=new T.MeshStandardMaterial({color:'#e8e7e3',roughness:1});
  readonly ground=new T.Mesh(new T.PlaneGeometry(200,200),this.groundMaterial);
  readonly interaction:SceneInteraction;
  private light=new T.DirectionalLight(0xffffff,3);
  constructor(){
    this.renderer.setPixelRatio(1);this.renderer.setClearColor(0,0);
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=T.PCFShadowMap;
    this.scene.add(new T.HemisphereLight(0xffffff,0x81818b,2.2));
    this.light.position.set(-3,6,4);this.light.castShadow=true;this.light.shadow.mapSize.set(1024,1024);this.light.shadow.normalBias=.025;
    this.scene.add(this.light,this.light.target);
    this.ground.rotation.x=-Math.PI/2;this.ground.position.y=-.04;this.ground.receiveShadow=true;this.scene.add(this.ground);
    this.interaction=new SceneInteraction(this.scene,this.camera,this.objects);
  }
  private create(e:SceneEntity){
    if(e.kind==='figure')return new Humanoid(e.body,e.modelVersion);
    const geometries={ball:()=>new T.SphereGeometry(1,24,16),box:()=>new T.BoxGeometry(1,1,1),cylinder:()=>new T.CylinderGeometry(1,1,1,32),cone:()=>new T.ConeGeometry(1,1,32),plane:()=>new T.PlaneGeometry(1,1)};
    return new T.Mesh(geometries[e.kind](),new T.MeshStandardMaterial({color:e.color,roughness:.85,side:e.kind==='plane'?T.DoubleSide:T.FrontSide}));
  }
  private disposeObject(object:T.Mesh|Humanoid){
    object.removeFromParent();
    if(object instanceof Humanoid)object.dispose();
    else{object.geometry.dispose();for(const m of [object.material].flat())m.dispose();}
  }
  render(data:SceneData,width:number,height:number,editor:SceneEditor|null=null):HTMLCanvasElement {
    width=Math.max(1,Math.round(width));height=Math.max(1,Math.round(height));
    if(this.renderer.domElement.width!==width||this.renderer.domElement.height!==height)this.renderer.setSize(width,height,false);
    const ids=new Set(data.entities.map(e=>e.id));
    for(const [id,o] of this.objects)if(!ids.has(id)){this.disposeObject(o);this.objects.delete(id);this.keys.delete(id);this.warnings.delete(id);}
    for(const e of data.entities){
      let object=this.objects.get(e.id);
      if(object&&(object.userData.kind!==e.kind||(object instanceof Humanoid&&e.kind==='figure'&&object.modelVersion!==e.modelVersion))){this.disposeObject(object);this.objects.delete(e.id);this.keys.delete(e.id);object=undefined;}
      if(!object){object=this.create(e);object.userData={entityId:e.id,kind:e.kind};this.objects.set(e.id,object);this.scene.add(object);}
      object.visible=e.visible;object.userData.locked=e.locked;object.castShadow=object.receiveShadow=true;
      const support=e.kind==='figure'?data.entities.find(v=>v.id===e.supportId):undefined;
      const key=JSON.stringify([e,support]);
      if(this.keys.get(e.id)===key)continue;
      this.keys.set(e.id,key);this.warnings.delete(e.id);
      object.position.set(0,0,0);object.rotation.set(...e.rotation.map(T.MathUtils.degToRad) as [number,number,number]);
      if(e.kind==='figure'&&object instanceof Humanoid){
        object.scale.setScalar(e.scale);object.setBody(e.body);object.setPose(e.pose);object.updateMatrixWorld(true);object.solveContacts(e.contacts);
        const offset=e.support==='legacy'||e.support==='free'?object.groundOffset*e.scale:object.supportOffset(e.support==='seat');
        let y=e.y;
        if(support&&support.kind!=='figure'){
          if(support.kind==='box'&&Math.abs(support.rotation[0])<.1&&Math.abs(support.rotation[2])<.1)y=support.y+support.dimensions[1]/2;
          else if(support.kind==='plane'&&Math.abs(support.rotation[0])<.1&&Math.abs(support.rotation[2])<.1)y=support.y;
          else this.warnings.set(e.id,'支撑面需要水平长方体或平面；已使用手动支撑高度。');
        }
        object.position.set(e.x,offset+y,e.z);object.mesh.material.color.set(e.color);object.updateMatrixWorld(true);object.updateBounds();
        if(object.hasBodyIntersection())this.warnings.set(e.id,'检测到疑似肢体与躯干穿插，请从侧面检查并调整关节。');
        if(object.contactError>.1)this.warnings.set(e.id,'部分手脚目标超出当前体型的可达范围，请调整目标或姿势。');
      }else if(object instanceof T.Mesh){
        const d=(e as PrimitiveEntity).dimensions;
        object.position.set(e.x,e.y,e.z);object.scale.set(...d);
        if(e.kind==='plane')object.rotateX(-Math.PI/2);
        (object.material as T.MeshStandardMaterial).color.set(e.color);
      }
    }
    this.ground.visible=data.ground.visible;this.groundMaterial.color.set(data.ground.color);
    const c=data.camera,az=T.MathUtils.degToRad(c.azimuth),el=T.MathUtils.degToRad(c.elevation);
    this.camera.fov=c.fov;this.camera.aspect=width/height;this.camera.near=.05;this.camera.far=300;
    this.camera.position.set((c.targetX??0)+c.distance*Math.cos(el)*Math.sin(az),c.targetY+c.distance*Math.sin(el),(c.targetZ??0)+c.distance*Math.cos(el)*Math.cos(az));
    this.camera.lookAt(c.targetX??0,c.targetY,c.targetZ??0);this.camera.updateProjectionMatrix();this.camera.updateMatrixWorld(true);
    const shadow=Math.max(5,c.distance*.8);this.light.shadow.camera.left=-shadow;this.light.shadow.camera.right=shadow;this.light.shadow.camera.top=shadow;this.light.shadow.camera.bottom=-shadow;this.light.shadow.camera.updateProjectionMatrix();
    this.scene.updateMatrixWorld(true);this.interaction.update(data,editor);
    this.renderer.render(this.scene,this.camera);return this.renderer.domElement;
  }
  dispose(){
    this.interaction.dispose();for(const o of this.objects.values())this.disposeObject(o);this.objects.clear();this.keys.clear();
    this.ground.geometry.dispose();this.groundMaterial.dispose();this.light.shadow.map?.dispose();this.renderer.dispose();this.renderer.forceContextLoss();
  }
}
