//! Outbound policy adapted from Harness Scope. Applies to each new model operation.
use crate::store::{text, Result};
use hyper_util::client::proxy::matcher::Matcher;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const LOOPBACK: &str = "localhost,127.0.0.0/8,::1";
const TEST_URL: &str = "https://models.dev/api.json";

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    #[default]
    System,
    Manual,
    Direct,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Settings {
    pub mode: Mode,
    pub proxy_url: String,
}

impl Settings {
    pub fn from_settings(settings: &Value) -> Result<Self> {
        let mut network: Self = match settings.get("network") {
            None => Self::default(),
            Some(value) => {
                serde_json::from_value(value.clone()).map_err(|_| "网络设置格式无效".to_owned())?
            }
        };
        network.validate()?;
        Ok(network)
    }

    pub fn validate(&mut self) -> Result<()> {
        self.proxy_url = self.proxy_url.trim().to_owned();
        if self.mode != Mode::Manual {
            // Do not retain accidentally pasted credentials in an inactive field.
            self.proxy_url.clear();
            return Ok(());
        }
        if self.proxy_url.len() > 2048 || self.proxy_url.contains(['\r', '\n', '\0']) {
            return Err("代理地址无效".into());
        }
        let url = Url::parse(&self.proxy_url)
            .map_err(|_| "请填写包含 http://、https://、socks5:// 或 socks5h:// 的代理地址")?;
        if !matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h")
            || url.host_str().is_none()
        {
            return Err("不支持的代理地址，请使用 HTTP、HTTPS、SOCKS5 或 SOCKS5H".into());
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("不支持在代理地址中填写账号密码，请使用无需认证的本地代理".into());
        }
        if !matches!(url.path(), "" | "/") || url.query().is_some() || url.fragment().is_some() {
            return Err("代理地址只能包含协议、主机和端口".into());
        }
        self.proxy_url = url.to_string();
        Ok(())
    }

    fn builder(&self) -> Result<reqwest::ClientBuilder> {
        let mut settings = self.clone();
        settings.validate()?;
        let builder = Client::builder().redirect(reqwest::redirect::Policy::none());
        let builder = match settings.mode {
            Mode::System => builder,
            Mode::Direct => builder.no_proxy(),
            Mode::Manual => builder.no_proxy().proxy(
                reqwest::Proxy::all(&settings.proxy_url)
                    .map_err(|_| "无法初始化代理连接")?
                    .no_proxy(reqwest::NoProxy::from_string(LOOPBACK)),
            ),
        };
        Ok(builder)
    }

    pub fn client(&self, timeout: Duration, connect_timeout: Duration) -> Result<Client> {
        self.builder()?
            .timeout(timeout)
            .connect_timeout(connect_timeout)
            .build()
            .map_err(|_| "无法初始化网络连接".into())
    }

    fn route(&self, target: &str) -> Result<Option<String>> {
        let target = crate::provider::base_url(target)?;
        let uri = target.parse().map_err(|_| "目标地址无效")?;
        let matcher = match self.mode {
            Mode::System => Matcher::from_system(),
            Mode::Direct => return Ok(None),
            Mode::Manual => Matcher::builder().all(&self.proxy_url).no(LOOPBACK).build(),
        };
        // Matcher removes proxy credentials, including those from the environment.
        Ok(matcher.intercept(&uri).map(|proxy| proxy.uri().to_string()))
    }
}

pub fn normalize(settings: &mut Value) -> Result<()> {
    settings["network"] = json!(Settings::from_settings(settings)?);
    Ok(())
}

pub fn view(settings: &Value) -> Result<Value> {
    let network = Settings::from_settings(settings)?;
    let mut routes = Vec::new();
    let mut add = |id: &str, name: &str, target: &str| {
        let configured = !target.is_empty();
        let route = configured.then(|| network.route(target)).transpose();
        routes.push(json!({
            "id":id, "name":name, "configured":configured,
            "invalid":route.is_err(), "proxy":route.ok().flatten().flatten(),
        }));
    };
    for provider in settings["providers"].as_array().into_iter().flatten() {
        add(
            text(provider, "id"),
            text(provider, "name"),
            text(provider, "baseUrl"),
        );
    }
    add("network-test", "models.dev · 连接测试", TEST_URL);
    Ok(json!({"settings":network,"routes":routes}))
}

pub async fn test(mut settings: Settings) -> Result<Value> {
    settings.validate()?;
    let started = Instant::now();
    let response = settings
        .client(Duration::from_secs(15), Duration::from_secs(10))?
        .head(TEST_URL)
        .send()
        .await
        .map_err(|_| "连接失败，请检查代理地址、代理服务和网络连接")?;
    if !response.status().is_success() {
        return Err(format!("连接测试返回 HTTP {}", response.status().as_u16()));
    }
    Ok(json!({"elapsedMs":started.elapsed().as_millis()}))
}
