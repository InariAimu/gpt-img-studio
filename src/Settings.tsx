import { useState, type SetStateAction } from 'react';
import { Check, Database, Globe, HardDrive, KeyRound, LoaderCircle, Paintbrush, Plus, Info, ChartNoAxesCombined, X, Server, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import type { ModelProvider, ModelRole, ProviderModel, Settings as SettingsType } from './types';
import type { Studio } from './useStudio';
import { providerSettings, resolvedSettings, textModel } from './modelProviders';
import UsageSettings from './UsageSettings';
import NetworkSettings from './NetworkSettings';
import { OptionSelect } from './OptionSelect';
import { AutoSaveInput } from './AutoSaveInput';
import { desktop } from './useStudio';
import appPackage from '../package.json';

const roles: {id:ModelRole;name:string;description:string}[] = [
  {id:'naming',name:'会话命名模型',description:'概括创作内容，自动生成简短的会话名称'},
  {id:'imageMain',name:'图片主模型',description:'通过 Responses 调用绘图工具，与绘图模型使用同一提供商'},
  {id:'image',name:'默认绘图模型',description:'会话默认使用的绘图模型，可在输入区单独切换'},
  {id:'refine',name:'Prompt 优化模型',description:'用于文字整理和 Prompt 优化；优化建议采用后才会用于生成'},
];
const presets:Record<ModelProvider['kind'],{name:string;baseUrl:string;models:ProviderModel[]}>={
  openai:{name:'OpenAI',baseUrl:'https://api.openai.com/v1',models:[textModel('gpt-6.1-sol'),{...textModel('gpt-image-2.5-sunburst'),kind:'image'}]},
  deepseek:{name:'DeepSeek',baseUrl:'https://api.deepseek.com/v1',models:[textModel('deepseek-v4-flash','chat_completions',false)]},
  opencode:{name:'OpenCode Console',baseUrl:'https://opencode.ai/inference/openai/v1',models:[textModel('gpt-6.1-sol')]},
  custom:{name:'兼容提供商',baseUrl:'https://api.example.com/v1',models:[]},
};
export default function Settings({ studio }: { studio: Studio }) {
  const draft = providerSettings(studio.document.settings);
  const [tab,setTab]=useState<'general'|'providers'|'network'|'usage'|'storage'|'about'>('general');
  const [activeId,setActiveId]=useState(draft.providers[0]?.id||''),[preset,setPreset]=useState<ModelProvider['kind']>('openai'),[fetching,setFetching]=useState(false);
  const [addingModel,setAddingModel]=useState(false);
  const [dataDirectory,setDataDirectory]=useState(studio.dataDir),[relocating,setRelocating]=useState(false);
  const changed=studio.settingsSaving;
  const active=draft.providers.find(p=>p.id===activeId)||draft.providers[0];
  const hasKey=!!active&&!!studio.providerKeys?.[active.id]&&!studio.settingsSaving;
  function persist(next: SettingsType, keys: Record<string,string> = {}) {
    const result=studio.saveSettings(resolvedSettings(next),keys);
    void result.catch(()=>{});
    return result;
  }
  function setDraft(value:SetStateAction<typeof draft>) { return persist(typeof value==='function'?value(draft):value); }
  function updateProvider(patch:Partial<ModelProvider>){return setDraft(previous=>({...previous,providers:previous.providers.map(p=>p.id===active.id?{...p,...patch}:p)}));}
  function updateModel(index:number,patch:Partial<ProviderModel>){return setDraft(previous=>{const p=previous.providers.find(p=>p.id===active.id)!;const old=p.models[index];const next={...previous,providers:previous.providers.map(item=>item.id===p.id?{...item,models:item.models.map((m,i)=>i===index?{...m,...patch}:m)}:item),modelAssignments:{...previous.modelAssignments}};if(patch.id!==undefined)for(const role of roles)if(next.modelAssignments[role.id].providerId===p.id&&next.modelAssignments[role.id].modelId===old.id)next.modelAssignments[role.id]={providerId:p.id,modelId:patch.id};return next;});}
  function assign(role:ModelRole,value:string){const [providerId,modelId]=JSON.parse(value) as [string,string];setDraft(previous=>{const assignments={...previous.modelAssignments,[role]:{providerId,modelId}};if(role==='image'&&previous.generation.apiMode==='responses'){const p=previous.providers.find(p=>p.id===providerId)!;const current=assignments.imageMain;const match=p.models.find(m=>m.id===current.modelId&&m.kind==='text'&&m.protocol==='responses')||p.models.find(m=>m.kind==='text'&&m.protocol==='responses');if(match)assignments.imageMain={providerId,modelId:match.id};}return {...previous,modelAssignments:assignments};});}
  function isAssigned(modelId:string){return roles.some(r=>draft.modelAssignments[r.id].providerId===active.id&&draft.modelAssignments[r.id].modelId===modelId);}
  function addProvider(){const id=`provider-${crypto.randomUUID().slice(0,12)}`;const p:ModelProvider={id,kind:preset,...structuredClone(presets[preset])};setDraft(previous=>({...previous,providers:[...previous.providers,p]}));setActiveId(id);}
  async function fetchModels(){setFetching(true);try{const ids=await studio.listModels(active.id);const existing=new Set(active.models.map(m=>m.id));const added=ids.filter(id=>!existing.has(id)).map(id=>({...textModel(id,active.kind==='deepseek'?'chat_completions':'responses',active.kind!=='deepseek'),kind:/gpt-image|dall-e/i.test(id)?'image' as const:'text' as const}));updateProvider({models:[...active.models,...added]});studio.notify(`已添加 ${added.length} 个模型，请确认协议和图片输入能力`);}catch(error){studio.report(error);}finally{setFetching(false);}}
  async function moveData(){setRelocating(true);try{await studio.relocateData(dataDirectory);}catch(error){setRelocating(false);studio.report(error);}}
  function options(role:ModelRole){return draft.providers.map(p=>{const models=p.models.filter(m=>m.kind===(role==='image'?'image':'text')&&(role!=='imageMain'||draft.generation.apiMode!=='responses'||(m.protocol==='responses'&&p.id===draft.modelAssignments.image.providerId)));return models.length?<optgroup key={p.id} label={p.name}>{models.map(m=><option key={m.id} value={JSON.stringify([p.id,m.id])}>{m.name||m.id} · {p.name}</option>)}</optgroup>:null;});}
  return <>
    <header className="page-header"><div><div className="page-eyebrow">按你的习惯创作</div><h1>设置</h1></div></header>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">{([['general','通用',Sparkles],['providers','模型提供商',Server],['network','网络',Globe],['usage','用量统计',ChartNoAxesCombined],['storage','数据与存储',HardDrive],['about','关于',Info]] as const).map(([id,label,Icon])=><button key={id} className={tab===id?'active':''} aria-current={tab===id?'page':undefined} onClick={()=>setTab(id)}><Icon/>{label}</button>)}</nav>
    <div className="settings-scroll"><div className={`settings-content ${tab==='providers'?'provider-settings-content':tab==='about'?'about-settings-content':''}`}>
      {(tab!=='about'||studio.settingsSaving||studio.settingsError)&&<p role="status" className={`settings-save-status ${studio.settingsError?'error':''}`}>{studio.settingsSaving?'正在保存…':studio.settingsError?`保存失败，已恢复上次有效设置：${studio.settingsError}`:desktop?(tab==='network'?'网络设置需点击保存，对后续新任务生效。':'更改即时生效并自动保存；文字输入在回车或离开输入框时保存。'):'浏览器预览：更改即时显示，不写入本地设置。'}</p>}
      {studio.storageNotice&&<div className="generation-error">{studio.storageNotice}</div>}
      {tab==='general'&&<section className="settings-section default-models"><div className="settings-section-heading"><Sparkles/><div><h2>默认模型</h2><p>为不同任务选择合适的模型，可使用不同提供商。</p></div></div>
        {roles.map(role=>{const selected=draft.modelAssignments[role.id];return <div className="model-assignment" key={role.id}><div><strong>{role.name}</strong><p>{role.description}</p></div><OptionSelect aria-label={role.name} disabled={role.id==='imageMain'&&draft.generation.apiMode==='images'} value={JSON.stringify([selected.providerId,selected.modelId])} onValueChange={value=>assign(role.id,value)}>{options(role.id)}</OptionSelect></div>;})}
        <div className="model-assignment"><div><strong>图像调用方式</strong><p>Responses 支持连续编辑；Images 使用单次生成或图片编辑接口。</p></div><OptionSelect aria-label="图像调用方式" value={draft.generation.apiMode} onValueChange={value=>setDraft({...draft,generation:{...draft.generation,apiMode:value as 'responses'|'images'}})}><option value="responses">Responses API · 支持多轮</option><option value="images">Images API</option></OptionSelect></div>
        <label className="checkbox-label auto-name-setting"><input type="checkbox" checked={draft.autoNameSessions!==false} onChange={e=>setDraft({...draft,autoNameSessions:e.target.checked})}/>首张图片成功后，自动命名默认名称的会话</label><div className="field-help">手动命名的会话不会被自动覆盖。</div>
      </section>}
      {tab==='providers'&&<div className="provider-settings"><aside className="provider-list"><div className="provider-add"><OptionSelect aria-label="新增提供商类型" value={preset} onValueChange={value=>setPreset(value as ModelProvider['kind'])}>{Object.entries(presets).map(([id,p])=><option key={id} value={id}>{p.name}</option>)}</OptionSelect><button className="icon-button" aria-label="新增模型提供商" onClick={addProvider}><Plus/></button></div>{draft.providers.map(p=><button key={p.id} className={p.id===active.id?'active':''} onClick={()=>setActiveId(p.id)}><span className="provider-symbol">{p.name.slice(0,1)}</span><span>{p.name}<small>{p.models.length} 个模型</small></span>{studio.providerKeys?.[p.id]&&studio.document.settings.providers?.find(saved=>saved.id===p.id)?.baseUrl===p.baseUrl&&<span className="status-dot"/>}</button>)}</aside>
        {active&&<section className="provider-editor"><div className="settings-section-heading"><Server/><div><h2>{active.name}</h2><p>OpenAI 兼容服务，模型协议与图片输入能力可分别设置。</p></div><button className="icon-button" aria-label="删除当前提供商" disabled={roles.some(r=>draft.modelAssignments[r.id].providerId===active.id)} title="使用中的提供商需先切换默认模型" onClick={()=>{setDraft({...draft,providers:draft.providers.filter(p=>p.id!==active.id)});setActiveId(draft.providers.find(p=>p.id!==active.id)?.id||'');}}><Trash2/></button></div>
          <div className="form-columns"><label className="field"><span className="field-label">提供商名称</span><AutoSaveInput aria-label="提供商名称" value={active.name} onCommit={value=>updateProvider({name:value})}/></label><label className="field"><span className="field-label">提供商类型</span><OptionSelect aria-label="提供商类型" value={active.kind} onValueChange={value=>updateProvider({kind:value as ModelProvider['kind']})}>{Object.entries(presets).map(([id,p])=><option key={id} value={id}>{p.name}</option>)}</OptionSelect></label></div>
          <label className="field"><span className="field-label">Base URL</span><AutoSaveInput aria-label="提供商 Base URL" type="url" value={active.baseUrl} onCommit={value=>updateProvider({baseUrl:value})}/></label>
          <label className="field"><span className="field-label"><KeyRound size={12}/>API Key{hasKey&&<span className="key-saved"><Check size={12}/>已保存</span>}</span><AutoSaveInput aria-label="提供商 API Key" type="password" autoComplete="new-password" spellCheck={false} value="" onCommit={value=>value.trim()?persist(draft,{[active.id]:value}):Promise.resolve()} placeholder={hasKey?'已安全保存，留空保持现有密钥':'输入此提供商的 API Key'}/></label><p className="field-help provider-key-note"><ShieldCheck size={12}/>密钥保存在 Windows 凭据管理器，并绑定提供商与服务地址。</p>
          <div className="provider-model-heading"><h3>模型列表</h3><div><button className="button secondary small" disabled={changed||!hasKey||fetching} title="获取此提供商的模型列表" onClick={()=>void fetchModels()}>{fetching?<LoaderCircle className="spin"/>:<DownloadIcon/>}获取模型</button><button className="button secondary small" onClick={()=>setAddingModel(true)}><Plus/>添加模型</button></div></div>
          {addingModel&&<div className="provider-model new-model"><label className="field"><span className="field-label">新模型 ID</span><AutoSaveInput autoFocus aria-label="新模型 ID" value="" placeholder="输入模型 ID 后回车或移开焦点" onCommit={async value=>{if(!value.trim())return;await updateProvider({models:[...active.models,textModel(value.trim(),active.kind==='deepseek'?'chat_completions':'responses',active.kind!=='deepseek')]});setAddingModel(false);}}/></label><button className="icon-button" aria-label="取消添加模型" onPointerDown={event=>event.preventDefault()} onClick={()=>setAddingModel(false)}><X/></button></div>}
          {active.models.map((model,index)=><article className="provider-model" key={index}><div className="provider-model-top"><AutoSaveInput aria-label={`模型 ID ${index+1}`} value={model.id} placeholder="模型 ID" onCommit={value=>updateModel(index,{id:value.trim()})}/><AutoSaveInput aria-label={`模型显示名称 ${index+1}`} value={model.name} placeholder="显示名称" onCommit={value=>updateModel(index,{name:value})}/><button className="icon-button" aria-label={`移除模型 ${index+1}`} disabled={isAssigned(model.id)} onClick={()=>updateProvider({models:active.models.filter((_,i)=>i!==index)})}><Trash2/></button></div><div className="provider-model-options"><OptionSelect aria-label={`模型类型 ${index+1}`} disabled={isAssigned(model.id)} value={model.kind} onValueChange={value=>updateModel(index,{kind:value as ProviderModel['kind']})}><option value="text">语言模型</option><option value="image">绘图模型</option></OptionSelect>{model.kind==='text'&&<><OptionSelect aria-label={`模型协议 ${index+1}`} value={model.protocol} onValueChange={value=>updateModel(index,{protocol:value as ProviderModel['protocol']})}><option value="responses">Responses</option><option value="chat_completions">Chat Completions</option></OptionSelect><label><input type="checkbox" checked={model.vision} onChange={e=>updateModel(index,{vision:e.target.checked})}/>图片输入</label></>}</div><details className="model-pricing"><summary>自定义费率 · USD / 百万 token</summary><p>留空使用已收录的 OpenAI 标准参考价；自定义后，未填写的费率按未知处理。</p><div className="model-price-fields">{(model.kind==='image'?[['input','文本输入'],['cachedInput','缓存文本'],['imageInput','图像输入'],['cachedImageInput','缓存图像'],['output','图像输出']]:[['input','输入'],['cachedInput','缓存读取'],['output','输出'],['cacheWrite','缓存写入']]).map(([key,label])=><label key={key}><span>{label}</span><AutoSaveInput aria-label={`${model.id} ${label}费率`} inputMode="decimal" placeholder="参考价 / 未知" value={model.pricing?.[key as keyof NonNullable<ProviderModel['pricing']>]||''} onCommit={value=>updateModel(index,{pricing:{...model.pricing,[key]:value}})}/></label>)}</div></details></article>)}
        </section>}
      </div>}
      {tab==='usage'&&<UsageSettings studio={studio}/>}
      {tab==='network'&&<NetworkSettings studio={studio}/>}
      {tab==='general'&&<section className="settings-section"><div className="settings-section-heading"><Paintbrush/><div><h2>界面外观</h2><p>浅色、深色或跟随系统。</p></div></div><div className="form-columns"><label className="field"><span className="field-label">主题</span><OptionSelect value={draft.theme} onValueChange={value=>setDraft({...draft,theme:value as SettingsType['theme']})}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></OptionSelect></label><label className="field"><span className="field-label">强调色</span><div className="accent-options">{['#f97316','#3b82f6','#10b981','#8b5cf6','#e85b73'].map(color=><button key={color} style={{background:color}} className={draft.accent===color?'selected':''} aria-label={`强调色 ${color}`} onClick={()=>setDraft({...draft,accent:color})}>{draft.accent===color&&<Check size={13}/>}</button>)}</div></label></div></section>}
      {tab==='storage'&&<section className="settings-section"><div className="settings-section-heading"><HardDrive/><div><h2>图库与存储</h2><p>原图、预览和创作记录保存在本机。</p></div></div><div className="storage-row"><Database/><div><strong>本地图库</strong><p className="data-directory">{studio.dataDir||'Windows 桌面版启动后显示'}</p></div><span className="subtle-badge">SQLite</span></div><div className="storage-location"><label className="field"><span className="field-label">数据目录</span><div className="storage-location-input"><input aria-label="本地数据目录" value={dataDirectory} onChange={e=>setDataDirectory(e.target.value)} disabled={relocating}/><button className="button secondary small" disabled={relocating} onClick={()=>void studio.chooseDataDirectory().then(path=>{if(typeof path==='string')setDataDirectory(path);}).catch(studio.report)}>选择目录</button></div></label><div className="storage-location-footer"><p>迁移数据库、原图、预览和用量日志。请使用空目录；校验完成后自动重启。</p><button className="button secondary small" disabled={changed||relocating||!dataDirectory.trim()||dataDirectory===studio.dataDir} title={changed?'正在保存设置…':undefined} onClick={()=>void moveData()}>{relocating?<LoaderCircle className="spin"/>:<HardDrive/>}{relocating?'正在迁移…':'迁移数据并重启'}</button></div></div></section>}
      {tab==='about'&&<section className="settings-section settings-about" aria-labelledby="about-app-title">
        <h2 id="about-app-title">GPT Image Studio</h2>
        <p className="about-version">v{appPackage.version} · {appPackage.license}</p>
        <dl className="about-details">{[
          ['构建类型',import.meta.env.DEV?'开发构建':'正式版'],
          ['运行环境',desktop?'Windows 桌面版':'浏览器预览'],
          ['数据格式',`v${studio.document.schemaVersion}`],
          ['数据目录',studio.dataDir||'在 Windows 桌面版中显示'],
        ].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <p className="about-description">本地图片生成与实验工作台。</p>
        <p className="about-note">基于 Tauri 2、React 与 TypeScript，支持工作区、参考图和多轮图片编辑。</p>
      </section>}
    </div></div></div>
  </>;
}
function DownloadIcon(){return <span aria-hidden="true">↓</span>;}
