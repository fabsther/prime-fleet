use tauri::{plugin::{Builder, TauriPlugin}, AppHandle, Runtime};
#[cfg(target_os = "android")]
use tauri::Manager;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("fleet-secrets").setup(|app, api| {
        #[cfg(target_os = "android")]
        app.manage(api.register_android_plugin("dev.primefleet.secrets", "SecretsPlugin")?);
        #[cfg(not(target_os = "android"))]
        let _ = (app, api);
        Ok(())
    }).build()
}

// No JS commands expose secrets. Only Fleet's native network layer reads them.
#[cfg(target_os = "android")]
fn call<R: Runtime>(app: &AppHandle<R>, command: &str, id: &str, token: Option<&str>) -> Result<serde_json::Value, String> {
    app.state::<tauri::plugin::PluginHandle<R>>()
        .run_mobile_plugin(command, serde_json::json!({"id": id, "token": token}))
        .map_err(|_| "Secure Android storage failed".into())
}

pub fn get<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<String, String> {
    #[cfg(target_os = "android")]
    { call(app, "get", id, None)?["token"].as_str().map(str::to_owned).ok_or_else(|| "Token not found in secure storage".into()) }
    #[cfg(not(target_os = "android"))]
    { let _ = app; desktop_get(id) }
}

pub fn set<R: Runtime>(app: &AppHandle<R>, id: &str, token: &str) -> Result<(), String> {
    #[cfg(target_os = "android")]
    { call(app, "set", id, Some(token))?; Ok(()) }
    #[cfg(not(target_os = "android"))]
    { let _ = app; desktop_set(id, token) }
}

pub fn remove<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    #[cfg(target_os = "android")]
    { call(app, "remove", id, None)?; Ok(()) }
    #[cfg(not(target_os = "android"))]
    { let _ = app; desktop_remove(id) }
}

#[cfg(not(target_os = "android"))]
fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("dev.primefleet.app", id).map_err(|_| "Cannot open OS credential store".into())
}
#[cfg(not(target_os = "android"))]
pub fn desktop_get(id: &str) -> Result<String, String> {
    entry(id)?.get_password().map_err(|_| "Token missing or OS credential store unavailable".into())
}
#[cfg(not(target_os = "android"))]
pub fn desktop_set(id: &str, token: &str) -> Result<(), String> {
    entry(id)?.set_password(token).map_err(|_| "Cannot save token in OS credential store".into())
}
#[cfg(not(target_os = "android"))]
pub fn desktop_remove(id: &str) -> Result<(), String> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Cannot delete token from OS credential store".into()),
    }
}
