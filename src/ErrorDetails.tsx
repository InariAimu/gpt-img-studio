import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { apiErrorInfo, errorFields, errorSummary, errorText } from './apiErrors';

export default function ErrorDetails({ error }: { error: unknown }) {
  const info = apiErrorInfo(error);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  if (!info) return <p className="job-error">{errorSummary(error)}</p>;
  async function copy() {
    if (!info) return;
    try { await navigator.clipboard.writeText(errorText(info)); setCopied(true); setCopyError(''); window.setTimeout(() => setCopied(false), 1600); }
    catch { setCopyError('复制失败，请选择下方原始错误手动复制。'); }
  }
  return <div className="api-error">
    <p className="api-error-message">{info.message}</p><p className="api-error-suggestion">{info.suggestion}</p>
    <details className="api-error-details"><summary>查看原始错误与诊断信息</summary>
      <dl>{errorFields(info).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <div className="api-error-raw-heading"><span>原始错误（已脱敏）</span><button type="button" className="button secondary small" onClick={() => void copy()}>{copied ? <Check /> : <Copy />}{copied ? '已复制' : '复制错误详情'}</button></div>
      <pre>{info.raw || '服务未提供原始错误内容。'}</pre>{copyError && <p role="status">{copyError}</p>}
    </details>
  </div>;
}
