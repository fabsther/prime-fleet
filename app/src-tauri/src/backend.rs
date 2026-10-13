use crate::sse::{Parser, SseEvent};
use reqwest::{
    header::{HeaderValue, AUTHORIZATION},
    Client, Method, Response, Url,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(debug_assertions)]
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

#[cfg(desktop)]
pub const IDENTIFIER: &str = "dev.primefleet.app";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Machine {
    pub id: String,
    pub name: String,
    pub url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_revision: Option<u64>,
}
impl ApiError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            status: None,
            code: code.into(),
            message: message.into(),
            current_revision: None,
        }
    }
}
impl From<String> for ApiError {
    fn from(message: String) -> Self {
        Self::new("secure_storage", &message)
    }
}
type Result<T> = std::result::Result<T, ApiError>;

#[cfg(debug_assertions)]
#[derive(Default)]
struct AuthObservation {
    saved_sha256: Option<String>,
    header: Option<HeaderDiagnostics>,
}

#[cfg(debug_assertions)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderDiagnostics {
    bytes: usize,
    sha256: String,
    token_bytes: usize,
    token_sha256: String,
}

#[cfg(debug_assertions)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthDiagnostics {
    storage_backend: &'static str,
    token_bytes: usize,
    token_sha256: String,
    token_format_valid: bool,
    read_back_stable: bool,
    // Unknown after app restart or if this process did not save the current token.
    save_round_trip_ok: Option<bool>,
    authorization: Option<HeaderDiagnostics>,
    authorization_matches_vault: Option<bool>,
}

