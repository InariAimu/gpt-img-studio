import type { ModelProvider, ModelRole, ProviderModel, Settings } from './types';

export const textModel = (id: string, protocol: ProviderModel['protocol'] = 'responses', vision = true): ProviderModel => ({ id, name:id, kind:'text', protocol, vision });
export function providerSettings(settings: Settings): Settings & { providers: ModelProvider[]; modelAssignments: NonNullable<Settings['modelAssignments']> } {
  if (settings.providers && settings.modelAssignments) return settings as ReturnType<typeof providerSettings>;
  const { generation:g, refine:r } = settings;
  const models:ProviderModel[]=[{ ...textModel(g.model),kind:'image' },textModel(g.mainModel)];
  if(r.useImageConnection && !models.some(m=>m.id===r.model)) models.push(textModel(r.model));
  const providers:ModelProvider[]=[{id:'legacy-image',name:'现有图像服务',kind:'custom',baseUrl:g.baseUrl,models}];
  if(!r.useImageConnection) providers.push({id:'legacy-refine',name:'现有文本服务',kind:'custom',baseUrl:r.baseUrl,models:[textModel(r.model)]});
  const textProvider=r.useImageConnection?'legacy-image':'legacy-refine';
  return {...settings,providers,modelAssignments:{image:{providerId:'legacy-image',modelId:g.model},imageMain:{providerId:'legacy-image',modelId:g.mainModel},refine:{providerId:textProvider,modelId:r.model},naming:{providerId:textProvider,modelId:r.model}}};
}
export function roleModel(settings: Settings, role: ModelRole) {
  const s=providerSettings(settings), selection=s.modelAssignments[role];
  const provider=s.providers.find(p=>p.id===selection.providerId);
  return {provider,model:provider?.models.find(m=>m.id===selection.modelId)};
}
