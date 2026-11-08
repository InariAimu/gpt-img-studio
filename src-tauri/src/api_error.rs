//! Diagnostic errors travel through the existing string IPC/storage contract.
use crate::store::text;
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub schema: &'static str,
    pub message: String,
    pub suggestion: String,
    pub stage: String,
    pub provider: String,
    pub model: String,
    pub endpoint: String,
    pub status_code: Option<u16>,
    pub request_id: String,
    pub response_id: String,
    pub code: String,
    pub error_type: String,
    pub param: String,
    pub response_status: String,
    pub retry_after: String,
    pub raw: String,
}

fn excerpt(value: &str, limit: usize) -> String {
    let mut chars = value.chars();
    let result: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        format!("{result}\n[内容过长，已截断]")
    } else {
        result
    }
}

/// Never include request headers, prompts or image payloads in diagnostics.
pub fn sanitize(value: &Value, key: &str) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(name, value)| {
                    let normalized = name.to_ascii_lowercase().replace(['_', '-'], "");
                    let secret = matches!(
                        normalized.as_str(),
                        "authorization"
                            | "apikey"
                            | "key"
                            | "token"
                            | "accesstoken"
                            | "refreshtoken"
                            | "password"
                            | "secret"
                            | "cookie"
                            | "setcookie"
                            | "b64json"
                            | "result"
                            | "imageurl"
                            | "input"
                            | "prompt"
                            | "instructions"
                    );
                    (
                        name.clone(),
                        if secret {
                            json!("[redacted]")
                        } else {
                            sanitize(value, key)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(items) => {
            Value::Array(items.iter().take(40).map(|v| sanitize(v, key)).collect())
        }
        Value::String(value) => {
            let mut value = value.clone();
            if !key.is_empty() {
                value = value.replace(key, "[redacted]");
                let encoded: String = key
                    .bytes()
                    .map(|b| {
                        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                            (b as char).to_string()
                        } else {
                            format!("%{b:02X}")
                        }
                    })
                    .collect();
                value = value.replace(&encoded, "[redacted]");
            }
            for scheme in ["https://", "http://", "socks5://", "socks5h://"] {
                let mut start = 0;
                while let Some(index) = value[start..].find(scheme) {
                    let from = start + index;
                    let end = from
                        + value[from..]
                            .find(|c: char| {
                                c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>')
                            })
                            .unwrap_or(value.len() - from);
                    if let Ok(mut url) = reqwest::Url::parse(&value[from..end]) {
                        if !url.username().is_empty()
                            || url.password().is_some()
                            || url.query().is_some()
                            || url.fragment().is_some()
                        {
                            let _ = url.set_username("");
                            let _ = url.set_password(None);
                            url.set_query(None);
                            url.set_fragment(None);
                            let replacement = url.to_string();
                            value.replace_range(from..end, &replacement);
                            start = from + replacement.len();
                            continue;
                        }
                    }
                    start = end;
                }
            }
            // Covers other OpenAI keys and bearer credentials echoed by a gateway.
            for prefix in ["sk-", "Bearer ", "bearer ", "data:image/"] {
                let mut start = 0;
                while let Some(index) = value[start..].find(prefix) {
                    let from = start + index;
                    let until = value[from..]
                        .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>'))
                        .unwrap_or(value.len() - from);
                    let end = if prefix.ends_with(' ') {
                        let token_start = from + prefix.len();
                        token_start
                            + value[token_start..]
                                .find(|c: char| {
                                    c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>')
                                })
                                .unwrap_or(value.len() - token_start)
                    } else {
                        from + until
                    };
                    value.replace_range(from..end, "[redacted]");
                    start = from + "[redacted]".len();
                }
            }
            json!(excerpt(&value, 12_000))
        }
        _ => value.clone(),
    }
}

