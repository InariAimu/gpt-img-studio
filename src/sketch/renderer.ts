import * as THREE from 'three';
import { bodyDefaults, type SceneData } from './model';
import { Humanoid } from './Humanoid';
import { SceneInteraction, type SceneEditor } from './SceneInteraction';

/** One shared scene and depth buffer, including the bundled continuous humanoid. */
export class SketchRenderer {
  readonly renderer = new THREE.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera();
  readonly figure = new Humanoid(bodyDefaults());
  readonly pivots = this.figure.pivots;
  private ballMaterial = new THREE.MeshStandardMaterial({color:'#d86d39',roughness:.8});
  private boxMaterial = new THREE.MeshStandardMaterial({color:'#8da5ad',roughness:.9});
  private groundMaterial = new THREE.MeshStandardMaterial({color:'#e8e7e3',roughness:1});
  readonly ball:THREE.Mesh;
  readonly box:THREE.Mesh;
  readonly ground:THREE.Mesh;
  readonly interaction:SceneInteraction;
  constructor(){
    this.renderer.setPixelRatio(1);this.renderer.setClearColor(0,0);
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFShadowMap;
    this.scene.add(new THREE.HemisphereLight(0xffffff,0x81818b,2.2));
    const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(-3,6,4);light.castShadow=true;light.shadow.mapSize.set(1024,1024);light.shadow.camera.left=-5;light.shadow.camera.right=5;light.shadow.camera.top=5;light.shadow.camera.bottom=-5;light.shadow.normalBias=.025;this.scene.add(light);
    this.scene.add(this.figure);
    this.ball=new THREE.Mesh(new THREE.SphereGeometry(1,32,24),this.ballMaterial);this.ball.castShadow=true;this.ball.receiveShadow=true;this.scene.add(this.ball);
    this.box=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),this.boxMaterial);this.box.castShadow=true;this.box.receiveShadow=true;this.scene.add(this.box);
    this.ground=new THREE.Mesh(new THREE.PlaneGeometry(200,200),this.groundMaterial);this.ground.rotation.x=-Math.PI/2;this.ground.position.y=-.04;this.ground.receiveShadow=true;this.scene.add(this.ground);
    this.interaction=new SceneInteraction(this.scene,this.camera,this);
  }
  render(data:SceneData,width:number,height:number,editor:SceneEditor|null=null):HTMLCanvasElement {
    width=Math.max(1,Math.round(width));height=Math.max(1,Math.round(height));
    if(this.renderer.domElement.width!==width||this.renderer.domElement.height!==height)this.renderer.setSize(width,height,false);
    const f=data.figure;this.figure.setBody(f.body??bodyDefaults());this.figure.setPose(f.pose);
    this.figure.visible=f.visible;this.figure.position.set(f.x,this.figure.groundOffset*f.scale+f.y,f.z);this.figure.rotation.y=THREE.MathUtils.degToRad(f.yaw);this.figure.scale.setScalar(f.scale);this.figure.mesh.material.color.set(f.color);
    for(const key of ['ball','box'] as const){const d=data[key],m=this[key];m.visible=d.visible;m.position.set(d.x,d.y,d.z);m.scale.setScalar(d.size);}
    this.ballMaterial.color.set(data.ball.color);this.boxMaterial.color.set(data.box.color);this.ground.visible=data.ground.visible;this.groundMaterial.color.set(data.ground.color);
    const c=data.camera,az=THREE.MathUtils.degToRad(c.azimuth),el=THREE.MathUtils.degToRad(c.elevation);
    this.camera.fov=c.fov;this.camera.aspect=width/height;this.camera.near=.05;this.camera.far=300;
    this.camera.position.set((c.targetX??0)+c.distance*Math.cos(el)*Math.sin(az),c.targetY+c.distance*Math.sin(el),(c.targetZ??0)+c.distance*Math.cos(el)*Math.cos(az));this.camera.lookAt(c.targetX??0,c.targetY,c.targetZ??0);this.camera.updateProjectionMatrix();this.camera.updateMatrixWorld(true);this.scene.updateMatrixWorld(true);
    this.figure.updateBounds();
    this.interaction.update(data,editor);
    this.renderer.render(this.scene,this.camera);return this.renderer.domElement;
  }
  dispose(){
    this.interaction.dispose();
    this.scene.traverse(o=>{if(o instanceof THREE.Mesh&&o!==this.figure.mesh)o.geometry.dispose();});
    for(const m of [this.ballMaterial,this.boxMaterial,this.groundMaterial])m.dispose();
    this.figure.dispose();
    this.renderer.dispose();this.renderer.forceContextLoss();
  }
}