#[cfg(debug_assertions)]
fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub struct Backend {
    pub config_dir: PathBuf,
    pub downloads_dir: PathBuf,
    client: Client,
    pub streams: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    #[cfg(debug_assertions)]
    auth_observations: Mutex<HashMap<String, AuthObservation>>,
}
impl Backend {
    pub fn new(config_dir: PathBuf, downloads_dir: PathBuf) -> Result<Self> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| ApiError::new("network", "Cannot create native HTTP client"))?;
        Ok(Self {
            config_dir,
            downloads_dir,
            client,
            streams: Mutex::new(HashMap::new()),
            #[cfg(debug_assertions)]
            auth_observations: Mutex::new(HashMap::new()),
        })
    }
    fn lock_config(&self) -> Result<std::fs::File> {
        // The GUI and CLI share config. OS file locks prevent cross-process lost updates.
        std::fs::create_dir_all(&self.config_dir)
            .map_err(|_| ApiError::new("config", "Cannot create config directory"))?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.config_dir.join("machines.lock"))
            .map_err(|_| ApiError::new("config", "Cannot open config lock"))?;
        file.lock()
            .map_err(|_| ApiError::new("config", "Cannot lock machine config"))?;
        Ok(file)
    }
    pub fn machines(&self) -> Result<Vec<Machine>> {
        let path = self.config_dir.join("machines.json");
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| ApiError::new("config", "Invalid machine metadata file")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(_) => Err(ApiError::new("config", "Cannot read machine metadata")),
        }
    }
    pub fn machine(&self, id: &str) -> Result<Machine> {
        self.machines()?
            .into_iter()
            .find(|m| m.id == id || m.name.eq_ignore_ascii_case(id))
            .ok_or_else(|| ApiError::new("unknown_machine", "Machine not configured"))
    }
    fn write_machines(&self, machines: &[Machine]) -> Result<()> {
        std::fs::create_dir_all(&self.config_dir)
            .map_err(|_| ApiError::new("config", "Cannot create config directory"))?;
        let mut file = tempfile::NamedTempFile::new_in(&self.config_dir)
            .map_err(|_| ApiError::new("config", "Cannot create metadata file"))?;
        serde_json::to_writer_pretty(&mut file, machines)
            .map_err(|_| ApiError::new("config", "Cannot serialize metadata"))?;
        file.flush()
            .and_then(|_| file.as_file().sync_all())
            .map_err(|_| ApiError::new("config", "Cannot flush metadata file"))?;
        file.persist(self.config_dir.join("machines.json"))
            .map_err(|_| ApiError::new("config", "Cannot replace metadata file"))?;
        Ok(())
    }
    pub fn save_machine(
        &self,
        app: Option<&AppHandle>,
        mut machine: Machine,
        token: Option<String>,
    ) -> Result<Machine> {
        let _lock = self.lock_config()?;
        if machine.id.is_empty() {
            machine.id = uuid::Uuid::new_v4().to_string();
        }
        if machine.id.len() > 128
            || !machine
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || machine.name.trim().is_empty()
            || machine.name.len() > 128
            || machine.name.chars().any(char::is_control)
        {
            return Err(ApiError::new(
                "validation",
                "Machine needs a valid id and name",
            ));
        }
        machine.name = machine.name.trim().to_owned();
        let url = base_url(&machine.url)?;
        machine.url = url.as_str().trim_end_matches('/').to_owned();
        let mut machines = self.machines()?;
        if machines
            .iter()
            .any(|m| m.id != machine.id && m.name.eq_ignore_ascii_case(&machine.name))
        {
            return Err(ApiError::new("validation", "Machine name already exists"));
        }
        let existing = machines.iter().find(|m| m.id == machine.id);
        let token = token
            .map(|t| validate_token(&t).map(str::to_owned))
            .transpose()?
            .filter(|t| !t.is_empty());
        if (existing.is_none() || existing.is_some_and(|m| m.url != machine.url)) && token.is_none()
        {
            return Err(ApiError::new(
                "validation",
                "A new machine or address needs a token",
            ));
        }
        let old_token = if token.is_some() {
            // Do not overwrite an existing secret if its rollback copy cannot be read.
            if existing.is_some() {
                Some(get_token(app, &machine.id)?)
            } else {
                get_token(app, &machine.id).ok()
            }
        } else {
            None
        };
        if let Some(ref token) = token {
            replace_token_verified(
                token,
                old_token.as_deref(),
                |value| set_token(app, &machine.id, value),
                || get_token(app, &machine.id),
                || remove_token(app, &machine.id),
            )?;
        }
        machines.retain(|m| m.id != machine.id);
        machines.push(machine.clone());
        if let Err(error) = self.write_machines(&machines) {
            if token.is_some() {
                restore_token(old_token.as_deref(), &mut |value| set_token(app, &machine.id, value),
                    &mut || get_token(app, &machine.id), &mut || remove_token(app, &machine.id))
                    .map_err(|_| ApiError::new("secure_storage", "Metadata save failed and token rollback failed; re-enter the token before retrying"))?;
            }
            return Err(error);
        }
        #[cfg(debug_assertions)]
        if let Some(token) = token {
            if let Ok(mut observations) = self.auth_observations.lock() {
                observations
                    .entry(machine.id.clone())
                    .or_default()
                    .saved_sha256 = Some(fingerprint(token.as_bytes()));
            }
        }
        Ok(machine)
    }
    pub fn remove_machine(&self, app: Option<&AppHandle>, id: &str) -> Result<()> {
        let _lock = self.lock_config()?;
        let machine = self.machine(id)?;
        remove_token(app, &machine.id)?;
        let mut machines = self.machines()?;
        machines.retain(|m| m.id != machine.id);
        self.write_machines(&machines)
    }
    fn authorization(&self, id: &str, token: &str) -> Result<HeaderValue> {
        let header = authorization_header(token)?;
        #[cfg(debug_assertions)]
        if let Ok(mut observations) = self.auth_observations.lock() {
            let bytes = header.as_bytes();
            let bearer = &bytes[b"Bearer ".len()..];
            observations.entry(id.to_owned()).or_default().header = Some(HeaderDiagnostics {
                bytes: bytes.len(),
                sha256: fingerprint(bytes),
                token_bytes: bearer.len(),
                token_sha256: fingerprint(bearer),
            });
        }
        #[cfg(not(debug_assertions))]
        let _ = id;
        Ok(header)
    }
    #[cfg(debug_assertions)]
    pub fn auth_diagnostics(&self, app: &AppHandle, id: &str) -> Result<AuthDiagnostics> {
        let _lock = self.lock_config()?;
        let machine = self.machine(id)?;
        let token = get_token(Some(app), &machine.id)?;
        let token_format_valid = validate_token(&token).is_ok_and(|t| !t.is_empty());
        let token_sha256 = fingerprint(token.as_bytes());
        let read_back_stable =
            get_token(Some(app), &machine.id).is_ok_and(|t| t.as_bytes() == token.as_bytes());
        let observations = self
            .auth_observations
            .lock()
            .map_err(|_| ApiError::new("secure_storage", "Auth diagnostics unavailable"))?;
        let observation = observations.get(&machine.id);
        let header = observation.and_then(|o| o.header.clone());
        Ok(AuthDiagnostics {
            storage_backend: if cfg!(target_os = "android") {
                "Android Keystore AES-GCM"
            } else {
                "OS credential store"
            },
            token_bytes: token.len(),
            token_sha256: token_sha256.clone(),
            token_format_valid,
            read_back_stable,
            save_round_trip_ok: observation
                .and_then(|o| o.saved_sha256.as_ref().map(|s| s == &token_sha256)),
            authorization_matches_vault: header
                .as_ref()
                .map(|h| h.token_bytes == token.len() && h.token_sha256 == token_sha256),
            authorization: header,
        })
    }
    fn request(
        &self,
        app: Option<&AppHandle>,
        id: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<reqwest::RequestBuilder> {
        let _lock = self.lock_config()?;
        let machine = self.machine(id)?;
        let url = api_url(&machine.url, path)?;
        let method = match method.to_ascii_uppercase().as_str() {
            "GET" => Method::GET,
            "HEAD" => Method::HEAD,
            "POST" => Method::POST,
            "PUT" => Method::PUT,
            "PATCH" => Method::PATCH,
            "DELETE" => Method::DELETE,
            _ => return Err(ApiError::new("validation", "Unsupported HTTP method")),
        };
        let token = get_token(app, &machine.id)?;
        let header = self.authorization(&machine.id, &token)?;
        let mut request = self
            .client
            .request(method, url)
            .header(AUTHORIZATION, header);
        // reqwest has no browser Origin header. Do not add one or follow redirects.
        if let Some(body) = body {
            request = request.json(&body);
        }
        Ok(request)
    }
    pub async fn api(
        &self,
        app: Option<&AppHandle>,
        id: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let response = self
            .request(app, id, method, path, body)?
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(|_| request_network_error(method))?;
        let status = response.status();
        let bytes = limited_body(response).await.map_err(|error| {
            if error.code == "network" && method.eq_ignore_ascii_case("GET") {
                request_network_error(method)
            } else {
                error
            }
        })?;
        if !status.is_success() {
            return Err(http_error(
                status.as_u16(),
                &serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            ));
        }
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| ApiError::new("response", "Studio returned invalid JSON"))
    }
    pub async fn stream(
        &self,
        app: &AppHandle,
        id: &str,
        path: &str,
        after: u64,
        mut on_event: impl FnMut(SseEvent) -> Result<()>,
    ) -> Result<()> {
        let request = {
            let _lock = self.lock_config()?;
            let machine = self.machine(id)?;
            let url = resume_url(&machine.url, path, after)?;
            let token = get_token(Some(app), &machine.id)?;
            let header = self.authorization(&machine.id, &token)?;
            self.client
                .get(url)
                .header(AUTHORIZATION, header)
                .header("Accept", "text/event-stream")
                .header("Last-Event-ID", after.to_string())
        };
        let mut response = request
            .send()
            .await
            .map_err(|_| ApiError::new("network", "Cannot open event stream"))?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let data = limited_body(response).await?;
            return Err(http_error(
                status,
                &serde_json::from_slice(&data).unwrap_or(Value::Null),
            ));
        }
        if !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("text/event-stream"))
        {
            return Err(ApiError::new("response", "Expected an SSE event stream"));
        }
        let mut parser = Parser::default();
        loop {
            // Studio heartbeats keep this alive. A silent/broken socket needs explicit caller resume.
            let chunk = tokio::time::timeout(Duration::from_secs(90), response.chunk())
                .await
                .map_err(|_| {
                    ApiError::new(
                        "stream_timeout",
                        "Event stream timed out; resume from the last cursor",
                    )
                })?
                .map_err(|_| {
                    ApiError::new(
                        "network",
                        "Event stream interrupted; resume from the last cursor",
                    )
                })?;
            let Some(chunk) = chunk else {
                return Ok(());
            };
            for event in parser.feed(&chunk).map_err(|e| ApiError::new("sse", &e))? {
                on_event(event)?;
            }
        }
    }
    pub async fn download(
        &self,
        app: Option<&AppHandle>,
        id: &str,
        path: &str,
        filename: String,
    ) -> Result<Value> {
        let mut response = self
            .request(app, id, "GET", path, None)?
            .timeout(Duration::from_secs(600))
            .send()
            .await
            .map_err(|_| ApiError::new("network", "Download request failed"))?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let data = limited_body(response).await?;
            return Err(http_error(
                status,
                &serde_json::from_slice(&data).unwrap_or(Value::Null),
            ));
        }
        std::fs::create_dir_all(&self.downloads_dir)
            .map_err(|_| ApiError::new("download", "Cannot create download directory"))?;
        let dest = self.downloads_dir.join(format!(
            "{}-{}",
            uuid::Uuid::new_v4(),
            safe_filename(&filename)
        ));
        // Temp + no-clobber rename: a failed download never leaves a plausible completed file.
        let parent = dest
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let temp = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| ApiError::new("download", "Cannot create download file"))?;
        let mut file = tokio::fs::File::from_std(
            temp.reopen()
                .map_err(|_| ApiError::new("download", "Cannot open download file"))?,
        );
        let mut bytes = 0u64;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| ApiError::new("network", "Download interrupted"))?
        {
            file.write_all(&chunk)
                .await
                .map_err(|_| ApiError::new("download", "Cannot write download"))?;
            bytes += chunk.len() as u64;
        }
        file.sync_all()
            .await
            .map_err(|_| ApiError::new("download", "Cannot flush download"))?;
        drop(file);
        temp.persist_noclobber(&dest).map_err(|_| {
            ApiError::new("download", "Destination already exists or cannot be saved")
        })?;
        Ok(json!({"path": dest.to_string_lossy(), "bytes": bytes}))
    }
}