impl ApiError {
    pub fn new(stage: &str) -> Self {
        Self {
            schema: "gpt-img-studio.api-error.v1",
            stage: stage.into(),
            ..Self::default()
        }
    }
    pub fn failure(&self, code: &str, message: &str, suggestion: &str, raw: &Value) -> Self {
        let mut error = self.clone();
        error.code = code.into();
        error.message = message.into();
        error.suggestion = suggestion.into();
        error.raw = raw
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| serde_json::to_string_pretty(raw).unwrap_or_default());
        error
    }
    pub fn encoded(&self, key: &str) -> String {
        let mut error = self.clone();
        let raw = serde_json::from_str(&error.raw).unwrap_or_else(|_| json!(error.raw));
        let raw = sanitize(&raw, key);
        error.raw = raw
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| serde_json::to_string_pretty(&raw).unwrap_or_default());
        let mut value = sanitize(&serde_json::to_value(error).unwrap(), key);
        // Bound the persisted diagnostic even when the server sends a large error object.
        if let Some(raw) = value["raw"].as_str() {
            value["raw"] = json!(excerpt(raw, 12_000));
        }
        value.to_string()
    }
    pub fn service_error(&self, error: &Value, raw: &Value) -> Self {
        let code = text(error, "code");
        let kind = text(error, "type");
        let (message, suggestion) = match code {
            "moderation_blocked" | "image_content_policy_violation" => ("请求或生成结果被服务的安全审核拦截", "请根据服务原始错误修改描述或参考图后再提交。"),
            "insufficient_quota" | "credit_balance_exhausted" | "organization_spend_limit_exceeded" | "project_spend_limit_exceeded" | "organization_usage_limit_exceeded" => ("服务余额或额度不足", "请检查提供商的余额、项目预算和用量上限；重复提交不能解决额度问题。"),
            "context_length_exceeded" => ("输入内容超过模型的上下文限制", "请减少输入内容或改用独立生成。"),
            "rate_limit_exceeded" | "slow_down" => ("服务请求受到限流", "请按 Retry-After 指定的时间等待，或稍后手动重试。"),
            "server_error" | "server_is_overloaded" => ("服务端暂时无法完成请求", "请稍后手动重试；若持续失败，请将请求 ID 和原始错误提供给服务商。"),
            _ if kind == "insufficient_quota" => ("服务余额或额度不足", "请检查提供商的余额、预算和用量上限。"),
            _ if kind == "image_generation_user_error" => ("图片生成请求需要调整", "请查看原始错误，修改 Prompt、参考图或生成选项后再提交。"),
            _ => match self.status_code {
                Some(401) => ("服务身份验证失败", "请检查此提供商的 API Key 是否正确、有效。"),
                Some(403) => ("服务拒绝访问", "请检查账号、项目和模型权限，以及服务的地区或访问限制。"),
                Some(404) => ("服务端点、模型或接续记录不存在", "请检查 Base URL 和模型 ID；接续生成失败时可尝试独立生成。"),
                Some(429) => ("服务请求受到限流", "请按 Retry-After 指定的时间等待，或稍后手动重试；也请核对原始错误是否为额度限制。"),
                Some(500..=599) => ("服务端暂时无法完成请求", "请稍后手动重试；若持续失败，请将请求 ID 和原始错误提供给服务商。"),
                Some(400 | 422) => ("服务无法接受当前请求", "请查看原始错误中的参数名，检查模型、生成选项和参考图是否受支持。"),
                _ => ("服务返回了错误", "请查看原始错误和请求 ID，检查服务配置或联系提供商。"),
            },
        };
        let mut result = self.failure(code, message, suggestion, raw);
        result.error_type = kind.into();
        result.param = text(error, "param").into();
        result
    }
}

/// Select only diagnostic fields, never a successful image/text payload.
pub fn diagnostic(value: &Value) -> Value {
    json!({"id":value["id"],"status":value["status"],"error":value["error"],"message":value["message"],"detail":value["detail"],"incomplete_details":value["incomplete_details"],
        "output":value["output"].as_array().map(|items| items.iter().map(|v| json!({"id":v["id"],"type":v["type"],"status":v["status"],"error":v["error"],"refusal":v["content"].as_array().map(|parts| parts.iter().filter(|p| p["type"]=="refusal").map(|p|p["refusal"].clone()).collect::<Vec<_>>())})).collect::<Vec<_>>()),
        "choices":value["choices"].as_array().map(|items|items.iter().map(|v|json!({"finish_reason":v["finish_reason"],"refusal":v["message"]["refusal"]})).collect::<Vec<_>>())})
}

