# Usage 日志与 harness-scope 接入契约 v1

更新日期：2026-11-03。本次实现生产端日志与计价；harness-scope 接收端后续适配。它是独立来源格式，不可直接作为 harness-scope 的 `UsageRecord` 同步载荷。

## 存储与采集

- 应用数据目录的 `studio.sqlite3 / usage_events` 是权威记录，主键为请求 UUID。
- 同目录 `usage/usage.jsonl` 是可采集镜像，UTF-8，一行一个完整事件。启动时从 SQLite 重建，修复中断写入。设置页支持导出完整 JSONL。
- 数据目录可配置；采集器应使用设置页显示的实际日志路径，不能固定假设位于 AppData。
- 镜像可能被整体替换，不能只依赖文件偏移量；以 `(deviceId, id)` 去重。末尾不完整行应延后读取。
- 请求种类：`image`、`refine`、`structure`、`naming`。其中 `structure` 为纯文字 Prompt 整理。模型列表查询不计为计费调用。
- 不包含 Prompt、图片数据、原始请求体、API Key 或本地素材路径。
- 升级前未保存 usage 的历史调用不补造 token 或费用。

## 事件

```json
{
  "schema": "gpt-img-studio.usage",
  "schemaVersion": 1,
  "id": "local-request-uuid",
  "harness": "gpt-img-studio",
  "deviceId": "installation-uuid",
  "sessionId": "session-uuid",
  "operation": "image",
  "provider": {"id": "provider-uuid", "name": "My OpenAI", "kind": "openai"},
  "model": "gpt-6.1-sol",
  "protocol": "responses",
  "occurredAt": 1793664000,
  "startedAt": "2026-11-03T00:00:00Z",
  "finishedAt": "2026-11-03T00:01:00Z",
  "durationMs": 60000,
  "requestCount": 1,
  "statusCode": 200,
  "responseId": "resp_example",
  "components": [],
  "rawUsage": {},
  "rawToolUsage": {},
  "estimatedCostUsd": null,
  "knownComponentCostUsd": "0",
  "estimateStatus": "incomplete",
  "currency": "USD"
}
```

`occurredAt` 为 UTC Unix 秒。`id` 区分实际调用，`responseId` / `serverRequestId` 保存服务返回的标识；网关可能重用服务 ID，不能代替本地主键。`responseModel`、`serviceTier` 保留提供商报告值。`model` 是请求选择的模型 ID；价格来源与适用范围在每个组件的快照中。

一次 HTTP 请求只产生一个事件，`requestCount=1`。Responses 生图通常包含一个语言组件和一个图像工具组件；工具组件不增加请求数。命名、Refine 是独立的 HTTP 调用，分别计数。失败或未收到响应的调用可以有记录，但未知用量和费用不等于零。

## 计费组成部分

每个 `components[]` 包含：

| 字段 | 含义 |
| --- | --- |
| `kind`, `model` | `language` 或 `image`，以及该部分的模型 |
| `usageAvailable` | 输入、输出总量是否均由服务报告 |
| `tokens.totalInput`, `tokens.output` | 含缓存的输入总量、含推理的输出总量 |
| `tokens.input` | 已知的非缓存输入；缓存拆分未知时为 null |
| `tokens.cacheRead`, `tokens.cacheWrite` | 缓存读取、写入；未知不填 0 |
| `tokens.reasoning` | 输出总量中的子集，不能再次加到输出或费用 |
| `tokens.total` | 该模型输入总量 + 输出总量，不再次叠加缓存或推理 |
| `textInputTokens`, `imageInputTokens` | 图像模型的模态拆分，缺失时为 null |
| `cacheBreakdownKnown` | 能否确认缓存拆分 |
| `rawUsage` | 该组成部分的原始 usage，不包含图片结果 |
| `pricingSnapshot` | 当次使用的十进制费率、日期、来源、适用档位 |
| `estimatedCostUsd` | 十进制字符串；无法计价为 null |
| `estimateStatus` | `estimated`、`upper_bound` 或 `unknown` |

Responses 主模型读取顶层 `usage`。图像工具优先读取顶层 `tool_usage.image_gen`，否则读取各 `output[].image_generation_call.usage`；两种来源不能相加。官方提示聚合工具 usage 也可能跳过不完整记录，因此估算不能用来对账确认最终收费。