// Android keyboards and clipboard/CLI input can add edge whitespace. Never accept
// whitespace inside a bearer token, non-ASCII, or control bytes in an HTTP header.
fn validate_token(token: &str) -> Result<&str> {
    // Empty means keep an existing credential. Never silently alter a supplied Studio token.
    if !token.is_empty()
        && (token.len() > 8192
            || !token.strip_prefix("pa_").is_some_and(|body| {
                !body.is_empty()
                    && body
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            }))
    {
        return Err(ApiError::new(
            "validation",
            "Token invalide : format pa_[A-Za-z0-9_-]+ requis, sans espace ni caractère ajouté.",
        ));
    }
    Ok(token)
}
fn authorization_header(token: &str) -> Result<HeaderValue> {
    let token = validate_token(token)?;
    if token.is_empty() {
        return Err(ApiError::new("validation", "Token is required"));
    }
    let mut header = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| ApiError::new("validation", "Invalid token format"))?;
    header.set_sensitive(true);
    Ok(header)
}
fn restore_token(
    old: Option<&str>,
    set: &mut impl FnMut(&str) -> Result<()>,
    get: &mut impl FnMut() -> Result<String>,
    remove: &mut impl FnMut() -> Result<()>,
) -> Result<()> {
    match old {
        Some(token) => {
            set(token)?;
            if get()?.as_bytes() != token.as_bytes() {
                return Err(ApiError::new(
                    "secure_storage",
                    "Token rollback read-back did not match",
                ));
            }
            Ok(())
        }
        None => remove(),
    }
}
fn replace_token_verified(
    token: &str,
    old: Option<&str>,
    mut set: impl FnMut(&str) -> Result<()>,
    mut get: impl FnMut() -> Result<String>,
    mut remove: impl FnMut() -> Result<()>,
) -> Result<()> {
    let result = set(token).and_then(|_| {
        if get()?.as_bytes() != token.as_bytes() {
            return Err(ApiError::new(
                "secure_storage",
                "Token storage read-back did not match; save cancelled",
            ));
        }
        Ok(())
    });
    if let Err(error) = result {
        restore_token(old, &mut set, &mut get, &mut remove).map_err(|_| {
            ApiError::new(
                "secure_storage",
                "Token save failed and rollback failed; re-enter the token before retrying",
            )
        })?;
        return Err(error);
    }
    Ok(())
}