pub fn validate(value: &Value, protocol: &str, context: &ApiError) -> Option<ApiError> {
    let raw = diagnostic(value);
    if !value["error"].is_null() {
        return Some(context.service_error(&value["error"], &raw));
    }
    if protocol == "responses" {
        for item in value["output"].as_array().into_iter().flatten() {
            if item["type"] == "image_generation_call"
                && (!item["error"].is_null() || item["status"] == "failed")
            {
                let mut error = context.service_error(&item["error"], &raw);
                error.stage = "图片生成工具".into();
                error.response_status = text(item, "status").into();
                return Some(error);
            }
        }
        let status = text(value, "status");
        if !status.is_empty() && status != "completed" {
            let reason = text(&value["incomplete_details"], "reason");
            let (message, suggestion) = match reason {
                "max_output_tokens" | "max_messages" => (
                    "模型输出达到限制，结果未完成",
                    "请减少输入内容或提高输出限制；本次部分输出不会作为完整结果采用。",
                ),
                "content_filter" => ("输出被服务的内容过滤中止", "请修改描述或参考图后再提交。"),
                _ if matches!(status, "queued" | "in_progress") => (
                    "服务尚未返回最终结果",
                    "当前客户端需要最终响应；请检查服务是否返回了异步任务。",
                ),
                _ => (
                    "服务未能完成本次生成",
                    "请查看响应状态、原始错误和请求 ID；本次不会自动重新提交。",
                ),
            };
            let mut error = context.failure(
                if reason.is_empty() { status } else { reason },
                message,
                suggestion,
                &raw,
            );
            error.response_status = status.into();
            return Some(error);
        }
        for item in value["output"].as_array().into_iter().flatten() {
            if item["content"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|p| p["type"] == "refusal")
            {
                return Some(context.failure(
                    "refusal",
                    "模型拒绝了本次请求",
                    "请查看服务的原始拒绝说明，并调整描述或参考图。",
                    &raw,
                ));
            }
            if matches!(
                text(item, "status"),
                "failed" | "incomplete" | "in_progress" | "generating"
            ) {
                return Some(context.failure(
                    "output_not_completed",
                    "服务返回的输出尚未完成",
                    "请查看输出状态；本次部分输出不会作为完整结果采用。",
                    &raw,
                ));
            }
        }
    } else if protocol == "chat_completions" {
        let choice = &value["choices"][0];
        if choice["message"]["refusal"]
            .as_str()
            .is_some_and(|v| !v.is_empty())
        {
            return Some(context.failure(
                "refusal",
                "模型拒绝了本次请求",
                "请查看服务的原始拒绝说明，并调整输入。",
                &raw,
            ));
        }
        let reason = text(choice, "finish_reason");
        if !reason.is_empty() && reason != "stop" {
            let (message, suggestion) = match reason {
                "length" => (
                    "模型输出达到 Token 限制，文本被截断",
                    "请减少输入或提高输出限制；原内容保持不变。",
                ),
                "content_filter" => ("模型输出被内容过滤中止", "请调整输入内容；原内容保持不变。"),
                _ => (
                    "服务没有返回正常结束的文本结果",
                    "请检查模型和接口兼容性；原内容保持不变。",
                ),
            };
            return Some(context.failure(reason, message, suggestion, &raw));
        }
    }
    None
}

