export interface ApiErrorInfo {
  schema: 'gpt-img-studio.api-error.v1';
  message: string;
  suggestion: string;
  stage: string;
  raw: string;
  provider?: string; model?: string; endpoint?: string; statusCode?: number | null;
  requestId?: string; responseId?: string; code?: string; errorType?: string;
  param?: string; responseStatus?: string; retryAfter?: string;
}

export function apiErrorInfo(error: unknown): ApiErrorInfo | null {
  let value = error instanceof Error ? error.message : error;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.schema !== 'gpt-img-studio.api-error.v1' || !['message', 'suggestion', 'stage', 'raw'].every(k => typeof v[k] === 'string')) return null;
  // Validate optional fields too: server diagnostics are untrusted data.
  for (const key of ['provider', 'model', 'endpoint', 'requestId', 'responseId', 'code', 'errorType', 'param', 'responseStatus', 'retryAfter']) {
    if (v[key] !== undefined && typeof v[key] !== 'string') return null;
  }
  if (v.statusCode != null && typeof v.statusCode !== 'number') return null;
  return v as unknown as ApiErrorInfo;
}

export function errorSummary(error: unknown): string {
  return apiErrorInfo(error)?.message || (error instanceof Error ? error.message : String(error));
}

export function errorFields(info: ApiErrorInfo): [string, string][] {
  return [
    ['发生阶段', info.stage], ['提供商', info.provider], ['模型', info.model],
    ['请求端点', info.endpoint], ['HTTP 状态', info.statusCode == null ? '' : String(info.statusCode)],
    ['响应状态', info.responseStatus], ['错误码', info.code], ['错误类型', info.errorType],
    ['相关参数', info.param], ['请求 ID', info.requestId], ['响应 ID', info.responseId],
    ['Retry-After', info.retryAfter],
  ].filter((row): row is [string, string] => !!row[1]);
}

export function errorText(info: ApiErrorInfo): string {
  return [info.message, info.suggestion, ...errorFields(info).map(([label, value]) => `${label}：${value}`), '原始错误（已脱敏）：', info.raw].join('\n');
}