缓存写入兼容 `input_tokens_details.cache_write_tokens` 与 `prompt_tokens_details.cache_write_tokens`。`cacheWriteApplicable` 表示该费率模型是否单独计费缓存写入；适用但服务未报告写入量时，总费用保持未知。

Images API 的 `usage` 直接作为图像组件，不能再制造一个主模型组件。Chat Completions 同时兼容 `prompt_tokens` / `completion_tokens`、OpenAI 缓存详情和 DeepSeek 的 `prompt_cache_hit_tokens`。

## 价格与计算

[OpenAI 定价](https://developers.openai.com/api/docs/pricing)及 [GPT Image 2.5 说明](https://developers.openai.com/api/docs/guides/image-generation#cost-and-latency)，Standard、每百万 token 的 USD 参考价：

| GPT Image 2.5 Sunburst / Flare | USD / 1M |
| --- | ---: |
| 文本输入 | 5 |
| 缓存文本输入 | 1.25 |
| 图像输入 | 8 |
| 缓存图像输入 | 2 |
| 图像输出 | 30 |

图像成本为各模态的非缓存输入、缓存输入和输出按各自费率相加。缓存优惠只适用于 Responses 图像工具，直接 Images API 按非缓存输入计价。Responses 缓存拆分未返回时，按输入全未缓存估算，标记 `upper_bound`；它只表示所用参考费率内的缓存假设，不是第三方实际账单上限。缺少模态拆分时保持未知，不能从图片尺寸或质量反推实际 token。旧版 GPT Image 2 计算器不能代替 2.5 usage。

普通 LLM：`(非缓存输入 × 输入价 + 缓存读取 × 读取价 + 缓存写入 × 写入价 + 输出总量 × 输出价) / 1,000,000`。推理 token 已计入输出。

内置 GPT-6.1 Sol 的 Standard 参考价为输入 2、缓存读取 0.1、缓存写入 2.5、输出 10；超过 272K 输入时，输入和缓存费率乘 2，输出乘 1.5。[模型说明](https://developers.openai.com/api/docs/models/gpt-6.1-sol)。未知服务档位保持未计价。其他提供商可在模型设置中填写 USD / 百万 token 的自定义费率；缺失的自定义费率保持未知。

`estimatedCostUsd` 仅在全部组件可计算时给出；否则为 null。`knownComponentCostUsd` 只是已知部分，不能当作总费用。`estimateStatus=upper_bound` 表示缓存拆分未知，`incomplete` 表示缺少计价部分。所有成本均为参考估算，不能标为提供商已报告的实付费用。自定义渠道、订阅、地区、Fast/Flex/Batch 及额外费用应由接收端按其实际费率处理。

## harness-scope 后续适配建议

已对照 `crates/core/src/model.rs` 的 `Tokens`、`ParsedUsage`、`UsageRecord` 及 `harness/mod.rs`：

1. 增加 `gpt-img-studio` adapter，从指定 JSONL 采集；复用 `deviceId` / `id` / `sessionId`。不伪装成 Codex 或 Cherry Studio 的原生日志。
2. 请求数从事件根层汇总，模型和模态 token 从组件汇总。若拆成多个统计事实，使用 `${id}:component:${index}` 稳定子 ID，并保证工具子事实请求数为 0；现有 `ParsedUsage` 的逐条计数方式需相应扩展。
3. 缓存拆分已知时，`tokens.input` / `output` / `cacheRead` / `cacheWrite` 可直接映射现有 `Tokens`。未知拆分与未知用量必须保留可用性标志；当前非 nullable `u64` 结构不能完整表达这些事实，不应把 null 强制解释为实测零。
4. 现有单模型平面 `Price` 无法完整表达一条 Responses 请求的文本与图像费率。应保留组件快照，或扩展多模态价格结构；不能把图像 token 按主模型输出价重算。
5. 当前 `ParsedUsage.reported_cost` 不能直接承接本地估算，否则容易被当成已报告费用。接收端应明确区分 reported、estimated、unknown，并保留 `pricingSnapshot`。
6. 原始 usage 留在本地来源文件；同步时只发送允许的统计字段。新 harness ID、组件计数和可用性字段需要按接收端现有校验、同步 schema 与 UI 注册流程接入。

本次不修改 harness-scope 仓库。该契约保留其现有统计结构无法直接容纳的模态、可用性和价格依据，供后续 adapter 与数据结构扩展使用。