pub fn validate_result(
    value: &Value,
    protocol: &str,
    image: bool,
    context: &ApiError,
) -> Option<ApiError> {
    let raw = diagnostic(value);
    if image {
        let entries = crate::provider::image_entries(value, protocol == "responses");
        let has_url = protocol == "images"
            && value["data"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|v| !text(v, "url").is_empty());
        if entries.is_empty() && !has_url {
            return Some(context.failure(
                "missing_image",
                "服务没有返回可用的图片",
                "请检查图像模型、工具权限和接口兼容性；此任务不会自动重试。",
                &raw,
            ));
        }
        use base64::Engine;
        for (encoded, _) in entries {
            if let Err(error) = base64::engine::general_purpose::STANDARD.decode(encoded) {
                return Some(context.failure(
                    "invalid_image_base64",
                    "服务返回的图片 Base64 编码无效",
                    "请将请求 ID 和原始错误提供给服务商；此任务不会自动重试。",
                    &json!({"response":raw,"decode_error":error.to_string()}),
                ));
            }
        }
    } else {
        let has_text = if protocol == "responses" {
            value["output"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|v| v["content"].as_array().into_iter().flatten())
                .any(|p| p["type"] == "output_text" && !text(p, "text").trim().is_empty())
        } else {
            !text(&value["choices"][0]["message"], "content")
                .trim()
                .is_empty()
        };
        if !has_text {
            return Some(context.failure(
                "missing_text",
                "服务没有返回可用的文本",
                "请检查文本模型及接口兼容性；原内容保持不变。",
                &raw,
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_business_errors_in_successful_http_responses() {
        let context = ApiError::new("模型响应");
        for (value, protocol, code) in [
            (
                json!({"status":"failed","error":{"code":"invalid_image","message":"bad image"}}),
                "responses",
                "invalid_image",
            ),
            (
                json!({"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"content":[{"type":"output_text","text":"partial"}]}]}),
                "responses",
                "max_output_tokens",
            ),
            (
                json!({"status":"completed","output":[{"type":"image_generation_call","status":"failed","error":{"code":"moderation_blocked","message":"blocked","moderation_details":{"moderation_stage":"output"}}}]}),
                "responses",
                "moderation_blocked",
            ),
            (
                json!({"output":[{"content":[{"type":"refusal","refusal":"Cannot comply"}]}]}),
                "responses",
                "refusal",
            ),
            (
                json!({"choices":[{"finish_reason":"length","message":{"content":"partial"}}]}),
                "chat_completions",
                "length",
            ),
            (
                json!({"choices":[{"finish_reason":"content_filter"}]}),
                "chat_completions",
                "content_filter",
            ),
        ] {
            assert_eq!(validate(&value, protocol, &context).unwrap().code, code);
        }
        assert!(validate(&json!({"status":"completed","output":[{"type":"image_generation_call","status":"completed","result":"AQID"}]}),"responses",&context).is_none());
        assert!(validate(
            &json!({"choices":[{"finish_reason":"stop","message":{"content":"ok"}}]}),
            "chat_completions",
            &context
        )
        .is_none());
        // Compatible services may omit optional lifecycle fields.
        assert!(validate(
            &json!({"output":[{"type":"image_generation_call","result":"AQID"}]}),
            "responses",
            &context
        )
        .is_none());
    }
    #[test]
    fn diagnostics_redact_secrets_and_payloads_and_remain_bounded() {
        let raw = json!({"error":{"message":"custom-secret sk-other-secret Bearer abc","authorization":"abc","code":"bad"},"prompt":"private","b64_json":"AAAA","url":"https://user:proxy-password@example.test/path?token=query-secret"});
        let error = ApiError::new("服务返回").service_error(&raw["error"], &raw);
        let encoded = error.encoded("custom-secret");
        for secret in [
            "custom-secret",
            "sk-other-secret",
            "Bearer abc",
            "private",
            "AAAA",
            "proxy-password",
            "query-secret",
        ] {
            assert!(!encoded.contains(secret), "{secret}");
        }
        assert!(encoded.contains("bad"));
        let value = json!({"output":[{"type":"image_generation_call","result":"PRIVATE_IMAGE"},{"content":[{"type":"output_text","text":"PRIVATE_TEXT"}]}]});
        assert!(!diagnostic(&value).to_string().contains("PRIVATE"));
        let error = ApiError::new("解析").failure(
            "bad",
            "格式错误",
            "检查端点",
            &json!("汉".repeat(50_000)),
        );
        let encoded = error.encoded("");
        assert!(encoded.len() < 40_000);
        assert!(encoded.contains("已截断"));
    }
    #[test]
    fn quota_errors_are_distinguished_from_rate_limits() {
        let mut context = ApiError::new("服务返回");
        context.status_code = Some(429);
        assert_eq!(
            context
                .service_error(&json!({"code":"credit_balance_exhausted"}), &Value::Null)
                .message,
            "服务余额或额度不足"
        );
        assert_eq!(
            context
                .service_error(&json!({"code":"rate_limit_exceeded"}), &Value::Null)
                .message,
            "服务请求受到限流"
        );
    }
    #[test]
    fn missing_and_corrupt_results_are_not_successful() {
        let context = ApiError::new("服务返回");
        assert_eq!(
            validate_result(&json!({"output":[]}), "responses", true, &context)
                .unwrap()
                .code,
            "missing_image"
        );
        assert_eq!(
            validate_result(
                &json!({"data":[{"b64_json":"not base64!"}]}),
                "images",
                true,
                &context
            )
            .unwrap()
            .code,
            "invalid_image_base64"
        );
        assert_eq!(
            validate_result(&json!({"choices":[]}), "chat_completions", false, &context)
                .unwrap()
                .code,
            "missing_text"
        );
        assert!(validate_result(
            &json!({"data":[{"b64_json":"AQID"}]}),
            "images",
            true,
            &context
        )
        .is_none());
        assert!(validate_result(
            &json!({"data":[{"url":"https://example.test/image.png"}]}),
            "images",
            true,
            &context
        )
        .is_none());
        assert!(validate_result(
            &json!({"output":[{"content":[{"type":"output_text","text":"ok"}]}]}),
            "responses",
            false,
            &context
        )
        .is_none());
    }
}
