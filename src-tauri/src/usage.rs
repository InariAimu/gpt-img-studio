//! One event per HTTP invocation. Hosted-tool components never increment request counts.
use crate::{
    providers,
    store::{id, text},
};
use rust_decimal::Decimal;
use serde_json::{json, Value};
use std::str::FromStr;

pub const PRICING_DATE: &str = "2026-11-03";
fn provider_snapshot(provider: &Value) -> Value {
    let endpoint = reqwest::Url::parse(text(provider, "baseUrl")).ok();
    // Classify the configured destination; names and OpenAI-compatible protocol
    // alone are not evidence of an official endpoint. Never journal the URL/key.
    let service = match endpoint.as_ref() {
        Some(url)
            if url.scheme() == "https"
                && url.host_str() == Some("api.openai.com")
                && url.port_or_known_default() == Some(443) =>
        {
            "openai-platform"
        }
        Some(_) => "other",
        None => "unknown",
    };
    json!({"id":provider["id"],"name":provider["name"],"kind":provider["kind"],
        "billingChannel":"api","apiService":service})
}
pub struct Invocation {
    pub id: String,
    pub session_id: String,
    pub operation: String,
    pub provider: Value,
    pub model: Value,
    pub image_model: Option<Value>,
    pub protocol: String,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub device_id: String,
}
impl Invocation {
    pub fn new(
        doc: &Value,
        role: &str,
        session_id: &str,
        operation: &str,
        protocol: &str,
    ) -> crate::store::Result<Self> {
        let settings = &doc["settings"];
        let model = providers::model(settings, role)?.clone();
        Ok(Self {
            id: id(),
            session_id: session_id.into(),
            operation: operation.into(),
            provider: providers::provider_for(settings, role)?.clone(),
            model,
            image_model: None,
            protocol: protocol.into(),
            started_at: chrono::Utc::now(),
            device_id: text(doc, "installationId").into(),
        })
    }
    pub fn event(&self, response: &Value, status: Option<u16>, request_id: Option<&str>) -> Value {
        let mut components = Vec::new();
        if self.protocol == "images" {
            components.push(component(
                &self.model,
                &response["usage"],
                true,
                false,
                &response["service_tier"],
            ));
        } else {
            components.push(component(
                &self.model,
                &response["usage"],
                false,
                false,
                &response["service_tier"],
            ));
            if let Some(image_model) = &self.image_model {
                if response["tool_usage"]["image_gen"].is_object() {
                    components.push(component(
                        image_model,
                        &response["tool_usage"]["image_gen"],
                        true,
                        true,
                        &Value::Null,
                    ));
                } else {
                    let calls = response["output"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter(|v| v["type"] == "image_generation_call")
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    if calls.is_empty() {
                        components.push(component(
                            image_model,
                            &Value::Null,
                            true,
                            true,
                            &Value::Null,
                        ));
                    }
                    for call in calls {
                        components.push(component(
                            image_model,
                            &call["usage"],
                            true,
                            true,
                            &Value::Null,
                        ));
                    }
                }
            }
        }
        let all_priced = components.iter().all(|c| c["estimatedCostUsd"].is_string());
        let known = components
            .iter()
            .filter_map(|c| {
                c["estimatedCostUsd"]
                    .as_str()
                    .and_then(|s| Decimal::from_str(s).ok())
            })
            .sum::<Decimal>()
            .normalize()
            .to_string();
        let upper = components
            .iter()
            .any(|c| c["estimateStatus"] == "upper_bound");
        json!({"schema":"gpt-img-studio.usage","schemaVersion":1,"id":self.id,"harness":"gpt-img-studio","deviceId":self.device_id,"sessionId":self.session_id,"operation":self.operation,"provider":provider_snapshot(&self.provider),"model":self.model["id"],"protocol":self.protocol,"responseModel":response["model"],"serviceTier":response["service_tier"],"billingBasis":"reference_api","occurredAt":self.started_at.timestamp(),"startedAt":self.started_at.to_rfc3339(),"finishedAt":chrono::Utc::now().to_rfc3339(),"durationMs":(chrono::Utc::now()-self.started_at).num_milliseconds(),"requestCount":1,"statusCode":status,"responseId":response["id"].as_str(),"serverRequestId":request_id,"components":components,"rawUsage":response["usage"],"rawToolUsage":response["tool_usage"],"estimatedCostUsd":if all_priced {json!(known)}else{Value::Null},"knownComponentCostUsd":known,"estimateStatus":if !all_priced {"incomplete"}else if upper {"upper_bound"}else{"estimated"},"currency":"USD"})
    }
}
fn number(value: &Value) -> Option<u64> {
    value.as_u64().filter(|v| *v <= 1_000_000_000_000)
}
fn first(a: &Value, b: &Value) -> Option<u64> {
    number(a).or_else(|| number(b))
}

/// Stable, flat model measurements. Original request events remain authoritative;
/// rebuilding this projection never re-estimates historical prices or reads prompts.
pub fn model_records(event: &Value) -> Vec<Value> {
    event["components"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(index, c)| {
            json!({
                "schema": "gpt-img-studio.model-usage", "schemaVersion": 1,
                "id": format!("{}:component:{index}", text(event, "id")),
                "requestId": event["id"], "deviceId": event["deviceId"],
                "sessionId": event["sessionId"], "operation": event["operation"],
                "provider": event["provider"], "model": c["model"], "kind": c["kind"],
                "occurredAt": event["occurredAt"], "statusCode": event["statusCode"],
                "requestDurationMs": event["durationMs"], "protocol": event["protocol"],
                "usageAvailable": c["usageAvailable"], "tokens": c["tokens"],
                "cacheBreakdownKnown": c["cacheBreakdownKnown"],
                "cacheWriteApplicable": c["cacheWriteApplicable"],
                "textInputTokens": c["textInputTokens"], "imageInputTokens": c["imageInputTokens"],
                "estimatedCostUsd": c["estimatedCostUsd"], "estimateStatus": c["estimateStatus"],
                "pricingSnapshot": c["pricingSnapshot"], "currency": "USD"
            })
        })
        .collect()
}
fn pricing(model: &Value, image: bool, service_tier: &Value, input_tokens: Option<u64>) -> Value {
    if model["pricing"].as_object().is_some_and(|p| {
        p.values()
            .any(|v| v.as_str().is_some_and(|s| !s.is_empty()))
    }) {
        return json!({"source":"provider_config","rates":model["pricing"],"currency":"USD","unit":"per_million_tokens"});
    }
    let name = text(model, "id").rsplit('/').next().unwrap_or("");
    let mut rates = if image && (name == "gpt-image-2.5-sunburst" || name == "gpt-image-2.5-flare")
    {
        json!({"input":"5","cachedInput":"1.25","imageInput":"8","cachedImageInput":"2","output":"30"})
    } else if !image
        && (service_tier.is_null()
            || ["auto", "default", "standard"].contains(&service_tier.as_str().unwrap_or("")))
    {
        match name {
            "gpt-6.1-sol" => {
                json!({"input":"2","cachedInput":"0.1","cacheWrite":"2.5","output":"10"})
            }
            "gpt-6.1-terra" => {
                json!({"input":"1","cachedInput":"0.05","cacheWrite":"1.25","output":"5"})
            }
            "gpt-6-luna" => {
                json!({"input":"0.1","cachedInput":"0.01","cacheWrite":"0.125","output":"0.5"})
            }
            _ => Value::Null,
        }
    } else {
        Value::Null
    };
    let long_context = !image && input_tokens.is_some_and(|n| n > 272_000);
    if long_context {
        if name != "gpt-6.1-sol" {
            return Value::Null;
        }
        for key in ["input", "cachedInput", "cacheWrite"] {
            if let Some(rate) = rates[key].as_str().and_then(|r| r.parse::<Decimal>().ok()) {
                rates[key] = json!((rate * Decimal::from(2)).normalize().to_string());
            }
        }
        if let Some(rate) = rates["output"]
            .as_str()
            .and_then(|r| r.parse::<Decimal>().ok())
        {
            rates["output"] = json!((rate * Decimal::new(15, 1)).normalize().to_string());
        }
    }
    if rates.is_null() {
        Value::Null
    } else {
        json!({"source":"openai_reference","asOf":PRICING_DATE,"sourceUrl":"https://developers.openai.com/api/docs/pricing","currency":"USD","unit":"per_million_tokens","serviceTier":"standard","contextTier":if long_context{"long"}else{"short"},"rates":rates})
    }
}
fn cost_part(tokens: u64, rates: &Value, key: &str) -> Option<Decimal> {
    if tokens == 0 {
        return Some(Decimal::ZERO);
    }
    let rate = Decimal::from_str(rates[key].as_str()?).ok()?;
    if rate < Decimal::ZERO {
        return None;
    }
    Decimal::from(tokens)
        .checked_mul(rate)?
        .checked_div(Decimal::from(1_000_000))
}
pub fn component(
    model: &Value,
    usage: &Value,
    image: bool,
    responses: bool,
    service_tier: &Value,
) -> Value {
    let input = first(&usage["input_tokens"], &usage["prompt_tokens"]);
    let output = first(&usage["output_tokens"], &usage["completion_tokens"]);
    let available = input.is_some() && output.is_some();
    let cached = first(
        &usage["input_tokens_details"]["cached_tokens"],
        &usage["prompt_tokens_details"]["cached_tokens"],
    )
    .or_else(|| number(&usage["prompt_cache_hit_tokens"]))
    .or_else(|| number(&usage["cached_tokens"]));
    let cached_text = if responses {
        number(&usage["cached_tokens_details"]["cached_text_tokens"])
    } else {
        None
    };
    let cached_image = if responses {
        number(&usage["cached_tokens_details"]["cached_image_tokens"])
    } else {
        None
    };
    let read_known = if image {
        !responses || (cached_text.is_some() && cached_image.is_some())
    } else {
        cached.is_some()
    };
    let write_reported = if image {
        Some(0)
    } else {
        first(
            &usage["input_tokens_details"]["cache_write_tokens"],
            &usage["prompt_tokens_details"]["cache_write_tokens"],
        )
    };
    let write = write_reported.unwrap_or(0);
    let read = if image {
        cached_text
            .unwrap_or(0)
            .saturating_add(cached_image.unwrap_or(0))
    } else {
        cached.unwrap_or(0)
    };
    let text_input = number(&usage["input_tokens_details"]["text_tokens"]);
    let image_input = number(&usage["input_tokens_details"]["image_tokens"]);
    let snapshot = pricing(model, image, service_tier, input);
    let rates = &snapshot["rates"];
    let write_applicable = !image && (rates["cacheWrite"].is_string() || write > 0);
    let cache_known = read_known && (!write_applicable || write_reported.is_some());
    let reasoning = first(
        &usage["output_tokens_details"]["reasoning_tokens"],
        &usage["completion_tokens_details"]["reasoning_tokens"],
    );
    let quote = (|| -> Option<Decimal> {
        let input = input?;
        let output = output?;
        if write_applicable && write_reported.is_none() {
            return None;
        }
        if read.saturating_add(write) > input {
            return None;
        }
        if image {
            let ti = text_input?;
            let ii = image_input?;
            if ti.checked_add(ii)? != input
                || cached_text.unwrap_or(0) > ti
                || cached_image.unwrap_or(0) > ii
            {
                return None;
            }
            if number(&usage["output_tokens_details"]["text_tokens"]).unwrap_or(0) > 0 {
                return None;
            }
            Some(
                cost_part(ti - cached_text.unwrap_or(0), rates, "input")?
                    + cost_part(ii - cached_image.unwrap_or(0), rates, "imageInput")?
                    + cost_part(cached_text.unwrap_or(0), rates, "cachedInput")?
                    + cost_part(cached_image.unwrap_or(0), rates, "cachedImageInput")?
                    + cost_part(output, rates, "output")?,
            )
        } else {
            Some(
                cost_part(input - read - write, rates, "input")?
                    + cost_part(read, rates, "cachedInput")?
                    + cost_part(write, rates, "cacheWrite")?
                    + cost_part(output, rates, "output")?,
            )
        }
    })();
    json!({"kind":if image {"image"}else{"language"},"model":model["id"],"usageAvailable":available,"tokens":{"input":if cache_known {json!(input.map(|n|n.saturating_sub(read).saturating_sub(write)))}else{Value::Null},"output":output,"cacheRead":if read_known {json!(read)}else{Value::Null},"cacheWrite":write_reported,"reasoning":reasoning,"totalInput":input,"total":input.zip(output).and_then(|(a,b)|a.checked_add(b))},"imageInputTokens":image_input,"textInputTokens":text_input,"cacheBreakdownKnown":cache_known,"cacheWriteApplicable":write_applicable,"rawUsage":usage,"pricingSnapshot":snapshot,"estimatedCostUsd":quote.map(|v|v.round_dp(12).normalize().to_string()),"estimateStatus":if quote.is_none(){"unknown"}else if cache_known {"estimated"}else{"upper_bound"}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_export_matches_shared_contract_without_request_payloads() {
        let event: Value =
            serde_json::from_str(include_str!("../tests/fixtures/usage-event.json")).unwrap();
        let expected: Vec<Value> = include_str!("../tests/fixtures/model-usage.jsonl")
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(model_records(&event), expected);
        assert!(!serde_json::to_string(&model_records(&event))
            .unwrap()
            .contains("privateSyntheticPayload"));
    }
    #[test]
    fn chat_cache_writes_are_charged_and_missing_billable_counts_stay_unknown() {
        let model = json!({"id":"gpt-6.1-sol"});
        let mut value = json!({"prompt_tokens":1000,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":800,"cache_write_tokens":100}});
        let quote = component(&model, &value, false, false, &Value::Null);
        assert_eq!(quote["tokens"]["input"], 100);
        assert_eq!(quote["tokens"]["cacheWrite"], 100);
        assert_eq!(quote["estimatedCostUsd"], "0.00153");
        value["prompt_tokens_details"]
            .as_object_mut()
            .unwrap()
            .remove("cache_write_tokens");
        let unknown = component(&model, &value, false, false, &Value::Null);
        assert!(unknown["estimatedCostUsd"].is_null());
        assert!(unknown["tokens"]["cacheWrite"].is_null());
        assert_eq!(unknown["tokens"]["cacheRead"], 800);
    }
    #[test]
    fn standard_llm_long_context_and_cache_writes_use_frozen_rates() {
        let c = component(
            &json!({"id":"gpt-6.1-sol"}),
            &json!({"input_tokens":273000,"input_tokens_details":{"cached_tokens":100000,"cache_write_tokens":20000},"output_tokens":100}),
            false,
            false,
            &Value::Null,
        );
        assert_eq!(c["tokens"]["input"], 153000);
        assert_eq!(c["estimatedCostUsd"], "0.7335");
        assert_eq!(c["pricingSnapshot"]["rates"]["output"], "15");
        assert_eq!(c["pricingSnapshot"]["contextTier"], "long");
    }
    #[test]
    fn llm_cached_and_reasoning_tokens_are_not_double_counted() {
        let m = json!({"id":"gpt-6.1-sol"});
        let u = json!({"prompt_tokens":1000,"completion_tokens":100,"prompt_cache_hit_tokens":800,"prompt_tokens_details":{"cache_write_tokens":0},"completion_tokens_details":{"reasoning_tokens":70}});
        let c = component(&m, &u, false, false, &Value::Null);
        assert_eq!(c["tokens"]["input"], 200);
        assert_eq!(c["tokens"]["output"], 100);
        assert_eq!(c["estimatedCostUsd"], "0.00148");
    }
    #[test]
    fn image_rates_are_multimodal_and_unknown_cache_is_explicit() {
        let m = json!({"id":"gpt-image-2.5-sunburst"});
        let u = json!({"input_tokens":1000,"input_tokens_details":{"text_tokens":200,"image_tokens":800},"output_tokens":100});
        let c = component(&m, &u, true, true, &Value::Null);
        assert_eq!(c["estimatedCostUsd"], "0.0104");
        assert_eq!(c["estimateStatus"], "upper_bound");
        assert!(c["tokens"]["cacheRead"].is_null());
        assert_eq!(
            component(&m, &u, true, false, &Value::Null)["estimateStatus"],
            "estimated"
        );
        assert!(
            component(&m, &Value::Null, true, true, &Value::Null)["estimatedCostUsd"].is_null()
        );
    }
    #[test]
    fn aggregate_tool_usage_wins_over_individual_tool_usage() {
        let i = Invocation {
            id: "event".into(),
            session_id: "session".into(),
            operation: "image".into(),
            provider: json!({"id":"p"}),
            model: json!({"id":"gpt-6.1-sol"}),
            image_model: Some(json!({"id":"gpt-image-2.5-sunburst"})),
            protocol: "responses".into(),
            started_at: chrono::Utc::now(),
            device_id: "device".into(),
        };
        let e=i.event(&json!({"usage":{"input_tokens":20,"output_tokens":10},"tool_usage":{"image_gen":{"input_tokens":5,"input_tokens_details":{"text_tokens":5,"image_tokens":0},"output_tokens":100}},"output":[{"type":"image_generation_call","usage":{"output_tokens":100}}]}),Some(200),None);
        assert_eq!(e["components"].as_array().unwrap().len(), 2);
        assert_eq!(e["requestCount"], 1);
        assert_eq!(e["components"][1]["tokens"]["output"], 100);
    }

    #[test]
    fn provider_snapshot_classifies_endpoint_without_leaking_connection_secrets() {
        let mut p = json!({"id":"legacy-image","name":"OpenAI","kind":"openai",
            "baseUrl":"https://user:secret@api.openai.com/v1?key=secret","apiKey":"secret"});
        let snapshot = provider_snapshot(&p);
        assert_eq!(snapshot["apiService"], "openai-platform");
        assert_eq!(snapshot["billingChannel"], "api");
        assert_eq!(snapshot["id"], "legacy-image");
        assert!(!snapshot.to_string().contains("secret"));
        for url in [
            "https://api.openai.com.proxy.example/v1",
            "https://proxy.example/v1",
            "http://api.openai.com/v1",
            "https://api.openai.com:8443/v1",
        ] {
            p["baseUrl"] = json!(url);
            assert_eq!(provider_snapshot(&p)["apiService"], "other");
        }
        p["baseUrl"] = Value::Null;
        assert_eq!(provider_snapshot(&p)["apiService"], "unknown");
        // Re-exporting an old event must never infer its endpoint from today's settings.
        let event: Value =
            serde_json::from_str(include_str!("../tests/fixtures/usage-event.json")).unwrap();
        assert!(model_records(&event)[0]["provider"]["apiService"].is_null());
    }
}
