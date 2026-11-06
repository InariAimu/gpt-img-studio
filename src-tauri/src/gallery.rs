//! Local gallery preferences and authenticated szurubooru connection helpers.
use crate::{
    network, provider,
    store::{Result, Store},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{
    header::{HeaderValue, AUTHORIZATION},
    Url,
};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UploadMode {
    #[default]
    Manual,
    AfterGeneration,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Safety {
    Safe,
    #[default]
    Sketchy,
    Unsafe,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Config {
    pub api_url: String,
    pub username: String,
    pub direct: bool,
    pub upload_mode: UploadMode,
    pub safety: Safety,
    pub default_tags: Vec<String>,
    pub include_prompt: bool,
    pub include_generation: bool,
    pub label_model: Option<Value>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            api_url: String::new(),
            username: String::new(),
            direct: true,
            upload_mode: UploadMode::Manual,
            safety: Safety::Sketchy,
            default_tags: vec![],
            include_prompt: true,
            include_generation: true,
            label_model: None,
        }
    }
}
impl Config {
    fn normalize(&mut self) -> Result<()> {
        self.api_url = self.api_url.trim().to_owned();
        if !self.api_url.is_empty() {
            if self.api_url.len() > 2048 || self.api_url.chars().any(char::is_control) {
                return Err("图库 API 地址无效".into());
            }
            let url =
                Url::parse(&provider::base_url(&self.api_url)?).map_err(|_| "图库 API 地址无效")?;
            self.api_url = url.to_string().trim_end_matches('/').to_owned();
        }
        self.username = self.username.trim().to_owned();
        if self.username.chars().count() > 64
            || self
                .username
                .chars()
                .any(|c| c == ':' || c.is_control() || c.is_whitespace())
        {
            return Err("图库用户名不能包含冒号或空白，最多 64 个字符".into());
        }
        let mut tags = Vec::new();
        for tag in &self.default_tags {
            let tag = tag.trim();
            if tag.is_empty() {
                continue;
            }
            if tag.chars().count() > 128
                || tag
                    .chars()
                    .any(|c| c.is_whitespace() || c.is_control() || matches!(c, ',' | '，'))
            {
                return Err("每个标签最多 128 个字符，词语间请使用下划线".into());
            }
            if !tags.iter().any(|t| t == tag) {
                tags.push(tag.to_owned());
            }
        }
        if tags.len() > 100 {
            return Err("默认标签最多 100 个".into());
        }
        self.default_tags = tags;
        Ok(())
    }
    pub(crate) fn credential_kind(&self) -> String {
        format!("szurubooru:{}", self.username)
    }
    pub(crate) fn has_token(&self) -> bool {
        !self.api_url.is_empty()
            && !self.username.is_empty()
            && provider::has_key(&self.credential_kind(), &self.api_url)
    }
    pub(crate) fn endpoint(&self, segments: &[&str]) -> Result<Url> {
        let mut url =
            Url::parse(&format!("{}/", self.api_url)).map_err(|_| "请填写图库 API 地址")?;
        url.path_segments_mut()
            .map_err(|_| "图库 API 地址无效")?
            .pop_if_empty()
            .extend(segments);
        Ok(url)
    }
}

pub(crate) fn read_config(db: &Connection) -> Result<Config> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS gallery_local (id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL)").map_err(|e| e.to_string())?;
    let raw: Option<String> = db
        .query_row("SELECT config FROM gallery_local WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|_| "无法读取图库配置".into()))
        .unwrap_or_else(|| Ok(Config::default()))
}
fn write_config(db: &Connection, config: &Config) -> Result<()> {
    read_config(db)?;
    db.execute("INSERT INTO gallery_local VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET config=excluded.config", [serde_json::to_string(config).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
    Ok(())
}
fn state(config: Config) -> Value {
    json!({"hasToken":config.has_token(),"config":config})
}
pub fn view(store: &Store) -> Result<Value> {
    let _operation = store.operation()?;
    let config = read_config(&*store.connection.lock().map_err(|e| e.to_string())?)?;
    Ok(state(config))
}
pub fn save(
    store: &Store,
    mut config: Config,
    token: Option<String>,
    forget_token: bool,
) -> Result<Value> {
    let _operation = store.operation()?;
    config.normalize()?;
    let token = token.filter(|s| !s.trim().is_empty());
    if token.is_some() && forget_token {
        return Err("不能同时保存和清除令牌".into());
    }
    if (token.is_some() || forget_token)
        && (config.api_url.is_empty() || config.username.is_empty())
    {
        return Err("保存或清除令牌前，请填写 API 地址和用户名".into());
    }
    if let Some(token) = token {
        validate_token(&token)?;
        provider::save_key(&config.credential_kind(), &config.api_url, &token)?;
    }
    if forget_token {
        provider::delete_key(&config.credential_kind(), &config.api_url)?;
    }
    write_config(
        &*store.connection.lock().map_err(|e| e.to_string())?,
        &config,
    )?;
    Ok(state(config))
}
fn validate_token(token: &str) -> Result<()> {
    if token.trim().len() > 4096 || token.trim().chars().any(char::is_control) {
        Err("图库令牌格式无效".into())
    } else {
        Ok(())
    }
}
pub(crate) async fn read_json(response: reqwest::Response) -> Result<Value> {
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => "图库拒绝认证，请检查用户名、令牌和账号权限".into(),
            300..=399 => "图库返回重定向，请直接填写最终 API 地址；不会向重定向目标发送令牌".into(),
            _ => format!("图库返回 HTTP {}，请检查 API 地址", status.as_u16()),
        });
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取图库响应失败")? {
        if bytes.len() + chunk.len() > 256 * 1024 {
            return Err("图库响应过大，请检查 API 地址".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "响应不是图库 JSON，请填写 API 根地址（通常以 /api 结尾）".into())
}
pub async fn test(store: &Store, mut config: Config, token: Option<String>) -> Result<Value> {
    let _operation = store.operation()?;
    config.normalize()?;
    if config.api_url.is_empty() {
        return Err("请填写图库 API 地址".into());
    }
    let token = token.filter(|s| !s.trim().is_empty()).or_else(|| {
        if config.username.is_empty() {
            None
        } else {
            provider::get_key(&config.credential_kind(), &config.api_url).ok()
        }
    });
    let authenticated = token.is_some();
    let mut authorization = None;
    if let Some(token) = token {
        if config.username.is_empty() {
            return Err("使用令牌测试时，请填写用户名".into());
        }
        validate_token(&token)?;
        let mut value = HeaderValue::from_str(&format!(
            "Token {}",
            STANDARD.encode(format!("{}:{}", config.username, token.trim()))
        ))
        .map_err(|_| "图库认证信息格式无效")?;
        value.set_sensitive(true);
        authorization = Some(value);
    }
    let policy = if config.direct {
        network::Settings {
            mode: network::Mode::Direct,
            proxy_url: String::new(),
        }
    } else {
        network::Settings::from_settings(&store.read()?["settings"])?
    };
    let client = policy.client(Duration::from_secs(20), Duration::from_secs(8))?;
    let started = Instant::now();
    let get = |url| {
        let req = client.get(url).header("Accept", "application/json");
        if let Some(value) = &authorization {
            req.header(AUTHORIZATION, value.clone())
        } else {
            req
        }
    };
    let info = read_json(
        get(config.endpoint(&["info"])?)
            .send()
            .await
            .map_err(|_| "连接图库失败，请检查地址、证书与网络设置")?,
    )
    .await?;
    if !info["config"]["privileges"].is_object() || !info["postCount"].is_number() {
        return Err("服务响应不符合 szurubooru API 格式".into());
    }
    let mut rank = Value::Null;
    if authenticated {
        let user = read_json(
            get(config.endpoint(&["user", &config.username])?)
                .send()
                .await
                .map_err(|_| "读取图库账号失败")?,
        )
        .await?;
        if !user["name"]
            .as_str()
            .is_some_and(|name| name.eq_ignore_ascii_case(&config.username))
        {
            return Err("图库返回的账号与配置不一致".into());
        }
        rank = user["rank"].clone();
    }
    Ok(json!({"authenticated":authenticated,"rank":rank,"elapsedMs":started.elapsed().as_millis()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(target_os = "windows")]
    fn windows_token_storage_is_scoped_and_can_be_cleared() {
        let c = Config {
            api_url: format!("https://{}.example.invalid/api", uuid::Uuid::new_v4()),
            username: "test-alice".into(),
            ..Config::default()
        };
        struct Cleanup(Config);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = provider::delete_key(&self.0.credential_kind(), &self.0.api_url);
            }
        }
        let _cleanup = Cleanup(c.clone());
        provider::save_key(&c.credential_kind(), &c.api_url, "synthetic-test-token").unwrap();
        assert!(c.has_token());
        assert_eq!(
            provider::get_key(&c.credential_kind(), &c.api_url).unwrap(),
            "synthetic-test-token"
        );
        let other_account = Config {
            username: "test-bob".into(),
            ..c.clone()
        };
        assert!(!other_account.has_token());
        let other_url = Config {
            api_url: format!("{}/other", c.api_url),
            ..c.clone()
        };
        assert!(!other_url.has_token());
        provider::delete_key(&c.credential_kind(), &c.api_url).unwrap();
        assert!(!c.has_token());
    }
    #[test]
    fn validates_address_and_scopes_credentials_to_account_and_api() {
        let mut c = Config {
            api_url: " HTTPS://BOORU.EXAMPLE:443/gallery/api/ ".into(),
            username: " alice ".into(),
            default_tags: vec![" blue_hair ".into(), "blue_hair".into(), "风景".into()],
            ..Config::default()
        };
        c.normalize().unwrap();
        assert_eq!(c.api_url, "https://booru.example/gallery/api");
        assert_eq!(
            c.endpoint(&["user", "a/b"]).unwrap().as_str(),
            "https://booru.example/gallery/api/user/a%2Fb"
        );
        assert_eq!(c.default_tags, vec!["blue_hair", "风景"]);
        let before = c.credential_kind();
        c.username = "bob".into();
        assert_ne!(before, c.credential_kind());
        for url in [
            "https://user:secret@example.com/api",
            "https://example.com/api?token=secret",
            "https://example.com/api#secret",
            "file:///tmp/api",
            "https://example.com/\napi",
        ] {
            c.api_url = url.into();
            assert!(c.normalize().is_err(), "{url}");
        }
        assert!(
            serde_json::from_value::<Config>(json!({"token":"never-store-in-sqlite"})).is_err()
        );
    }
    #[test]
    fn preferences_round_trip_without_modifying_studio_document() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE studio_state (document TEXT); INSERT INTO studio_state VALUES ('unchanged');").unwrap();
        assert_eq!(read_config(&db).unwrap(), Config::default());
        let c = Config {
            api_url: "https://example.com/api".into(),
            username: "alice".into(),
            upload_mode: UploadMode::AfterGeneration,
            include_prompt: false,
            ..Config::default()
        };
        write_config(&db, &c).unwrap();
        assert_eq!(read_config(&db).unwrap(), c);
        assert_eq!(
            db.query_row("SELECT document FROM studio_state", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "unchanged"
        );
    }
}
