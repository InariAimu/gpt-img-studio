import { useEffect, useState } from 'react';
import { Globe, LoaderCircle, RefreshCw, Save } from 'lucide-react';
import { OptionSelect } from './OptionSelect';
import type { NetworkConfig, NetworkState } from './types';
import { desktop, type Studio } from './useStudio';

const defaultSettings: NetworkConfig = { mode: 'system', proxyUrl: '' };

/** Harness Scope's network controls, connected to Studio's serialized settings writes. */
export default function NetworkSettings({ studio }: { studio: Studio }) {
  const saved = studio.document.settings.network ?? defaultSettings;
  const [draft, setDraft] = useState<NetworkConfig>();
  const [state, setState] = useState<NetworkState>();
  const [loadError, setLoadError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(desktop);
  const [busy, setBusy] = useState<'save' | 'test'>();
  const [result, setResult] = useState<{ error: boolean; message: string }>();
  const settings = draft ?? saved;
  const disabled = !!busy || studio.settingsSaving;
  const dirty = settings.mode !== saved.mode || settings.proxyUrl !== saved.proxyUrl;
  const routeInputs = JSON.stringify([saved, studio.document.settings.providers]);

  useEffect(() => {
    if (!desktop || studio.settingsSaving) return;
    let active = true;
    setLoading(true);
    setLoadError('');
    setState(undefined);
    void studio.networkSettings().then(value => {
      if (active) setState(value);
    }).catch(error => {
      if (active) setLoadError(String(error));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [routeInputs, refresh, studio.settingsSaving, studio.networkSettings]);

  function update(patch: Partial<NetworkConfig>) {
    setDraft({ ...settings, ...patch });
    setResult(undefined);
  }

  async function run(action: 'save' | 'test') {
    setBusy(action);
    setResult(undefined);
    try {
      if (action === 'save') {
        const network = { ...settings, proxyUrl: settings.mode === 'manual' ? settings.proxyUrl.trim() : '' };
        await studio.saveSettings({ ...studio.document.settings, network });
        setDraft(undefined);
        studio.notify(desktop ? '网络设置已保存，下次请求生效' : '网络设置已更新，仅用于本次界面预览');
      } else {
        const test = await studio.testNetworkSettings(settings);
        setResult({ error: false, message: `models.dev 连接成功 · ${test.elapsedMs} ms` });
      }
    } catch (error) {
      setResult({ error: true, message: String(error) });
    } finally {
      setBusy(undefined);
    }
  }

  return <section className="settings-section network-settings" aria-labelledby="network-title">
    <div className="settings-section-heading"><Globe /><div><h2 id="network-title">网络</h2><p>统一用于图片生成与下载、Prompt 优化、会话命名和模型列表请求。</p></div></div>
    <label className="field"><span className="field-label">出站连接</span>
      <OptionSelect aria-label="出站连接" disabled={disabled} value={settings.mode} onValueChange={mode => update({ mode: mode as NetworkConfig['mode'], proxyUrl: '' })}>
        <option value="system">跟随系统</option><option value="manual">指定代理</option><option value="direct">直连</option>
      </OptionSelect>
    </label>
    {settings.mode === 'manual' && <label className="field"><span className="field-label">代理地址</span>
      <input aria-label="代理地址" disabled={disabled} value={settings.proxyUrl} onChange={event => update({ proxyUrl: event.target.value })} placeholder="http://127.0.0.1:7890" autoComplete="off" spellCheck={false} />
      <span className="field-help">HTTP / HTTPS / SOCKS5 / SOCKS5H</span>
    </label>}
    <p className="field-help">{settings.mode === 'system'
      ? '优先读取代理环境变量，再读取系统手动代理；保留代理绕过规则。PAC 自动配置请改用指定代理。'
      : settings.mode === 'manual'
        ? '使用无需认证的代理地址；本机回环连接直连。代理不可用时会报错，不会回退直连。'
        : '应用请求不使用代理。'}</p>
    <div className="network-actions">
      <button className="button secondary" disabled={disabled || !desktop || (settings.mode === 'manual' && !settings.proxyUrl.trim())} onClick={() => void run('test')}>
        {busy === 'test' && <LoaderCircle className="spin" />}{busy === 'test' ? '正在测试…' : '测试连接'}
      </button>
      <button className="button primary" disabled={disabled || (settings.mode === 'manual' && !settings.proxyUrl.trim())} onClick={() => void run('save')}>
        {busy === 'save' ? <LoaderCircle className="spin" /> : <Save />}{busy === 'save' ? '正在保存…' : '保存网络设置'}
      </button>
      {dirty && <span className="field-help">有未保存的更改</span>}
    </div>
    {result && <p role={result.error ? 'alert' : 'status'} className={`network-result ${result.error ? 'error' : ''}`}>{result.message}</p>}
    <p className="field-help network-test-help">测试使用当前填写的配置访问 models.dev，不保存设置，也不调用付费模型；连接成功不代表提供商 API 可用。</p>
    <div className="network-routes">
      <div className="network-routes-heading"><h3>已保存配置的连接路径</h3><button className="button ghost small" disabled={!desktop || loading || disabled} onClick={() => setRefresh(value => value + 1)}><RefreshCw className={loading ? 'spin' : ''} />刷新</button></div>
      {!desktop ? <p className="field-help">请在 Windows 桌面版中测试连接和查看实际连接路径。</p>
        : loading ? <p className="field-help" role="status">正在读取连接路径…</p>
          : loadError ? <p className="network-result error" role="alert">读取失败：{loadError}，请点击刷新重试。</p>
            : <dl>{state?.routes.map(route => <div key={route.id}><dt>{route.name}</dt><dd>{!route.configured ? '未配置' : route.invalid ? '目标地址无效' : route.proxy ?? '直连'}</dd></div>)}</dl>}
      <p className="field-help">提供商路径适用于该服务下的所有模型；图片下载按实际下载地址决定路径。保存后对新任务生效，正在进行的任务沿用原配置。</p>
    </div>
  </section>;
}
