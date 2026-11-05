import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Images, LoaderCircle, Save, ShieldCheck, Tags } from 'lucide-react';
import { OptionSelect } from './OptionSelect';
import { desktop, type Studio } from './useStudio';

interface GalleryConfig {
  apiUrl: string; username: string; direct: boolean;
  uploadMode: 'manual' | 'afterGeneration'; safety: 'safe' | 'sketchy' | 'unsafe';
  defaultTags: string[]; includePrompt: boolean; includeGeneration: boolean;
}
interface GalleryState { config: GalleryConfig; hasToken: boolean }
const defaults: GalleryConfig = {
  apiUrl: '', username: '', direct: true, uploadMode: 'manual', safety: 'sketchy',
  defaultTags: [], includePrompt: true, includeGeneration: true,
};
const splitTags = (value: string) => [...new Set(value.split(/[\s,，]+/u).filter(Boolean))];

export default function GallerySettings({ studio }: { studio: Studio }) {
  const [saved, setSaved] = useState<GalleryState>();
  const [config, setConfig] = useState(defaults);
  const [tags, setTags] = useState('');
  const [token, setToken] = useState('');
  const [forgetToken, setForgetToken] = useState(false);
  const [loading, setLoading] = useState(desktop);
  const [loadError, setLoadError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState<'save' | 'test'>();
  const [result, setResult] = useState<{ error: boolean; message: string }>();
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    setLoading(true); setLoadError('');
    void invoke<GalleryState>('gallery_settings').then(value => {
      if (!active) return;
      setSaved(value); setConfig(value.config); setTags(value.config.defaultTags.join(' '));
    }).catch(error => { if (active) setLoadError(String(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]);
  const disabled = loading || !!busy || (desktop && !saved);
  const sameAccount = !!saved && config.apiUrl.trim().replace(/\/+$/, '') === saved.config.apiUrl && config.username.trim() === saved.config.username;
  const hasToken = sameAccount && saved.hasToken;
  const current = { ...config, defaultTags: splitTags(tags) };
  const dirty = !!token || forgetToken || JSON.stringify(current) !== JSON.stringify(saved?.config ?? defaults);
  function update(patch: Partial<GalleryConfig>) {
    setConfig(previous => ({ ...previous, ...patch })); setResult(undefined);
    if ('apiUrl' in patch || 'username' in patch) { setToken(''); setForgetToken(false); }
  }
  async function run(action: 'save' | 'test') {
    setBusy(action); setResult(undefined);
    try {
      if (action === 'save') {
        const next = desktop
          ? await invoke<GalleryState>('save_gallery_settings', { config: current, token: token.trim() || null, forgetToken })
          : { config: current, hasToken: false };
        setSaved(next); setConfig(next.config); setTags(next.config.defaultTags.join(' ')); setToken(''); setForgetToken(false);
        studio.notify(desktop ? '图库配置已保存；尚未启用上传' : '图库配置已更新，仅用于本次界面预览');
      } else {
        const test = await invoke<{ authenticated: boolean; rank: string | null; elapsedMs: number }>('test_gallery_settings', { config: current, token: token.trim() || null });
        setResult({ error: false, message: test.authenticated
          ? `连接成功，账号 ${config.username.trim()} 已验证 · ${test.elapsedMs} ms`
          : `服务可达 · ${test.elapsedMs} ms；未填写令牌，尚未验证账号和上传权限。` });
      }
    } catch (error) { setResult({ error: true, message: String(error) }); }
    finally { setBusy(undefined); }
  }
  return <section className="settings-section gallery-settings" aria-labelledby="gallery-settings-title">
    <div className="settings-section-heading"><Images /><div><h2 id="gallery-settings-title">szurubooru 图库</h2><p>将展示图库与 Studio 的本地创作记录分开管理。</p></div></div>
    <p className="gallery-config-notice">当前仅保存配置，不会上传图片；选择自动上传也不会立即启用。</p>
    {loading && <p role="status" className="field-help">正在读取图库配置…</p>}
    {loadError && <div role="alert" className="network-result error">读取失败：{loadError}<button className="button ghost small" onClick={() => setRefresh(n => n + 1)}>重新读取</button></div>}
    <fieldset disabled={disabled} className="gallery-fields">
      <label className="field"><span className="field-label">szurubooru API 地址</span><input aria-label="szurubooru API 地址" value={config.apiUrl} type="url" autoComplete="off" spellCheck={false} placeholder="https://booru.example.com/api" onChange={e => update({ apiUrl: e.target.value })} /></label>
      <p className="field-help">填写图库网址加 /api，支持端口和子路径；不是 NAS 文件夹路径。图片将由图库服务管理。</p>
      <div className="form-columns">
        <label className="field"><span className="field-label">图库用户名</span><input aria-label="图库用户名" value={config.username} autoComplete="off" spellCheck={false} onChange={e => update({ username: e.target.value })} /></label>
        <label className="field"><span className="field-label">API Token{hasToken && !forgetToken && <span className="key-saved">已保存</span>}</span><input aria-label="图库 API Token" value={token} type="password" disabled={forgetToken} autoComplete="new-password" spellCheck={false} placeholder={hasToken && !forgetToken ? '留空保持现有令牌' : '从图库账号设置中创建令牌'} onChange={e => { setToken(e.target.value); setResult(undefined); }} /></label>
      </div>
      <p className="field-help provider-key-note"><ShieldCheck size={12} />令牌存入 Windows 凭据管理器，不写入创作数据库或同步到其他电脑。更换地址或用户名后需重新填写。</p>
      {hasToken && <label className="checkbox-label"><input type="checkbox" checked={forgetToken} onChange={e => { setForgetToken(e.target.checked); setToken(''); setResult(undefined); }} />保存时清除此账号的已存令牌</label>}
      <label className="checkbox-label"><input type="checkbox" checked={config.direct} onChange={e => update({ direct: e.target.checked })} />直连图库（关闭后使用应用的网络设置）</label>
      <div className="gallery-preferences">
        <h3>上传偏好</h3>
        <div className="form-columns">
          <label className="field"><span className="field-label">上传时机（预设）</span><OptionSelect aria-label="图库上传时机" disabled={disabled} value={config.uploadMode} onValueChange={v => update({ uploadMode: v as GalleryConfig['uploadMode'] })}><option value="manual">手动选择图片</option><option value="afterGeneration">生成完成后自动上传</option></OptionSelect></label>
          <label className="field"><span className="field-label">默认内容分级</span><OptionSelect aria-label="图库默认内容分级" disabled={disabled} value={config.safety} onValueChange={v => update({ safety: v as GalleryConfig['safety'] })}><option value="sketchy">可能敏感 · Sketchy</option><option value="safe">安全 · Safe</option><option value="unsafe">敏感 · Unsafe</option></OptionSelect></label>
        </div>
        <p className="field-help">上传偏好供后续接入使用；默认发送原图，保留本机文件。</p>
        <h3><Tags size={15} />标签与附带信息</h3>
        <label className="field"><span className="field-label">默认标签</span><input aria-label="图库默认标签" value={tags} spellCheck={false} placeholder="例如：ai_generated studio" onChange={e => { setTags(e.target.value); setResult(undefined); }} /></label>
        <p className="field-help">用空格或逗号分隔，标签内使用下划线；重复标签会合并。暂不自动读图生成标签。</p>
        <label className="checkbox-label"><input type="checkbox" checked={config.includePrompt} onChange={e => update({ includePrompt: e.target.checked })} />附带 Prompt（作为帖子评论）</label>
        <label className="checkbox-label"><input type="checkbox" checked={config.includeGeneration} onChange={e => update({ includeGeneration: e.target.checked })} />附带模型、尺寸和质量参数</label>
      </div>
    </fieldset>
    <div className="network-actions">
      <button className="button secondary" disabled={disabled || !desktop || !config.apiUrl.trim() || forgetToken} onClick={() => void run('test')}>{busy === 'test' && <LoaderCircle className="spin" />}{busy === 'test' ? '正在测试…' : '测试图库连接'}</button>
      <button className="button primary" disabled={disabled || !dirty} onClick={() => void run('save')}>{busy === 'save' ? <LoaderCircle className="spin" /> : <Save />}{busy === 'save' ? '正在保存…' : '保存图库配置'}</button>
      {dirty && <span className="field-help">有未保存的更改</span>}
    </div>
    {result && <p role={result.error ? 'alert' : 'status'} className={`network-result ${result.error ? 'error' : ''}`}>{result.message}</p>}
    <p className="field-help network-test-help">测试使用当前填写的配置，仅访问服务信息和账号；不会保存配置、上传图片或调用模型。没有填写或保存令牌时只检查服务可达性。</p>
  </section>;
}
