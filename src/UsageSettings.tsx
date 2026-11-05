import { useEffect, useState } from 'react';
import { Copy, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import type { Studio } from './useStudio';
import type { UsageSummary } from './types';

const operationName: Record<string,string> = { image:'图像生成',refine:'Prompt 优化',structure:'Prompt 整理',naming:'会话命名' };
const tokens = (value:number|null) => value===null?'未知':value.toLocaleString();
export default function UsageSettings({studio}:{studio:Studio}) {
  const [data,setData]=useState<UsageSummary|null>(null),[loading,setLoading]=useState(false);
  async function refresh(){setLoading(true);try{setData(await studio.usageRecords());}catch(error){studio.report(error);}finally{setLoading(false);}}
  useEffect(()=>{void refresh();},[]);
  return <div className="usage-settings"><div className="settings-section-heading"><div><h2>用量与费用估算</h2><p>按模型统计实际 Token 和参考费用；保留原始请求明细。</p></div><div className="usage-actions"><button className="button secondary small" disabled={loading} onClick={()=>void refresh()}>{loading?<LoaderCircle className="spin"/>:<RefreshCw/>}刷新</button><button className="button secondary small" onClick={()=>void studio.exportUsage().catch(studio.report)}><Download/>导出原始请求 JSONL</button></div></div>
    <div className="usage-summary"><div><span>模型用量记录</span><strong>{data?.totalModelUsages??'—'}</strong></div><div><span>已知请求参考估算 · USD</span><strong>{data?`$${Number(data.knownEstimatedCostUsd).toFixed(6)}`:'—'}</strong></div><div><span>费用不完整的请求</span><strong>{data?.unpricedRequests??'—'}</strong></div></div>
    <div className="usage-explanation">费用按每条记录当时的费率估算，历史价格快照保持不变。缓存命中、未知价格和服务端未提供的用量会单独标记；实际账单以提供商结算为准。模型用量记录数不等于 HTTP 请求次数或图片张数。升级前未保存 usage 的历史请求不会补算。</div>
    {data && <div className="usage-path"><span>Harness Scope 模型用量日志</span><code>{data.modelJournalPath}</code><button className="icon-button" aria-label="复制用量日志路径" onClick={()=>void navigator.clipboard.writeText(data.modelJournalPath).then(()=>studio.notify('已复制日志路径')).catch(studio.report)}><Copy/></button></div>}
    <div className="usage-list">{data?.records.map(record=><details className="usage-row" key={record.id}><summary><span className="usage-operation">{operationName[record.operation]||record.operation}<small>{new Date(record.occurredAt*1000).toLocaleString()}</small></span><span className="usage-model">{record.model}<small>{record.provider.name}</small></span><span className={`usage-cost ${record.estimatedCostUsd===null?'muted':''}`}>{record.estimatedCostUsd===null?'用量 / 价格不完整':`≈ $${Number(record.estimatedCostUsd).toFixed(6)}`}<small>{record.estimateStatus==='upper_bound'?'缓存命中量未知':record.statusCode===null?'未收到响应':`HTTP ${record.statusCode}`}</small></span></summary><div className="usage-components">{record.components.map((c,index)=><div className="usage-component" key={index}><div><strong>{c.kind==='image'?'图像工具':'语言模型'} · {c.model}</strong><span>{c.estimatedCostUsd===null?'费用未知':`≈ $${Number(c.estimatedCostUsd).toFixed(6)}`}</span></div><dl><dt>输入总量</dt><dd>{tokens(c.tokens.totalInput)}</dd><dt>输出总量</dt><dd>{tokens(c.tokens.output)}</dd><dt>缓存读取</dt><dd>{tokens(c.tokens.cacheRead)}</dd><dt>缓存写入</dt><dd>{tokens(c.tokens.cacheWrite)}</dd><dt>推理输出（已含在输出中）</dt><dd>{tokens(c.tokens.reasoning)}</dd></dl><details className="usage-raw"><summary>原始 usage</summary><pre>{JSON.stringify(c.rawUsage,null,2)}</pre></details></div>)}</div></details>)}{data&&!data.records.length&&<div className="usage-empty">尚无用量记录。下一次生成、优化或命名请求后会出现在这里。</div>}</div>
  </div>;
}
