import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import Konva from 'konva';
import { Vector2 } from 'three';
import { Stage, Layer, Group, Rect, Ellipse, Arrow, Line, Text, Image as KImage, Transformer } from 'react-konva';
import { jointAxis, joints, layerDefaults, sceneTools, type SceneSelection, type SketchDocument, type SketchLayer, type Tool } from './model';
import { SketchRenderer } from './renderer';
import type { SceneEditor, SceneGesture } from './SceneInteraction';

export interface CanvasHandle { exportPng():Promise<string>; fit():void; zoom(factor:number):void }
interface Props { document:SketchDocument; selected:string|null; sceneSelection:SceneSelection|null; axes:boolean; grid:boolean; tool:Tool; color:string; lineWidth:number; onSelect:(id:string|null)=>void; onSceneSelect:(selection:SceneSelection|null)=>void; onEdit:(update:(d:SketchDocument)=>SketchDocument,commit?:boolean)=>void; onCommit:()=>void; onTool:(tool:Tool)=>void; onError:(e:unknown)=>void; onImport:(file:File)=>void }
function renderSize(l:SketchLayer,max:number,multiplier=1):[number,number]{const factor=Math.min(multiplier,max/l.width,max/l.height);return [l.width*factor,l.height*factor];}
export default forwardRef<CanvasHandle,Props>(function SketchCanvas({document:doc,selected,sceneSelection,axes,grid,tool,color,lineWidth,onSelect,onSceneSelect,onEdit,onCommit,onTool,onError,onImport},ref){
  const host=useRef<HTMLDivElement>(null),stage=useRef<Konva.Stage>(null),art=useRef<Konva.Group>(null),transformer=useRef<Konva.Transformer>(null);
  const [size,setSize]=useState({width:600,height:600}),[view,setView]=useState({zoom:1,x:0,y:0}),[images,setImages]=useState<Record<string,HTMLImageElement>>({});
  const renderer=useRef<SketchRenderer|null>(null),[sceneImage,setSceneImage]=useState<HTMLCanvasElement>(),[renderVersion,setRenderVersion]=useState(0),[renderError,setRenderError]=useState('');
  const drag=useRef<{kind:'draw'|'pan'|'scene';x:number;y:number;id?:string;startX:number;startY:number}|null>(null);
  const sceneGesture=useRef<SceneGesture|null>(null),wheelTimer=useRef<ReturnType<typeof setTimeout>|null>(null),pointer=useRef<number|null>(null);
  const live=useRef(doc);live.current=doc;
  const sceneLayer=doc.layers.find(l=>l.kind==='scene');
  const sceneEnabled=!!sceneLayer?.scene&&sceneLayer.visible&&!sceneLayer.locked&&sceneLayer.opacity>0;
  const editor:SceneEditor|null=sceneEnabled&&sceneTools.includes(tool)?{selection:selected===sceneLayer?.id?sceneSelection:null,tool,axes,grid}:null;
  const fit=Math.min((size.width-48)/doc.width,(size.height-48)/doc.height);
  const scale=Math.max(.02,fit*view.zoom),offset={x:(size.width-doc.width*scale)/2+view.x,y:(size.height-doc.height*scale)/2+view.y};
  const active=doc.layers.find(l=>l.id===selected);
  useLayoutEffect(()=>{const o=new ResizeObserver(entries=>{const r=entries[0].contentRect;setSize({width:r.width,height:r.height});});if(host.current)o.observe(host.current);return()=>o.disconnect();},[]);
  useEffect(()=>{
    let r:SketchRenderer;try{r=new SketchRenderer();renderer.current=r;setSceneImage(r.renderer.domElement);setRenderVersion(v=>v+1);}catch(e){setRenderError('当前设备无法启动 3D 渲染；二维工具仍可使用。');onError(e);}
    return()=>{r?.dispose();renderer.current=null;};
  },[]);
  useLayoutEffect(()=>{
    if(!renderer.current||!sceneLayer?.scene)return;
    try{renderer.current.render(sceneLayer.scene,...renderSize(sceneLayer,1600),editor);setRenderVersion(v=>v+1);}catch(e){setRenderError('3D 预览失败，请重新打开草图。');onError(e);}
  },[sceneImage,sceneLayer,selected,sceneSelection,tool,axes,grid]);
  const imageSources=doc.layers.filter(l=>l.kind==='image').map(l=>l.src!).join('|');
  useEffect(()=>{
    let cancelled=false;
    const sources=[...new Set(live.current.layers.filter(l=>l.kind==='image').map(l=>l.src!))];
    Promise.all(sources.map(src=>new Promise<[string,HTMLImageElement]>((resolve,reject)=>{const img=new window.Image();img.onload=()=>resolve([src,img]);img.onerror=()=>reject(new Error('草图图片无法解码，请重新导入。'));img.src=src;})))
      .then(values=>{if(!cancelled)setImages(Object.fromEntries(values));}).catch(e=>{if(!cancelled)onError(e);});
    return()=>{cancelled=true;};
  },[imageSources]);
  useLayoutEffect(()=>{
    const node=art.current?.getChildren().find(n=>n.id()===selected);
    transformer.current?.nodes(tool==='select'&&active?.kind!=='scene'&&active?.visible&&!active.locked&&node?[node]:[]);transformer.current?.getLayer()?.batchDraw();
  },[selected,tool,doc.layers]);
  const moveRef=useRef<(e:PointerEvent)=>void>(()=>{});
  useEffect(()=>{
    const stop=()=>{if(drag.current){const drawing=drag.current.kind==='draw';drag.current=null;sceneGesture.current=null;pointer.current=null;onCommit();if(drawing)onTool('select');}};
    const move=(e:PointerEvent)=>{if(drag.current&&(pointer.current===null||pointer.current===e.pointerId))moveRef.current(e);};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop);window.addEventListener('pointercancel',stop);window.addEventListener('blur',stop);
    return()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);window.removeEventListener('pointercancel',stop);window.removeEventListener('blur',stop);if(wheelTimer.current)clearTimeout(wheelTimer.current);stop();};
  },[onCommit,onTool]);
  function patch(id:string,value:Partial<SketchLayer>,commit=false){onEdit(d=>({...d,layers:d.layers.map(l=>l.id===id?{...l,...value}:l)}),commit);}
  function position(){const p=stage.current?.getPointerPosition();return p?{x:(p.x-offset.x)/scale,y:(p.y-offset.y)/scale}:null;}
  function scenePoint(){
    const node=art.current?.getChildren().find(n=>n.id()===sceneLayer?.id),p=stage.current?.getPointerPosition();if(!node||!p||!sceneLayer)return null;
    const local=node.getAbsoluteTransform().copy().invert().point(p);return new Vector2(local.x/sceneLayer.width*2-1,1-local.y/sceneLayer.height*2);
  }
  function down(e:Konva.KonvaEventObject<PointerEvent>){
    if(drag.current||![0,1,2].includes(e.evt.button))return;const p=position();if(!p)return;
    if(wheelTimer.current){clearTimeout(wheelTimer.current);wheelTimer.current=null;onCommit();}
    const layer=e.target.findAncestor((n:Konva.Node)=>doc.layers.some(l=>l.id===n.id()));
    const sceneSurface=!layer||layer.id()===sceneLayer?.id;
    if(tool==='hand'){drag.current={kind:'pan',x:e.evt.clientX,y:e.evt.clientY,startX:view.x,startY:view.y};return;}
    if(sceneEnabled&&sceneTools.includes(tool)&&sceneSurface&&renderer.current&&sceneLayer?.scene){
      const point=scenePoint();if(!point)return;
      const controls=renderer.current.interaction;let gesture:SceneGesture|null=null;
      if(e.evt.button===2||e.evt.button===1||tool==='orbit')gesture=controls.cameraGesture(e.evt.button===2?'pan':e.evt.button===1?'zoom':'orbit',point);
      else {
        const inside=Math.abs(point.x)<=1&&Math.abs(point.y)<=1&&p.x>=0&&p.y>=0&&p.x<=doc.width&&p.y<=doc.height;
        const handle=inside?controls.pickHandle(point):null,hit=inside?(handle?editor?.selection??null:controls.pick(point)):null;
        onSelect(sceneLayer.id);onSceneSelect(hit);
        if(hit){controls.update(sceneLayer.scene,{selection:hit,tool,axes,grid});gesture=controls.begin(hit,tool,point,handle);}
        else gesture=controls.cameraGesture('orbit',point);
      }
      if(gesture){sceneGesture.current=gesture;drag.current={kind:'scene',id:sceneLayer.id,x:e.evt.clientX,y:e.evt.clientY,startX:0,startY:0};pointer.current=e.evt.pointerId;(e.evt.target as Element).setPointerCapture?.(e.evt.pointerId);}
      e.evt.preventDefault();return;
    }
    if(e.evt.button===2)return;
    if(e.evt.button===1){drag.current={kind:'pan',x:e.evt.clientX,y:e.evt.clientY,startX:view.x,startY:view.y};return;}
    if(tool==='select'){if(e.target===stage.current||e.target.name()==='paper')onSelect(null);return;}
    if(sceneTools.includes(tool))return;
    if(p.x<0||p.y<0||p.x>doc.width||p.y>doc.height||doc.layers.length>=200)return;
    if(tool==='text'){
      const l=layerDefaults('text',{x:p.x,y:p.y,width:300,height:64,text:'双击或在右侧修改文字',fontSize:32,fill:color,strokeWidth:0});onEdit(d=>({...d,layers:[...d.layers,l]}),true);onSelect(l.id);onTool('select');return;
    }
    const l=layerDefaults(tool as 'rect'|'ellipse'|'arrow'|'pen',{x:p.x,y:p.y,width:1,height:1,stroke:color,strokeWidth:lineWidth,...(['pen','arrow'].includes(tool)?{points:[0,0,1,1]}:{})});
    drag.current={kind:'draw',id:l.id,x:p.x,y:p.y,startX:0,startY:0};onEdit(d=>({...d,layers:[...d.layers,l]}));onSelect(l.id);
  }
  moveRef.current=(e:PointerEvent)=>{
    const g=drag.current;if(!g)return;stage.current?.setPointersPositions(e);
    if(g.kind==='pan'){setView(v=>({...v,x:g.startX+e.clientX-g.x,y:g.startY+e.clientY-g.y}));return;}
    if(g.kind==='scene'){
      const point=scenePoint();if(point&&sceneGesture.current&&(Math.abs(e.clientX-g.x)+Math.abs(e.clientY-g.y)>2))patch(g.id!,{scene:sceneGesture.current(point,e.shiftKey)});return;
    }
    const p=position(),l=live.current.layers.find(l=>l.id===g.id);if(!p||!l)return;
    const x=Math.max(0,Math.min(doc.width,p.x)),y=Math.max(0,Math.min(doc.height,p.y));
    if(l.kind==='pen'){if((l.points?.length??0)<40000)patch(l.id,{points:[...(l.points??[]),x-g.x,y-g.y],width:Math.max(1,Math.abs(x-g.x)),height:Math.max(1,Math.abs(y-g.y))});}
    else if(l.kind==='arrow')patch(l.id,{points:[0,0,x-g.x,y-g.y],width:Math.max(1,Math.abs(x-g.x)),height:Math.max(1,Math.abs(y-g.y))});
    else patch(l.id,{x:Math.min(g.x,x),y:Math.min(g.y,y),width:Math.max(1,Math.abs(x-g.x)),height:Math.max(1,Math.abs(y-g.y))});
  };
  useImperativeHandle(ref,()=>({
    fit:()=>setView({zoom:1,x:0,y:0}),zoom:factor=>setView(v=>({...v,zoom:Math.max(.2,Math.min(6,v.zoom*factor))})),
    exportPng:async()=>{
      if(!art.current)throw new Error('画布尚未就绪');
      const current=live.current,s=current.layers.find(l=>l.kind==='scene'&&l.visible);
      if(s&&(!renderer.current||renderError))throw new Error('3D 渲染不可用，请恢复后再导出，或隐藏 3D 图层。');
      if(current.layers.some(l=>l.kind==='image'&&l.visible&&!images[l.src!]))throw new Error('图片仍在载入，请稍后导出。');
      await window.document.fonts.ready;
      const container=window.document.createElement('div');const output=new Konva.Stage({container,width:current.width,height:current.height});
      try{
        if(s?.scene)renderer.current!.render(s.scene,...renderSize(s,4096,Math.max(s.scaleX,s.scaleY)));
        const layer=new Konva.Layer();output.add(layer);layer.add(art.current.clone({x:0,y:0,scaleX:1,scaleY:1}));output.draw();return output.toDataURL({pixelRatio:1});
      }finally{output.destroy();if(s?.scene){renderer.current!.render(s.scene,...renderSize(s,1600),editor);stage.current?.batchDraw();}}
    }
  }));
  const common=(l:SketchLayer)=>({id:l.id,x:l.x,y:l.y,width:l.width,height:l.height,scaleX:l.scaleX,scaleY:l.scaleY,rotation:l.rotation,opacity:l.opacity,visible:l.visible,draggable:tool==='select'&&l.kind!=='scene'&&!l.locked,
    onClick:()=>{if(tool==='select'&&l.kind!=='scene')onSelect(l.id);},onTap:()=>{if(tool==='select'&&l.kind!=='scene')onSelect(l.id);},
    onDblClick:()=>{if(l.kind==='text'&&!l.locked)window.document.getElementById('sketch-text')?.focus();},
    onDragEnd:(e:Konva.KonvaEventObject<DragEvent>)=>patch(l.id,{x:e.target.x(),y:e.target.y()},true),
    onTransformEnd:(e:Konva.KonvaEventObject<Event>)=>{const n=e.target;patch(l.id,{x:n.x(),y:n.y(),rotation:n.rotation(),scaleX:n.scaleX(),scaleY:n.scaleY()},true);}
  });
  return <div className={`sketch-viewport tool-${tool}`} ref={host} onContextMenu={e=>e.preventDefault()} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f)onImport(f);}} aria-label="草图画布">
    <div className="sketch-paper-preview" style={{left:offset.x,top:offset.y,width:doc.width*scale,height:doc.height*scale,background:doc.background==='transparent'?'repeating-conic-gradient(var(--checker-light) 0% 25%, var(--checker-dark) 25% 50%) 0 0 / 16px 16px':doc.background}}/>
    <Stage ref={stage} width={size.width} height={size.height} onPointerDown={down} onWheel={e=>{e.evt.preventDefault();if(drag.current)return;if(sceneEnabled&&sceneTools.includes(tool)&&sceneLayer?.scene&&!e.evt.ctrlKey){const c=sceneLayer.scene.camera;patch(sceneLayer.id,{scene:{...sceneLayer.scene,camera:{...c,distance:Math.max(2,Math.min(12,c.distance*Math.exp(e.evt.deltaY*.001)))}}});if(wheelTimer.current)clearTimeout(wheelTimer.current);wheelTimer.current=setTimeout(()=>{onCommit();wheelTimer.current=null;},250);}else setView(v=>({...v,zoom:Math.max(.2,Math.min(6,v.zoom*(e.evt.deltaY>0?.9:1.1)))}));}}>
      <Layer>
        <Group ref={art} x={offset.x} y={offset.y} scaleX={scale} scaleY={scale} clipX={0} clipY={0} clipWidth={doc.width} clipHeight={doc.height}>
          <Rect name="paper" width={doc.width} height={doc.height} fill={doc.background==='transparent'?undefined:doc.background}/>
          {doc.layers.map(l=><Group key={l.id} {...common(l)}>
            {l.kind==='rect'&&<Rect width={l.width} height={l.height} fill={l.fill} stroke={l.stroke} strokeWidth={l.strokeWidth}/>}
            {l.kind==='ellipse'&&<Ellipse x={l.width/2} y={l.height/2} radiusX={l.width/2} radiusY={l.height/2} fill={l.fill} stroke={l.stroke} strokeWidth={l.strokeWidth}/>}
            {l.kind==='text'&&<Text width={l.width} text={l.text} fontSize={l.fontSize} fontFamily="Arial, Microsoft YaHei, sans-serif" fill={l.fill} lineHeight={1.3}/>}
            {l.kind==='arrow'&&<Arrow points={l.points!} fill={l.stroke} stroke={l.stroke} strokeWidth={l.strokeWidth} pointerLength={l.strokeWidth*3} pointerWidth={l.strokeWidth*3} hitStrokeWidth={15}/>}
            {l.kind==='pen'&&<Line points={l.points} stroke={l.stroke} strokeWidth={l.strokeWidth} lineCap="round" lineJoin="round" hitStrokeWidth={15}/>}
            {l.kind==='image'&&<KImage width={l.width} height={l.height} image={images[l.src!]}/>}
            {l.kind==='scene'&&<KImage width={l.width} height={l.height} image={sceneImage} data-render={renderVersion}/>}
          </Group>)}
        </Group>
        <Transformer ref={transformer} flipEnabled={false} rotateEnabled enabledAnchors={['top-left','top-right','bottom-left','bottom-right']} boundBoxFunc={(old,b)=>b.width<8||b.height<8||b.width>16000||b.height>16000?old:b}/>
      </Layer>
    </Stage>
    {editor&&<div className="sketch-scene-hint" role="status">{editor.selection?<><strong>{editor.selection.part==='figure'?(jointAxis(tool)!==null?joints[editor.selection.joint??'torso']:'人物'):editor.selection.part==='ball'?'球体':'方块'}</strong>{editor.selection.part==='figure'&&jointAxis(tool)!==null&&<b>{sceneLayer!.scene!.figure.pose[editor.selection.joint??'torso'][jointAxis(tool)!].toFixed(1)}°</b>}<span>{jointAxis(tool)!==null?(editor.selection.part==='figure'?'拖动肢体或圆环调整 · Shift 吸附 15°':'请选择人物肢体以调整关节'):'拖物件沿地面移动 · 拖 XYZ 轴移动'}</span></>:<span>点击物件或肢体选取 · 空白处左键绕转</span>}</div>}
    <div className="sketch-canvas-status">{doc.width} × {doc.height}<span>{Math.round(scale*100)}%</span><span>{editor?'右键平移相机 · 中键/滚轮缩放 · Ctrl 滚轮缩放画板':tool==='hand'?'拖动平移画布':'滚轮缩放 · 中键平移'}</span></div>
    {renderError&&<div className="sketch-render-error" role="alert">{renderError}</div>}
  </div>;
});
