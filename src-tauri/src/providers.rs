use crate::{
    provider,
    store::{text, Result},
};
use serde_json::{json, Value};
use std::collections::HashSet;

pub const ROLES: [&str; 4] = ["image", "imageMain", "refine", "naming"];
pub fn migrate(settings: &mut Value) -> Result<bool> {
    if settings["providers"].is_array() {
        return Ok(false);
    }
    let generation = settings["generation"].clone();
    let refine = settings["refine"].clone();
    let shared = refine["useImageConnection"] == true;
    let mut models = vec![
        json!({"id":generation["model"],"name":generation["model"],"kind":"image","protocol":"responses","vision":true}),
        json!({"id":generation["mainModel"],"name":generation["mainModel"],"kind":"text","protocol":"responses","vision":true}),
    ];
    if shared && refine["model"] != generation["mainModel"] {
        models.push(json!({"id":refine["model"],"name":refine["model"],"kind":"text","protocol":"responses","vision":true}));
    }
    let mut providers = vec![
        json!({"id":"legacy-image","name":"现有图像服务","kind":"custom","baseUrl":generation["baseUrl"],"models":models}),
    ];
    if !shared {
        providers.push(json!({"id":"legacy-refine","name":"现有文本服务","kind":"custom","baseUrl":refine["baseUrl"],"models":[{"id":refine["model"],"name":refine["model"],"kind":"text","protocol":"responses","vision":true}]}));
    }
    let text_provider = if shared {
        "legacy-image"
    } else {
        "legacy-refine"
    };
    settings["providers"] = json!(providers);
    settings["modelAssignments"] = json!({"image":{"providerId":"legacy-image","modelId":generation["model"]},"imageMain":{"providerId":"legacy-image","modelId":generation["mainModel"]},"refine":{"providerId":text_provider,"modelId":refine["model"]},"naming":{"providerId":text_provider,"modelId":refine["model"]}});
    normalize(settings)?;
    Ok(true)
}
pub fn normalize(settings: &mut Value) -> Result<()> {
    let providers = settings["providers"]
        .as_array_mut()
        .ok_or("缺少模型提供商")?;
    if providers.is_empty() || providers.len() > 50 {
        return Err("请配置 1–50 个提供商".into());
    }
    let mut ids = HashSet::new();
    for p in providers {
        let id = text(p, "id").to_owned();
        if id.is_empty()
            || id.len() > 80
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            || !ids.insert(id)
        {
            return Err("提供商 ID 无效或重复".into());
        }
        if text(p, "name").trim().is_empty() {
            return Err("请填写提供商名称".into());
        }
        p["baseUrl"] = json!(provider::base_url(text(p, "baseUrl"))?);
        if !["openai", "deepseek", "opencode", "custom"].contains(&text(p, "kind")) {
            return Err("无效的提供商类型".into());
        }
        // Persist only connection metadata; credentials always live in the OS vault.
        p.as_object_mut().unwrap().remove("apiKey");
        let mut models = HashSet::new();
        for model in p["models"].as_array().ok_or("缺少模型列表")? {
            if text(model, "id").trim().is_empty() || !models.insert(text(model, "id")) {
                return Err("同一提供商内的模型 ID 不能为空或重复".into());
            }
            if !["text", "image"].contains(&text(model, "kind"))
                || !["responses", "chat_completions"].contains(&text(model, "protocol"))
            {
                return Err("模型类型或调用协议无效".into());
            }
            if let Some(rates) = model["pricing"].as_object() {
                for (key, rate) in rates {
                    if [
                        "input",
                        "output",
                        "cachedInput",
                        "imageInput",
                        "cachedImageInput",
                        "cacheWrite",
                    ]
                    .contains(&key.as_str())
                        && !rate.is_null()
                    {
                        let value = rate.as_str().ok_or("费率请使用十进制字符串")?;
                        if !value.is_empty()
                            && (value.parse::<rust_decimal::Decimal>().ok().is_none_or(|n| {
                                n < rust_decimal::Decimal::ZERO
                                    || n > rust_decimal::Decimal::from(1_000_000_000u64)
                            }) || value.len() > 30)
                        {
                            return Err("费率必须是非负数".into());
                        }
                    }
                }
            }
        }
    }
    for role in ROLES {
        let model = model(settings, role)?;
        if (role == "image") != (model["kind"] == "image") {
            return Err(format!("{role} 的模型类型不正确"));
        }
    }
    let image_provider = provider_for(settings, "image")?.clone();
    let image_model = model(settings, "image")?.clone();
    let main_model = model(settings, "imageMain")?.clone();
    let refine_provider = provider_for(settings, "refine")?.clone();
    let refine_model = model(settings, "refine")?.clone();
    if settings["generation"]["apiMode"] != "images"
        && settings["generation"]["apiMode"] != "responses"
    {
        return Err("不支持的图像调用方式".into());
    }
    if settings["generation"]["apiMode"] == "responses"
        && (settings["modelAssignments"]["image"]["providerId"]
            != settings["modelAssignments"]["imageMain"]["providerId"]
            || main_model["protocol"] != "responses")
    {
        return Err(
            "Responses 图片主模型与绘图模型必须使用同一提供商，主模型需支持 Responses".into(),
        );
    }
    settings["generation"]["baseUrl"] = image_provider["baseUrl"].clone();
    settings["generation"]["model"] = image_model["id"].clone();
    settings["generation"]["mainModel"] = main_model["id"].clone();
    settings["generation"]["providerId"] = image_provider["id"].clone();
    settings["refine"] = json!({"baseUrl":refine_provider["baseUrl"],"model":refine_model["id"],"useImageConnection":image_provider["id"]==refine_provider["id"]});
    Ok(())
}
pub fn provider_for<'a>(settings: &'a Value, role: &str) -> Result<&'a Value> {
    let id = text(&settings["modelAssignments"][role], "providerId");
    settings["providers"]
        .as_array()
        .and_then(|items| items.iter().find(|p| text(p, "id") == id))
        .ok_or_else(|| format!("请为 {role} 选择有效提供商"))
}
pub fn model<'a>(settings: &'a Value, role: &str) -> Result<&'a Value> {
    let provider = provider_for(settings, role)?;
    let id = text(&settings["modelAssignments"][role], "modelId");
    provider["models"]
        .as_array()
        .and_then(|models| models.iter().find(|m| text(m, "id") == id))
        .ok_or_else(|| format!("请为 {role} 选择有效模型"))
}
pub fn credential_kind(provider: &Value) -> String {
    format!("provider:{}", text(provider, "id"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_preserves_separate_text_connection_and_roles() {
        let mut s = json!({"generation":{"baseUrl":"https://example.com/v1","apiMode":"responses","model":"gpt-image-2.5-sunburst","mainModel":"main"},"refine":{"baseUrl":"https://text.example.com/v1","model":"cheap","useImageConnection":false}});
        assert!(migrate(&mut s).unwrap());
        assert_eq!(
            s["modelAssignments"]["naming"]["providerId"],
            "legacy-refine"
        );
        assert_eq!(s["refine"]["model"], "cheap");
        assert!(!migrate(&mut s).unwrap());
        s["modelAssignments"]["imageMain"] = s["modelAssignments"]["naming"].clone();
        assert!(normalize(&mut s).is_err());
    }
}
