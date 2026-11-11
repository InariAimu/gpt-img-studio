import Konva from 'konva';
import { SketchRenderer } from './renderer';
import type { SketchDocument } from './model';

// Render the saved document, independently of editor selection, zoom, and WebGL helpers.
export async function renderDocument(doc:SketchDocument):Promise<string>{
  await document.fonts.ready;
  const output=new Konva.Stage({container:document.createElement('div'),width:doc.width,height:doc.height});
  let renderer:SketchRenderer|undefined;
  try{
    const layer=new Konva.Layer();output.add(layer);
    const paper=new Konva.Group({clipX:0,clipY:0,clipWidth:doc.width,clipHeight:doc.height});layer.add(paper);
    paper.add(new Konva.Rect({width:doc.width,height:doc.height,fill:doc.background==='transparent'?undefined:doc.background}));
    for(const l of doc.layers){
      if(!l.visible||!l.opacity)continue;
      const group=new Konva.Group({x:l.x,y:l.y,scaleX:l.scaleX,scaleY:l.scaleY,rotation:l.rotation,opacity:l.opacity});paper.add(group);
      const shape={width:l.width,height:l.height,fill:l.fill,stroke:l.stroke,strokeWidth:l.strokeWidth};
      if(l.kind==='rect')group.add(new Konva.Rect(shape));
      if(l.kind==='ellipse')group.add(new Konva.Ellipse({...shape,x:l.width/2,y:l.height/2,radiusX:l.width/2,radiusY:l.height/2}));
      if(l.kind==='text')group.add(new Konva.Text({width:l.width,text:l.text,fontSize:l.fontSize,fontFamily:'Arial, Microsoft YaHei, sans-serif',fill:l.fill,lineHeight:1.3}));
      if(l.kind==='arrow')group.add(new Konva.Arrow({points:l.points!,fill:l.stroke,stroke:l.stroke,strokeWidth:l.strokeWidth,pointerLength:l.strokeWidth*3,pointerWidth:l.strokeWidth*3}));
      if(l.kind==='pen')group.add(new Konva.Line({points:l.points,stroke:l.stroke,strokeWidth:l.strokeWidth,lineCap:'round',lineJoin:'round'}));
      if(l.kind==='image'){
        const image=await new Promise<HTMLImageElement>((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('草图图片无法解码'));image.src=l.src!;});
        group.add(new Konva.Image({width:l.width,height:l.height,image}));
      }
      if(l.kind==='scene'&&l.scene){
        renderer??=new SketchRenderer();const factor=Math.min(Math.max(l.scaleX,l.scaleY),4096/l.width,4096/l.height);
        group.add(new Konva.Image({width:l.width,height:l.height,image:renderer.render(l.scene,l.width*factor,l.height*factor)}));
      }
    }
    output.draw();return output.toDataURL({pixelRatio:1});
  }finally{output.destroy();renderer?.dispose();}
}