fn get_token(app: Option<&AppHandle>, id: &str) -> Result<String> {
    if let Some(app) = app {
        return tauri_plugin_fleet_secrets::get(app, id).map_err(Into::into);
    }
    #[cfg(not(target_os = "android"))]
    {
        tauri_plugin_fleet_secrets::desktop_get(id).map_err(Into::into)
    }
    #[cfg(target_os = "android")]
    {
        Err(ApiError::new(
            "secure_storage",
            "Android storage requires the app runtime",
        ))
    }
}
fn set_token(app: Option<&AppHandle>, id: &str, token: &str) -> Result<()> {
    if let Some(app) = app {
        return tauri_plugin_fleet_secrets::set(app, id, token).map_err(Into::into);
    }
    #[cfg(not(target_os = "android"))]
    {
        tauri_plugin_fleet_secrets::desktop_set(id, token).map_err(Into::into)
    }
    #[cfg(target_os = "android")]
    {
        Err(ApiError::new(
            "secure_storage",
            "Android storage requires the app runtime",
        ))
    }
}
fn remove_token(app: Option<&AppHandle>, id: &str) -> Result<()> {
    if let Some(app) = app {
        return tauri_plugin_fleet_secrets::remove(app, id).map_err(Into::into);
    }
    #[cfg(not(target_os = "android"))]
    {
        tauri_plugin_fleet_secrets::desktop_remove(id).map_err(Into::into)
    }
    #[cfg(target_os = "android")]
    {
        Err(ApiError::new(
            "secure_storage",
            "Android storage requires the app runtime",
        ))
    }
}
fn base_url(address: &str) -> Result<Url> {
    let url =
        Url::parse(address).map_err(|_| ApiError::new("validation", "Invalid machine URL"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(ApiError::new(
            "validation",
            "Use an HTTPS machine origin without credentials, path, query or fragment",
        ));
    }
    Ok(url)
}
fn api_url(address: &str, path: &str) -> Result<Url> {
    let lower = path.to_ascii_lowercase();
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains(['\\', '#'])
        || path.chars().any(char::is_control)
        || ["%2e", "%2f", "%5c"]
            .iter()
            .any(|v| lower.split('?').next().unwrap_or("").contains(v))
        || path
            .split('?')
            .next()
            .unwrap_or("")
            .split('/')
            .any(|v| v == "." || v == "..")
    {
        return Err(ApiError::new("validation", "Use only a public API v1 path"));
    }
    let path = if path.starts_with("/api/v1/") {
        path.to_owned()
    } else {
        if path.starts_with("/api/") {
            return Err(ApiError::new(
                "validation",
                "Only public API v1 routes are allowed",
            ));
        }
        format!("/api/v1{path}")
    };
    base_url(address)?
        .join(&path)
        .map_err(|_| ApiError::new("validation", "Invalid API path"))
}
fn resume_url(address: &str, path: &str, after: u64) -> Result<Url> {
    let mut url = api_url(address, path)?;
    let pairs: Vec<_> = url
        .query_pairs()
        .filter(|(k, _)| k != "after")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    url.set_query(None);
    url.query_pairs_mut()
        .extend_pairs(pairs)
        .append_pair("after", &after.to_string());
    Ok(url)
}
fn safe_filename(name: &str) -> String {
    let name: String = name
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c))
        .take(180)
        .collect();
    let name = name.trim_matches([' ', '.']);
    if name.is_empty() {
        "studio-file".into()
    } else {
        name.into()
    }
}
async fn limited_body(mut response: Response) -> Result<Vec<u8>> {
    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ApiError::new("network", "Response interrupted; no automatic retry"))?
    {
        if data.len() + chunk.len() > 32 * 1024 * 1024 {
            return Err(ApiError::new(
                "response",
                "Response too large; use download for files",
            ));
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}
fn request_network_error(method: &str) -> ApiError {
    ApiError::new(
        "network",
        if method.eq_ignore_ascii_case("GET") {
            "Machine injoignable (vérifiez Tailscale)"
        } else {
            "Request failed; outcome may be unknown. No automatic retry."
        },
    )
}
fn http_error(status: u16, value: &Value) -> ApiError {
    ApiError {
        status: Some(status),
        code: value["code"].as_str().unwrap_or("http_error").into(),
        message: value["error"]
            .as_str()
            .unwrap_or("Studio request failed")
            .into(),
        current_revision: value["currentRevision"].as_u64(),
    }
}

pub fn emit_event(
    app: &AppHandle,
    stream_id: &str,
    machine_id: &str,
    path: &str,
    event: SseEvent,
) -> Result<()> {
    app.emit("fleet-stream", json!({"streamId": stream_id, "machineId": machine_id, "path": path, "event": event.data, "id": event.id}))
        .map_err(|_| ApiError::new("stream", "Cannot deliver stream event"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn studio_tokens_are_exact_and_headers_are_sensitive() {
        for input in ["pa_synthetic-token_123", "pa_a"] {
            assert_eq!(validate_token(input).unwrap(), input);
            let request = Client::new()
                .get("https://host/api/v1/machine")
                .header(AUTHORIZATION, authorization_header(input).unwrap())
                .build()
                .unwrap();
            let header = &request.headers()[AUTHORIZATION];
            assert_eq!(header.as_bytes(), format!("Bearer {input}").as_bytes());
            assert!(header.is_sensitive());
            assert!(!request.headers().contains_key("Origin"));
        }
        for invalid in [
            "pa_good`",
            "pa_good ",
            " pa_good",
            "pa_good\n",
            "pa_good\t",
            "pa_",
            "other_prefix",
            "pa_nonascii-\u{e9}",
            "pa_zero\u{200b}width",
            "pa_bad\0byte",
            "pa_good+",
        ] {
            assert!(
                validate_token(invalid).is_err(),
                "invalid synthetic fixture accepted"
            );
            assert!(authorization_header(invalid).is_err());
        }
        assert!(validate_token(&format!("pa_{}", "x".repeat(8190))).is_err());
        assert_eq!(validate_token("").unwrap(), "");
        assert!(authorization_header("").is_err());
    }
    #[test]
    fn token_save_rejects_truncation_and_restores_previous_secret() {
        use std::cell::RefCell;
        let vault = RefCell::new(Some("old-synthetic".to_owned()));
        for old in [Some("old-synthetic"), None] {
            *vault.borrow_mut() = old.map(str::to_owned);
            let result = replace_token_verified(
                "new-synthetic",
                old,
                |token| {
                    *vault.borrow_mut() = Some(
                        if token == "new-synthetic" {
                            "new"
                        } else {
                            token
                        }
                        .to_owned(),
                    );
                    Ok(())
                },
                || Ok(vault.borrow().clone().unwrap()),
                || {
                    *vault.borrow_mut() = None;
                    Ok(())
                },
            );
            assert_eq!(result.unwrap_err().code, "secure_storage");
            assert_eq!(vault.borrow().as_deref(), old);
        }
        replace_token_verified(
            "new-synthetic",
            None,
            |token| {
                *vault.borrow_mut() = Some(token.to_owned());
                Ok(())
            },
            || Ok(vault.borrow().clone().unwrap()),
            || {
                *vault.borrow_mut() = None;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(vault.borrow().as_deref(), Some("new-synthetic"));
        let failed = replace_token_verified(
            "synthetic",
            Some("old"),
            |_| Err(ApiError::new("secure_storage", "test write failure")),
            || panic!("must not read after failed write"),
            || Ok(()),
        );
        assert!(failed.unwrap_err().message.contains("rollback failed"));
    }
    #[cfg(debug_assertions)]
    #[test]
    fn diagnostics_hash_full_bytes_and_never_serialize_tokens() {
        assert_eq!(
            fingerprint(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let temp = tempfile::tempdir().unwrap();
        let backend = Backend::new(temp.path().to_owned(), temp.path().to_owned()).unwrap();
        let header = backend
            .authorization("synthetic-id", "pa_synthetic-token")
            .unwrap();
        let observations = backend.auth_observations.lock().unwrap();
        let observed = observations["synthetic-id"].header.as_ref().unwrap();
        assert_eq!(observed.sha256, fingerprint(header.as_bytes()));
        assert_eq!(observed.token_sha256, fingerprint(b"pa_synthetic-token"));
        let serialized = serde_json::to_string(observed).unwrap();
        assert!(!serialized.contains("pa_synthetic-token"));
        assert_eq!(observed.bytes, b"Bearer pa_synthetic-token".len());
    }

    #[test]
    fn invalid_studio_token_cannot_reach_secure_storage_or_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let backend = Backend::new(temp.path().to_owned(), temp.path().to_owned()).unwrap();
        for token in [
            "pa_synthetic`",
            "pa_synthetic ",
            " pa_synthetic",
            "wrong-prefix",
        ] {
            let error = backend
                .save_machine(
                    None,
                    Machine {
                        id: "synthetic-id".into(),
                        name: "Synthetic".into(),
                        url: "https://host".into(),
                    },
                    Some(token.into()),
                )
                .unwrap_err();
            assert_eq!(error.code, "validation");
            assert!(backend.machines().unwrap().is_empty());
            assert!(!temp.path().join("machines.json").exists());
        }
    }

    #[test]
    fn only_public_routes_and_https_without_credentials() {
        assert_eq!(
            api_url("https://alien18.example.ts.net", "/machine")
                .unwrap()
                .as_str(),
            "https://alien18.example.ts.net/api/v1/machine"
        );
        assert!(api_url("https://host", "/api/v1/runs/id/events?after=42").is_ok());
        for path in [
            "https://evil",
            "//evil",
            "/../internal",
            "/api/v1/%2e%2e/internal",
            "/api/v2/machine",
            "/machine#secret",
        ] {
            assert!(api_url("https://host", path).is_err(), "{path}");
        }
        for host in [
            "http://host",
            "https://user:secret@host",
            "https://host/internal",
            "https://host?x=1",
        ] {
            assert!(base_url(host).is_err());
        }
    }
    #[test]
    fn resume_replaces_cursor_and_requests_have_no_origin() {
        let url = resume_url(
            "https://host",
            "/runs/abc/events?after=1&other=x&after=2",
            42,
        )
        .unwrap();
        let request = Client::new()
            .get(url)
            .bearer_auth("test-placeholder")
            .header("Last-Event-ID", "42")
            .build()
            .unwrap();
        assert_eq!(request.url().query(), Some("other=x&after=42"));
        assert_eq!(request.headers()["Last-Event-ID"], "42");
        assert!(!request.headers().contains_key("Origin"));
        assert_eq!(safe_filename("../bad:file?.md"), "badfile.md");
        assert_eq!(safe_filename(".."), "studio-file");
    }
    #[test]
    fn separate_backend_handles_serialize_config_mutations() {
        let temp = tempfile::tempdir().unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|i| {
                let path = temp.path().to_owned();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let backend = Backend::new(path.clone(), path).unwrap();
                    barrier.wait();
                    let _lock = backend.lock_config().unwrap();
                    let mut machines = backend.machines().unwrap();
                    machines.push(Machine {
                        id: i.to_string(),
                        name: format!("M{i}"),
                        url: "https://host".into(),
                    });
                    backend.write_machines(&machines).unwrap();
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(
            Backend::new(temp.path().to_owned(), temp.path().to_owned())
                .unwrap()
                .machines()
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn get_network_errors_are_unreachable_but_writes_remain_uncertain() {
        for method in ["GET", "get"] {
            let error = request_network_error(method);
            assert_eq!(error.code, "network");
            assert_eq!(error.status, None);
            assert_eq!(error.message, "Machine injoignable (vérifiez Tailscale)");
        }
        for method in ["POST", "post", "PUT", "PATCH", "DELETE"] {
            assert_eq!(
                request_network_error(method).message,
                "Request failed; outcome may be unknown. No automatic retry."
            );
        }
    }
    #[test]
    fn metadata_has_no_token_and_error_preserves_revision() {
        assert!(serde_json::from_value::<Machine>(
            json!({"id":"a", "name":"A", "url":"https://a", "token":"secret"})
        )
        .is_err());
        let error = http_error(
            409,
            &json!({"code":"revision_conflict", "error":"Read again", "currentRevision":7}),
        );
        assert_eq!(error.status, Some(409));
        assert_eq!(error.code, "revision_conflict");
        assert_eq!(error.message, "Read again");
        assert_eq!(error.current_revision, Some(7));
        let temp = tempfile::tempdir().unwrap();
        let backend = Backend::new(temp.path().to_owned(), temp.path().to_owned()).unwrap();
        let machines = vec![Machine {
            id: "a".into(),
            name: "A".into(),
            url: "https://a".into(),
        }];
        backend.write_machines(&machines).unwrap();
        backend.write_machines(&machines).unwrap();
        assert_eq!(backend.machines().unwrap().len(), 1);
        assert_eq!(backend.machine("a").unwrap().name, "A");
        assert!(backend.machine("unknown").is_err());
    }
}
