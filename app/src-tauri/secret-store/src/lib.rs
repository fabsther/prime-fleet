#[cfg(target_os = "android")]
use tauri::Manager;
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("fleet-secrets")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            app.manage(api.register_android_plugin("dev.primefleet.secrets", "SecretsPlugin")?);
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(any(target_os = "android", test))]
fn secret_payload(id: &str, token: Option<&str>) -> serde_json::Value {
    serde_json::json!({"id": id, "token": token})
}
#[cfg(any(target_os = "android", test))]
fn response_token(response: &serde_json::Value) -> Result<String, String> {
    response["token"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "Token not found in secure storage".into())
}

// No JS commands expose secrets. Only Fleet's native network layer reads them.
#[cfg(target_os = "android")]
fn call<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    id: &str,
    token: Option<&str>,
) -> Result<serde_json::Value, String> {
    app.state::<tauri::plugin::PluginHandle<R>>()
        .run_mobile_plugin(command, secret_payload(id, token))
        .map_err(|_| "Secure Android storage failed".into())
}

pub fn get<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        response_token(&call(app, "get", id, None)?)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        desktop_get(id)
    }
}

pub fn set<R: Runtime>(app: &AppHandle<R>, id: &str, token: &str) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        call(app, "set", id, Some(token)).map(|_| ())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        desktop_set(id, token)
    }
}

pub fn remove<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        call(app, "remove", id, None).map(|_| ())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        desktop_remove(id)
    }
}

#[cfg(not(target_os = "android"))]
fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("dev.primefleet.app", id)
        .map_err(|_| "Cannot open OS credential store".into())
}
#[cfg(not(target_os = "android"))]
pub fn desktop_get(id: &str) -> Result<String, String> {
    entry(id)?
        .get_password()
        .map_err(|_| "Token missing or OS credential store unavailable".into())
}
#[cfg(not(target_os = "android"))]
pub fn desktop_set(id: &str, token: &str) -> Result<(), String> {
    entry(id)?
        .set_password(token)
        .map_err(|_| "Cannot save token in OS credential store".into())
}
#[cfg(not(target_os = "android"))]
pub fn desktop_remove(id: &str) -> Result<(), String> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Cannot delete token from OS credential store".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn android_bridge_json_preserves_full_token_bytes() {
        for token in ["synthetic-token_123+/=\"\\".to_owned(), "x".repeat(8192)] {
            let payload = secret_payload("synthetic-machine-id", Some(&token));
            let serialized = serde_json::to_vec(&payload).unwrap();
            let received: serde_json::Value = serde_json::from_slice(&serialized).unwrap();
            assert_eq!(received["id"], "synthetic-machine-id");
            assert_eq!(
                received["token"].as_str().unwrap().as_bytes(),
                token.as_bytes()
            );
            let response = serde_json::json!({"token": received["token"]});
            let response: serde_json::Value =
                serde_json::from_slice(&serde_json::to_vec(&response).unwrap()).unwrap();
            assert_eq!(
                response_token(&response).unwrap().as_bytes(),
                token.as_bytes()
            );
        }
        assert!(response_token(&serde_json::json!({"token": null})).is_err());
        assert!(response_token(&serde_json::json!({"token": 123})).is_err());
        assert_eq!(
            secret_payload("synthetic-id", None)["token"],
            serde_json::Value::Null
        );
    }
}
