import test from 'node:test';
import assert from 'node:assert/strict';
import { apiErrorInfo, errorSummary, errorText } from '../src/apiErrors.ts';

const error = { schema: 'gpt-img-studio.api-error.v1', message: '服务限流', suggestion: '稍后重试', stage: '服务返回', raw: '{"error":{"code":"rate_limit_exceeded"}}', statusCode: 429, requestId: 'req-demo', retryAfter: '30' };
test('diagnostics survive string IPC/storage and retain copyable original errors', () => {
  const decoded = apiErrorInfo(JSON.stringify(error));
  assert.deepEqual(decoded, error);
  assert.equal(errorSummary(new Error(JSON.stringify(error))), '服务限流');
  assert.match(errorText(decoded), /HTTP 状态：429/);
  assert.match(errorText(decoded), /请求 ID：req-demo/);
  assert.match(errorText(decoded), /Retry-After：30/);
  assert.match(errorText(decoded), /rate_limit_exceeded/);
});
test('legacy errors remain readable and malformed diagnostic fields are rejected', () => {
  assert.equal(errorSummary('旧的错误信息'), '旧的错误信息');
  for (const value of [null, '{', {}, { ...error, raw: null }, { ...error, requestId: {} }]) assert.equal(apiErrorInfo(value), null);
});
