import { blankPose, constrainPose, type Pose, type Rotation } from './rig.ts';
import type { Contact, FigureEntity, SavedPose } from './model';

export interface PosePreset extends SavedPose {category:'日常'|'运动'|'军事'|'自定义';family:string;tags:string[];height?:number}
type Patch=Partial<Pose>;
const a=(x=0,y=0,z=0):Rotation=>[x,y,z];
const stand:Patch={leftArm:a(0,0,8),rightArm:a(0,0,-8)};
const sit:Patch={...stand,leftLeg:a(-90,0,5),rightLeg:a(-90,0,-5),leftKnee:a(90),rightKnee:a(90),leftElbow:a(-70),rightElbow:a(-70),leftArm:a(-15,0,8),rightArm:a(-15,0,-8)};
const crouch:Patch={torso:a(30),leftLeg:a(-110,0,15),rightLeg:a(-110,0,-15),leftKnee:a(135),rightKnee:a(135),leftAnkle:a(-25),rightAnkle:a(-25),leftArm:a(-40,0,12),rightArm:a(-40,0,-12),leftElbow:a(-70),rightElbow:a(-70)};
const kneel:Patch={...stand,leftLeg:a(-85,0,8),leftKnee:a(90),rightLeg:a(15,0,-10),rightKnee:a(125),rightAnkle:a(40)};
const run:Patch={torso:a(12),leftArm:a(45,0,10),rightArm:a(-50,0,-10),leftElbow:a(-85),rightElbow:a(-85),leftLeg:a(-45),rightLeg:a(30),leftKnee:a(25),rightKnee:a(100),rightAnkle:a(25)};
const aim:Patch={leftArm:a(-75,0,22),rightArm:a(-65,0,-30),leftElbow:a(-70),rightElbow:a(-105),leftWrist:a(0,45),rightWrist:a(0,-35),head:a(0,10),chest:a(0,-10)};
// Authored for the bundled rig. Distinct action phases are explicit presets, not mirrored count inflation.
const entries:Array<[string,PosePreset['category'],string,string,Patch,Rotation?,FigureEntity['support']?,number?,Contact[]?]>=[
  ['stand','日常','站立','自然站立',stand],
  ['attention','日常','站立','直立并足',{leftArm:a(),rightArm:a()}],
  ['relaxed','日常','站立','单腿承重',{...stand,pelvis:a(0,0,5),leftLeg:a(-8,0,4),leftKnee:a(15),torso:a(0,0,-5)}],
  ['hands-hips','日常','站立','双手叉腰',{leftArm:a(10,0,32),rightArm:a(10,0,-32),leftElbow:a(-110),rightElbow:a(-110),leftWrist:a(15,60),rightWrist:a(15,-60)}],
  ['wave','日常','交流','挥手',{...stand,leftArm:a(-15,0,100),leftElbow:a(-80),leftWrist:a(0,0,15)}],
  ['point','日常','交流','向前指示',{...stand,rightArm:a(-90,0,-8),head:a(0,-12)}],
  ['reach','日常','取物','向上取物',{...stand,leftArm:a(-160,0,10),leftClavicle:a(0,0,12),head:a(-15)}],
  ['bend-pick','日常','取物','俯身拾物',{torso:a(40),chest:a(25),leftLeg:a(-40,0,10),rightLeg:a(-25,0,-12),leftKnee:a(40),rightKnee:a(30),leftArm:a(-35),rightArm:a(-25)}],
  ['walk-contact','日常','行走','行走迈步',{...stand,leftLeg:a(-25),rightLeg:a(20),rightKnee:a(20),leftArm:a(20),rightArm:a(-20),leftElbow:a(-15),rightElbow:a(-15)}],
  ['walk-pass','日常','行走','行走经过',{...stand,leftLeg:a(-10),leftKnee:a(55),rightLeg:a(5),leftArm:a(5),rightArm:a(-5)}],
  ['chair','日常','坐姿','端正椅坐',sit,undefined,'seat',.55],
  ['chair-lean','日常','坐姿','前倾椅坐',{...sit,torso:a(25),leftElbow:a(-95),rightElbow:a(-95)},undefined,'seat',.55],
  ['chair-rest','日常','坐姿','后靠椅坐',{...sit,torso:a(-15),chest:a(-10),leftArm:a(10,0,20),rightArm:a(10,0,-20)},undefined,'seat',.55],
  ['floor-sit','日常','坐姿','地面伸腿坐',{...stand,leftLeg:a(-90,0,8),rightLeg:a(-90,0,-8),leftKnee:a(8),rightKnee:a(8),leftArm:a(25,0,15),rightArm:a(25,0,-15)}],
  ['floor-hug','日常','坐姿','屈膝抱腿坐',{...sit,leftLeg:a(-115,0,10),rightLeg:a(-115,0,-10),leftKnee:a(125),rightKnee:a(125),torso:a(15),leftArm:a(-55,0,25),rightArm:a(-55,0,-25),leftElbow:a(-90),rightElbow:a(-90)}],
  ['supine','日常','躺卧','仰卧',{...stand},a(-90)],
  ['prone','日常','躺卧','俯卧',{leftArm:a(-135,0,20),rightArm:a(-135,0,-20),leftElbow:a(-25),rightElbow:a(-25),head:a(-20)},a(90)],
  ['side-sleep','日常','躺卧','侧卧蜷腿',{...sit,leftLeg:a(-45),rightLeg:a(-60),leftKnee:a(75),rightKnee:a(95),leftArm:a(-50),rightArm:a(-60)},a(0,0,90)],
  ['squat','日常','蹲跪','下蹲',crouch],
  ['kneel','日常','蹲跪','单膝跪地',kneel],
  ['kneel-both','日常','蹲跪','双膝跪坐',{...stand,leftLeg:a(-10,0,5),rightLeg:a(-10,0,-5),leftKnee:a(145),rightKnee:a(145),leftAnkle:a(40),rightAnkle:a(40)}],
  ['drive','日常','驾驶','驾驶握方向盘',{...sit,leftArm:a(-65,0,18),rightArm:a(-65,0,-18),leftElbow:a(-50),rightElbow:a(-50)},undefined,'seat',.55,[{joint:'leftWrist',target:[.25,.33,.6]},{joint:'rightWrist',target:[-.25,.33,.6]}]],
  ['read','日常','阅读','坐姿阅读',{...sit,head:a(20),leftArm:a(-40,0,12),rightArm:a(-40,0,-12),leftElbow:a(-100),rightElbow:a(-100)},undefined,'seat',.55],
  ['carry','日常','搬物','胸前抱物',{...stand,leftArm:a(-25,0,30),rightArm:a(-25,0,-30),leftElbow:a(-90),rightElbow:a(-90),torso:a(-8)}],
  ['run-contact','运动','跑步','跑步支撑',run],
  ['run-flight','运动','跑步','跑步腾空',{...run,leftLeg:a(-65),leftKnee:a(65),rightLeg:a(40),rightKnee:a(110)},undefined,'free',.35],
  ['sprint','运动','跑步','冲刺迈步',{...run,torso:a(25),leftArm:a(55),rightArm:a(-80),leftLeg:a(-85),rightLeg:a(35),leftKnee:a(70),rightKnee:a(70)}],
  ['start','运动','跑步','起跑准备',{...kneel,torso:a(40),chest:a(25),leftArm:a(-30),rightArm:a(-30),rightLeg:a(35),rightKnee:a(80)}],
  ['jog','运动','跑步','慢跑',{...run,torso:a(5),leftLeg:a(-25),rightLeg:a(15),rightKnee:a(75),leftArm:a(20),rightArm:a(-25)}],
  ['dribble-low','运动','篮球','低位运球',{...crouch,leftLeg:a(-45,0,18),rightLeg:a(-35,0,-18),leftKnee:a(55),rightKnee:a(45),rightArm:a(-10,0,-20),rightElbow:a(-20),leftArm:a(-45,0,40)}],
  ['dribble-step','运动','篮球','行进运球',{...run,rightArm:a(15,0,-20),rightElbow:a(-25),leftArm:a(-40,0,30),leftElbow:a(-60)}],
  ['basket-ready','运动','篮球','投篮准备',{...stand,leftLeg:a(-25,0,8),rightLeg:a(-25,0,-8),leftKnee:a(35),rightKnee:a(35),leftArm:a(-65,0,15),rightArm:a(-70,0,-15),leftElbow:a(-100),rightElbow:a(-110)}],
  ['basket-release','运动','篮球','投篮出手',{...stand,leftArm:a(-150,0,20),rightArm:a(-165,0,-10),leftElbow:a(-15),rightWrist:a(55)},undefined,'free',.25],
  ['defend','运动','篮球','防守展开',{...crouch,leftLeg:a(-40,0,30),rightLeg:a(-40,0,-30),leftKnee:a(55),rightKnee:a(55),leftArm:a(-10,0,80),rightArm:a(-10,0,-80),leftElbow:a(-10),rightElbow:a(-10)}],
  ['jump-load','运动','跳跃','跳跃蓄力',{...crouch,leftLeg:a(-65,0,8),rightLeg:a(-65,0,-8),leftKnee:a(85),rightKnee:a(85),leftArm:a(45),rightArm:a(45),leftElbow:a(-15),rightElbow:a(-15)}],
  ['jump-takeoff','运动','跳跃','起跳伸展',{...stand,leftArm:a(-140,0,15),rightArm:a(-140,0,-15),leftAnkle:a(35),rightAnkle:a(35)},undefined,'free',.15],
  ['jump-tuck','运动','跳跃','腾空收腿',{leftLeg:a(-100,0,10),rightLeg:a(-100,0,-10),leftKnee:a(130),rightKnee:a(130),leftArm:a(-65,0,25),rightArm:a(-65,0,-25),leftElbow:a(-80),rightElbow:a(-80)},undefined,'free',.85],
  ['jump-land','运动','跳跃','落地缓冲',{...crouch,leftLeg:a(-70,0,10),rightLeg:a(-70,0,-10),leftKnee:a(90),rightKnee:a(90),leftArm:a(-60,0,15),rightArm:a(-60,0,-15),leftElbow:a(-15),rightElbow:a(-15)}],
  ['long-jump','运动','跳跃','跳远腾空',{...sit,leftLeg:a(-80,0,10),rightLeg:a(-85,0,-10),leftKnee:a(20),rightKnee:a(20),leftArm:a(-95,0,20),rightArm:a(-95,0,-20),leftElbow:a(-20),rightElbow:a(-20)},undefined,'free',.7],
  ['freestyle-reach','运动','游泳','自由泳前伸',{leftArm:a(-175,0,8),rightArm:a(30,0,-15),leftLeg:a(-10),rightLeg:a(10),rightKnee:a(20),leftAnkle:a(35),rightAnkle:a(35)},a(90),'free',.2],
  ['freestyle-pull','运动','游泳','自由泳划水',{leftArm:a(-80,0,35),leftElbow:a(-100),rightArm:a(-150,0,-30),rightElbow:a(-45),leftLeg:a(10),rightLeg:a(-10),leftAnkle:a(35),rightAnkle:a(35)},a(90),'free',.2],
  ['breast-open','运动','游泳','蛙泳划臂',{leftArm:a(-100,0,75),rightArm:a(-100,0,-75),leftElbow:a(-60),rightElbow:a(-60),leftLeg:a(-25,25,25),rightLeg:a(-25,-25,-25),leftKnee:a(100),rightKnee:a(100)},a(90),'free',.2],
  ['breast-glide','运动','游泳','蛙泳滑行',{leftArm:a(-175,0,5),rightArm:a(-175,0,-5),leftAnkle:a(40),rightAnkle:a(40)},a(90),'free',.2],
  ['backstroke','运动','游泳','仰泳划臂',{leftArm:a(-175,0,15),rightArm:a(20,0,-40),leftKnee:a(20),rightLeg:a(-10),leftAnkle:a(35),rightAnkle:a(35)},a(-90),'free',.2],
  ['throw-windup','运动','投掷','投掷引臂',{...stand,chest:a(0,-25),rightArm:a(35,0,-95),rightElbow:a(-100),leftArm:a(-80,0,20),leftLeg:a(-30),leftKnee:a(60)}],
  ['throw-release','运动','投掷','投掷出手',{...stand,chest:a(20,25),rightArm:a(-130,0,-30),rightElbow:a(-15),leftArm:a(20,0,30),leftLeg:a(-35),leftKnee:a(30),rightLeg:a(25)}],
  ['throw-follow','运动','投掷','投掷随动',{...stand,torso:a(30),chest:a(15,30),rightArm:a(-70,30,20),rightElbow:a(-25),leftLeg:a(-35),leftKnee:a(45),rightLeg:a(35),rightKnee:a(70)}],
  ['kick-ready','运动','足球','踢球引腿',{...stand,rightLeg:a(35),rightKnee:a(100),leftArm:a(10,0,60),rightArm:a(-20,0,-50)}],
  ['kick','运动','足球','踢球触球',{...stand,rightLeg:a(-80),rightKnee:a(15),torso:a(-10),leftArm:a(15,0,70),rightArm:a(-20,0,-55)}],
  ['tennis','运动','挥拍','正手挥拍',{...stand,leftLeg:a(-25,0,20),rightLeg:a(-15,0,-20),leftKnee:a(35),rightKnee:a(25),chest:a(0,30),rightArm:a(-80,30,-45),rightElbow:a(-30),leftArm:a(-40,0,50)}],
  ['serve','运动','挥拍','发球举拍',{...stand,torso:a(-15),leftArm:a(-160,0,10),rightArm:a(-120,0,-35),rightElbow:a(-120),leftKnee:a(20),rightKnee:a(30)}],
  ['lunge','运动','伸展','弓步伸展',{...stand,leftLeg:a(-70,0,8),leftKnee:a(85),rightLeg:a(35,0,-8),rightKnee:a(10),leftArm:a(-160),rightArm:a(-160)}],
  ['side-stretch','运动','伸展','侧身伸展',{...stand,torso:a(0,0,20),chest:a(0,0,15),leftArm:a(-165,0,15),rightArm:a(0,0,-15),leftLeg:a(0,0,15),rightLeg:a(0,0,-15)}],
  ['pushup','运动','力量','俯卧撑支撑',{leftArm:a(-90,0,15),rightArm:a(-90,0,-15),leftElbow:a(-10),rightElbow:a(-10),leftWrist:a(-60),rightWrist:a(-60),leftAnkle:a(-20),rightAnkle:a(-20)},a(80)],
  ['guard-stand','军事','警戒','站姿警戒',{...stand,...aim,leftArm:a(-35,0,22),rightArm:a(-30,0,-25),leftLeg:a(-8,0,12),rightLeg:a(8,0,-12)}],
  ['guard-look','军事','警戒','转头观察',{...stand,...aim,leftArm:a(-35,0,22),rightArm:a(-30,0,-25),head:a(0,40),neck:a(0,20)}],
  ['guard-low','军事','警戒','低姿警戒',{...crouch,...aim,leftLeg:a(-50,0,18),rightLeg:a(-45,0,-18),leftKnee:a(70),rightKnee:a(60),torso:a(15)}],
  ['guard-kneel','军事','警戒','跪姿警戒',{...kneel,...aim,leftArm:a(-40,0,22),rightArm:a(-35,0,-25)}],
  ['aim-stand','军事','射击姿态','站姿持长械',{...stand,...aim,leftLeg:a(-15,0,12),rightLeg:a(15,0,-12),torso:a(10)}],
  ['aim-kneel','军事','射击姿态','跪姿持长械',{...kneel,...aim,torso:a(8)}],
  ['aim-prone','军事','射击姿态','卧姿持长械',{...aim,leftArm:a(-120,0,30),rightArm:a(-115,0,-35),leftElbow:a(-70),rightElbow:a(-90),head:a(-25),neck:a(-20),leftLeg:a(0,0,10),rightLeg:a(0,0,-10)},a(90)],
  ['aim-twohand','军事','射击姿态','双手前举',{...stand,leftArm:a(-90,0,-8),rightArm:a(-90,0,8),leftElbow:a(-15),rightElbow:a(-15),leftLeg:a(-12,0,12),rightLeg:a(12,0,-12),torso:a(8)}],
  ['aim-onehand','军事','射击姿态','单手前举',{...stand,rightArm:a(-90),rightElbow:a(-8),leftElbow:a(-90),leftLeg:a(-10,0,10),rightLeg:a(10,0,-10)}],
  ['cover-crouch','军事','隐蔽','掩体后蹲姿',{...crouch,...aim,leftArm:a(-30,0,20),rightArm:a(-25,0,-20)}],
  ['cover-lean','军事','隐蔽','侧探观察',{...stand,...aim,torso:a(0,0,20),chest:a(0,15,10),leftLeg:a(-15,0,20),leftKnee:a(25)}],
  ['cover-wall','军事','隐蔽','贴墙收臂',{...stand,leftArm:a(-15,0,8),rightArm:a(-15,0,-8),leftElbow:a(-130),rightElbow:a(-130),head:a(0,35)}],
  ['cover-kneel','军事','隐蔽','低位跪伏',{...kneel,...aim,torso:a(35),chest:a(20),head:a(-20)}],
  ['crawl','军事','低姿移动','匍匐前伸',{leftArm:a(-160,0,20),rightArm:a(-90,0,-60),rightElbow:a(-100),leftLeg:a(-25,0,25),leftKnee:a(70),rightLeg:a(0,0,-10),head:a(-25)},a(90)],
  ['low-step','军事','低姿移动','弯腰迈步',{...run,...aim,torso:a(35),leftLeg:a(-65),leftKnee:a(75),rightLeg:a(10),rightKnee:a(35)}],
  ['rush','军事','低姿移动','持械跑动',{...run,...aim,leftArm:a(-30,0,20),rightArm:a(-25,0,-25),torso:a(20)}],
  ['signal-stop','军事','手势','抬手示停',{...stand,leftArm:a(-20,0,100),leftElbow:a(-90),leftWrist:a(0,30),rightArm:a(-20),rightElbow:a(-95)}],
  ['signal-forward','军事','手势','向前示意',{...stand,leftArm:a(-100,0,15),rightArm:a(-20),rightElbow:a(-95),head:a(0,15)}],
];
const holdingTargets=(left:Rotation,right:Rotation):Contact[]=>[{joint:'leftWrist',target:left},{joint:'rightWrist',target:right}];
const contactsById:Record<string,Contact[]>={
  'hands-hips':holdingTargets([.3,.03,0],[-.3,.03,0]),
  'floor-hug':holdingTargets([.25,-.02,.5],[-.25,-.02,.5]),
  read:holdingTargets([.19,.24,.48],[-.19,.24,.48]),
  carry:holdingTargets([.32,.15,.4],[-.32,.15,.4]),
};
export const posePresets:PosePreset[]=entries.map(([id,category,family,name,patch,rotation=[0,0,0],support='ground',height=0,contacts=[]])=>{
  const holding=category==='军事'&&['guard-stand','guard-look','guard-low','guard-kneel','aim-stand','aim-kneel','cover-crouch','cover-lean','cover-kneel','low-step','rush'].includes(id);
  contacts=contactsById[id]??(holding?holdingTargets([.18,.32,.62],[-.16,.4,.3]):contacts);
  return {id,category,family,name,tags:[category,family,name],pose:constrainPose({...blankPose(),...patch}),rotation,support,height,contacts};
});
export function applyPreset(figure:FigureEntity,preset:PosePreset):FigureEntity {
  return {...figure,modelVersion:2,pose:structuredClone(preset.pose),poseId:preset.id,rotation:[preset.rotation[0],figure.rotation[1],preset.rotation[2]],support:preset.support,supportId:undefined,contacts:structuredClone(preset.contacts),y:preset.height??0};
}
