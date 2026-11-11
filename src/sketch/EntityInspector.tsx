import { useState } from 'react';
import { bodyControls, bodyDefaults, constrainPose, jointLimits, joints, limitRotation, mirrorPose, type BodyShape, type Contact, type Effector, type FigureEntity, type Joint, type Rotation, type SceneData, type SceneEntity } from './model.ts';
import { legacyJoints } from './rig.ts';
import { Humanoid } from './Humanoid.ts';

export function EntityInspector({entity:e,scene,joint,onJoint,onChange,onCommit,onLibrary,onSavePose}:{entity:SceneEntity;scene:SceneData;joint:Joint;onJoint:(joint:Joint)=>void;onChange:(update:(e:SceneEntity)=>SceneEntity,save?:boolean)=>void;onCommit:()=>void;onLibrary:()=>void;onSavePose:(name:string)=>void}){
  const [poseName,setPoseName]=useState('');
  const range=(label:string,value:number,min:number,max:number,change:(value:number)=>void,step=1)=><label className="sketch-range" key={label}><span>{label}</span><input aria-label={label} type="range" value={value} min={min} max={max} step={step} disabled={min===max} onChange={event=>change(Number(event.target.value))} onPointerUp={onCommit} onKeyUp={onCommit} onBlur={onCommit}/><output>{Number(value.toFixed(2))}</output></label>;
  const human=(update:(f:FigureEntity)=>FigureEntity,save=false)=>onChange(value=>value.kind==='figure'?update(value):value,save);
  const updateContact=(index:number,axis:number,value:number)=>human(f=>({...f,contacts:f.contacts.map((c,i)=>i===index?{...c,target:c.target.map((n,a)=>a===axis?value:n) as Rotation}:c)}));
  const addContact=(joint:Effector)=>{
    if(e.kind!=='figure'||e.contacts.some(c=>c.joint===joint))return;
    const h=new Humanoid(e.body,2);
    try{h.setPose(e.pose);h.updateMatrixWorld(true);h.solveContacts(e.contacts);const target=h.pivots[joint].getWorldPosition(h.position.clone()).multiplyScalar(175/e.body.height).toArray() as Rotation;human(f=>({...f,modelVersion:2,pose:constrainPose(f.pose),contacts:[...f.contacts,{joint,target}]}),true);}finally{h.dispose();}
  };
  const releaseContacts=()=>{
    if(e.kind!=='figure')return;
    const h=new Humanoid(e.body,2);try{h.setPose(e.pose);h.updateMatrixWorld(true);h.solveContacts(e.contacts);const pose=constrainPose(h.readPose());human(f=>({...f,pose,contacts:[]}),true);}finally{h.dispose();}
  };
  const availableJoints=e.kind==='figure'&&e.modelVersion===1?legacyJoints:Object.keys(joints) as Joint[];
  const activeJoint=availableJoints.includes(joint)?joint:'torso';
  return <fieldset disabled={e.locked} className="sketch-entity-properties">
    <label className="sketch-field">实体名称<input aria-label="实体名称" value={e.name} maxLength={120} onChange={v=>onChange(x=>({...x,name:v.target.value}))} onBlur={onCommit}/></label>
    {e.locked&&<p className="sketch-help">实体已锁定，请在列表中解锁。</p>}
    <label className="sketch-color">颜色<input type="color" aria-label="实体颜色" value={e.color} onChange={v=>onChange(x=>({...x,color:v.target.value}),true)}/></label>
    {e.kind==='figure'&&<div className="sketch-section"><button className="button primary full" onClick={onLibrary}>浏览分类姿势库</button><div className="sketch-inline-actions"><button className="button secondary small" onClick={()=>human(f=>({...f,modelVersion:2,pose:mirrorPose(f.pose),rotation:[f.rotation[0],f.rotation[1],-f.rotation[2]],contacts:f.contacts.map(c=>({joint:c.joint.replace(/^left/,'RIGHT').replace(/^right/,'left').replace(/^RIGHT/,'right') as Effector,target:[-c.target[0],c.target[1],c.target[2]]})),poseId:undefined}),true)}>左右镜像</button></div>
      {e.modelVersion===1&&<p className="sketch-help">旧草图保留原骨架；应用预设或镜像后启用扩展骨架。</p>}
      <label className="sketch-field">保存自定义姿势<input aria-label="自定义姿势名称" maxLength={80} placeholder="例如：扶栏站立" value={poseName} onChange={v=>setPoseName(v.target.value)}/></label><button className="button secondary full" disabled={!poseName.trim()} onClick={()=>{onSavePose(poseName.trim());setPoseName('');}}>保存当前姿势</button>
    </div>}
    <details className="sketch-section" open><summary>位置与旋转</summary>
      {(['x','y','z'] as const).map(axis=>range(({x:'水平位置',y:e.kind==='figure'?'支撑高度 / 悬空偏移':'垂直位置',z:'前后位置'})[axis],e[axis],-20,20,v=>onChange(x=>({...x,[axis]:v,...(x.kind==='figure'?{supportId:undefined}:{})})),.05))}
      {['整体前后旋转','整体朝向','整体侧向旋转'].map((label,index)=>range(label,e.rotation[index],-180,180,v=>onChange(x=>({...x,rotation:x.rotation.map((n,i)=>i===index?v:n) as Rotation}))))}
    </details>
    {e.kind!=='figure'?<div className="sketch-section"><h3>几何尺寸</h3>{(e.kind==='ball'?['半径']:e.kind==='plane'?['宽度','深度']:e.kind==='cylinder'||e.kind==='cone'?['半径','高度']:['宽度','高度','深度']).map((label,index)=>range(label,e.dimensions[index],.02,10,v=>onChange(x=>x.kind==='figure'?x:{...x,dimensions:x.kind==='ball'?[v,v,v]:x.kind==='cylinder'||x.kind==='cone'?(index===0?[v,x.dimensions[1],v]:[x.dimensions[0],v,x.dimensions[0]]):x.dimensions.map((n,i)=>i===index?v:n) as Rotation}),.02))}</div>:<>
      <details className="sketch-section"><summary>体型</summary>{range('人物大小',e.scale,.4,2,v=>human(f=>({...f,scale:v})),.05)}
        {Object.entries(bodyControls).map(([key,c])=>range(c.label,e.body[key as keyof BodyShape],c.min,c.max,v=>human(f=>({...f,body:{...f.body,[key]:v}}))))}
        <button className="button secondary full" onClick={()=>human(f=>({...f,body:bodyDefaults()}),true)}>重置体型</button>
      </details>
      <details className="sketch-section" open><summary>人体约束</summary><p className="sketch-help">关节限位始终生效。支撑自动随体型修正；悬空姿势保留离地高度。</p>
        <label className="sketch-field">支撑方式<select aria-label="支撑方式" value={e.support} onChange={v=>human(f=>({...f,support:v.target.value as FigureEntity['support'],supportId:undefined}),true)}><option value="ground">最低接触点落地</option><option value="seat">臀部对齐座面</option><option value="free">悬空 / 自由摆放</option>{e.support==='legacy'&&<option value="legacy">旧版高度</option>}</select></label>
        {e.support==='seat'&&<label className="sketch-field">座面实体<select aria-label="座面实体" value={e.supportId??''} onChange={v=>{const target=scene.entities.find(o=>o.id===v.target.value);human(f=>({...f,supportId:target?.id,...(target?{x:target.x,z:target.z}:{})}),true);}}><option value="">手动设置支撑高度</option>{scene.entities.filter(o=>(o.kind==='box'||o.kind==='plane')&&Math.abs(o.rotation[0])<.1&&Math.abs(o.rotation[2])<.1).map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select></label>}
        <label className="sketch-field">添加手脚目标<select aria-label="添加手脚目标" value="" onChange={v=>addContact(v.target.value as Effector)}><option value="" disabled>选择末端位置约束</option>{(['leftWrist','rightWrist','leftAnkle','rightAnkle'] as Effector[]).filter(j=>!e.contacts.some(c=>c.joint===j)).map(j=><option key={j} value={j}>{joints[j]}</option>)}</select></label>
        {e.contacts.map((c,index)=><details key={c.joint}><summary>{joints[c.joint]}目标</summary>{['左右','上下','前后'].map((axis,i)=>range(`${joints[c.joint]}目标${axis}`,c.target[i],-2,2,v=>updateContact(index,i,v),.02))}</details>)}
        {!!e.contacts.length&&<><p className="sketch-help">目标相对人物骨盆，随身高缩放；不可达时显示提示。手动调关节会解除目标，手指不参与求解。</p><button className="button secondary full" onClick={releaseContacts}>解除目标并保留姿势</button></>}
      </details>
      <div className="sketch-section"><label className="sketch-field">调整关节<select aria-label="调整关节" value={activeJoint} onChange={v=>onJoint(v.target.value as Joint)}>{availableJoints.map(j=><option key={j} value={j}>{joints[j]}</option>)}</select></label>{['前后弯曲','左右转动','侧向抬起'].map((label,index)=>range(label,e.pose[activeJoint][index],jointLimits[activeJoint][0][index],jointLimits[activeJoint][1][index],v=>human(f=>{const r=[...f.pose[activeJoint]] as Rotation;r[index]=v;return {...f,pose:{...f.pose,[activeJoint]:limitRotation(activeJoint,r)},contacts:[],poseId:undefined};})))}</div>
    </>}
  </fieldset>;
}
