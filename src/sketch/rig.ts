export type Rotation = [number, number, number];
export const joints = {
  pelvis:'骨盆', torso:'腰部', chest:'胸部', neck:'颈部', head:'头部',
  leftClavicle:'左肩带', rightClavicle:'右肩带', leftArm:'左肩', rightArm:'右肩',
  leftElbow:'左肘', rightElbow:'右肘', leftWrist:'左腕', rightWrist:'右腕',
  leftLeg:'左髋', rightLeg:'右髋', leftKnee:'左膝', rightKnee:'右膝', leftAnkle:'左踝', rightAnkle:'右踝',
} as const;
export type Joint = keyof typeof joints;
export type Pose = Record<Joint, Rotation>;
export const legacyJoints:Joint[] = ['torso','head','leftArm','rightArm','leftElbow','rightElbow','leftLeg','rightLeg','leftKnee','rightKnee'];
type Limits = [Rotation, Rotation];
// Editor comfort ranges in this rig's local XYZ convention, not medical ROM values.
// Elbows/knees are hinges; forearm roll is represented by the wrist's Y channel.
export const jointLimits:Record<Joint,Limits> = {
  pelvis:[[-25,-35,-25],[25,35,25]], torso:[[-25,-30,-25],[45,30,25]], chest:[[-20,-35,-20],[30,35,20]],
  neck:[[-25,-45,-25],[30,45,25]], head:[[-25,-45,-25],[30,45,25]],
  leftClavicle:[[-15,-20,-15],[15,20,30]], rightClavicle:[[-15,-20,-30],[15,20,15]],
  leftArm:[[-175,-80,-35],[65,80,175]], rightArm:[[-175,-80,-175],[65,80,35]],
  leftElbow:[[-150,0,0],[0,0,0]], rightElbow:[[-150,0,0],[0,0,0]],
  leftWrist:[[-65,-80,-30],[65,80,30]], rightWrist:[[-65,-80,-30],[65,80,30]],
  leftLeg:[[-130,-45,-30],[45,45,70]], rightLeg:[[-130,-45,-70],[45,45,30]],
  leftKnee:[[0,0,0],[150,0,0]], rightKnee:[[0,0,0],[150,0,0]],
  leftAnkle:[[-35,-15,-20],[50,15,20]], rightAnkle:[[-35,-15,-20],[50,15,20]],
};
export const blankPose = ():Pose => Object.fromEntries(Object.keys(joints).map(j=>[j,[0,0,0]])) as Pose;
export const limitRotation = (joint:Joint,r:Rotation):Rotation => r.map((n,i)=>Math.max(jointLimits[joint][0][i],Math.min(jointLimits[joint][1][i],n))) as Rotation;
export function constrainPose(value:Pose):Pose {
  return Object.fromEntries((Object.keys(joints) as Joint[]).map(j=>[j,limitRotation(j,value[j])])) as Pose;
}
export function mirrorPose(value:Pose):Pose {
  const result=blankPose();
  for(const joint of Object.keys(joints) as Joint[]){
    const other=joint.replace(/^left/,'RIGHT').replace(/^right/,'left').replace(/^RIGHT/,'right') as Joint;
    const [x,y,z]=value[other];result[joint]=[x,-y,-z];
  }
  return constrainPose(result);
}
