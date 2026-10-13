mod backend;
mod sse;

use backend::{ApiError, Backend, Machine};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(debug_assertions)]
#[tauri::command]
fn auth_diagnostics(
    app: AppHandle,
    state: State<'_, Backend>,
    machine_id: String,
) -> Result<backend::AuthDiagnostics, ApiError> {
    state.auth_diagnostics(&app, &machine_id)
}

#[tauri::command]
fn machines(state: State<'_, Backend>) -> Result<Vec<Machine>, ApiError> {
    state.machines()
}
#[tauri::command]
fn save_machine(
    app: AppHandle,
    state: State<'_, Backend>,
    machine: Machine,
    token: Option<String>,
) -> Result<Vec<Machine>, ApiError> {
    state.save_machine(Some(&app), machine, token)?;
    state.machines()
}
#[tauri::command]
fn remove_machine(
    app: AppHandle,
    state: State<'_, Backend>,
    machine_id: String,
) -> Result<Vec<Machine>, ApiError> {
    state.remove_machine(Some(&app), &machine_id)?;
    state.machines()
}
#[tauri::command]
async fn api(
    app: AppHandle,
    state: State<'_, Backend>,
    machine_id: String,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, ApiError> {
    state
        .api(Some(&app), &machine_id, &method, &path, body)
        .await
}
#[tauri::command]
fn stream(
    app: AppHandle,
    state: State<'_, Backend>,
    machine_id: String,
    path: String,
    after: Option<u64>,
) -> Result<String, ApiError> {
    state.machine(&machine_id)?;
    let stream_id = uuid::Uuid::new_v4().to_string();
    let id = stream_id.clone();
    let (start, ready) = tokio::sync::oneshot::channel();
    let task_app = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        if ready.await.is_err() {
            return;
        }
        let backend = task_app.state::<Backend>();
        let result = backend
            .stream(&task_app, &machine_id, &path, after.unwrap_or(0), |event| {
                backend::emit_event(&task_app, &id, &machine_id, &path, event)
            })
            .await;
        if let Ok(mut streams) = backend.streams.lock() {
            streams.remove(&id);
        }
        let _ = task_app.emit(
            "fleet-stream-end",
            json!({"streamId":id, "machineId":machine_id, "path":path, "error":result.err()}),
        );
    });
    let mut streams = state
        .streams
        .lock()
        .map_err(|_| ApiError::new("stream", "Stream registry unavailable"))?;
    streams.insert(stream_id.clone(), task.inner().abort_handle());
    let _ = start.send(());
    Ok(stream_id)
}
#[tauri::command]
fn stop_stream(state: State<'_, Backend>, stream_id: String) -> Result<(), ApiError> {
    let mut streams = state
        .streams
        .lock()
        .map_err(|_| ApiError::new("stream", "Stream registry unavailable"))?;
    if let Some(stream) = streams.remove(&stream_id) {
        stream.abort();
    }
    Ok(())
}
#[tauri::command]
async fn download(
    app: AppHandle,
    state: State<'_, Backend>,
    machine_id: String,
    path: String,
    filename: String,
) -> Result<Value, ApiError> {
    state
        .download(Some(&app), &machine_id, &path, filename)
        .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fleet_secrets::init())
        .setup(|app| {
            let config = app.path().app_config_dir()?;
            #[cfg(desktop)]
            let downloads = app
                .path()
                .download_dir()
                .unwrap_or(app.path().app_data_dir()?.join("downloads"));
            #[cfg(mobile)]
            let downloads = app.path().app_data_dir()?.join("downloads");
            let backend =
                Backend::new(config, downloads).map_err(|e| std::io::Error::other(e.message))?;
            app.manage(backend);
            Ok(())
        });
    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        machines,
        save_machine,
        remove_machine,
        api,
        stream,
        stop_stream,
        download,
        auth_diagnostics
    ]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        machines,
        save_machine,
        remove_machine,
        api,
        stream,
        stop_stream,
        download
    ]);
    builder
        .run(tauri::generate_context!())
        .expect("Cannot start Prime Fleet");
}

#[cfg(desktop)]
pub fn cli(args: Vec<String>) -> i32 {
    use std::io::{IsTerminal, Read};
    let execute = || -> Result<Value, ApiError> {
        let config = dirs::config_dir()
            .ok_or_else(|| ApiError::new("config", "OS config directory unavailable"))?
            .join(backend::IDENTIFIER);
        let downloads = dirs::download_dir().unwrap_or_else(|| config.join("downloads"));
        let backend = Backend::new(config, downloads)?;
        match args.first().map(String::as_str) {
            Some("machines") if args.len() == 1 => serde_json::to_value(backend.machines()?)
                .map_err(|_| ApiError::new("config", "Cannot serialize machines")),
            Some("add") if args.len() == 3 || args.len() == 4 => {
                let mut token = String::new();
                if args.len() == 4 && args[3] != "--token-stdin" {
                    token = args[3].clone();
                } else if args.len() == 4 || !std::io::stdin().is_terminal() {
                    std::io::stdin()
                        .read_to_string(&mut token)
                        .map_err(|_| ApiError::new("input", "Cannot read token from stdin"))?;
                    token = token.trim_end_matches(['\r', '\n']).to_owned();
                } else {
                    eprint!("Token (hidden): ");
                    token = rpassword::read_password()
                        .map_err(|_| ApiError::new("input", "Cannot read token securely"))?;
                }
                if token.is_empty() {
                    return Err(ApiError::new("input", "Token is required"));
                }
                let id = backend
                    .machine(&args[1])
                    .map(|m| m.id)
                    .unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());
                backend.save_machine(
                    None,
                    Machine {
                        id,
                        name: args[1].clone(),
                        url: args[2].clone(),
                    },
                    Some(token),
                )?;
                serde_json::to_value(backend.machines()?)
                    .map_err(|_| ApiError::new("config", "Cannot serialize machines"))
            }
            Some("remove") if args.len() == 2 => {
                backend.remove_machine(None, &args[1])?;
                Ok(json!(backend.machines()?))
            }
            Some("api") if args.len() == 4 || args.len() == 5 => {
                let body = args
                    .get(4)
                    .map(|s| {
                        serde_json::from_str(s)
                            .map_err(|_| ApiError::new("input", "Body must be valid JSON"))
                    })
                    .transpose()?;
                let runtime = tokio::runtime::Runtime::new()
                    .map_err(|_| ApiError::new("runtime", "Cannot start HTTP runtime"))?;
                runtime.block_on(backend.api(None, &args[1], &args[2], &args[3], body))
            }
            Some("--help") | Some("help") => Ok(
                json!({"usage":["prime-fleet machines", "prime-fleet add <name> <https-url> [token|--token-stdin]", "prime-fleet remove <machine>", "prime-fleet api <machine> <METHOD> <path> [json]"],"tokens":"Prefer hidden prompt or stdin; argv tokens can appear in OS process listings"}),
            ),
            _ => Err(ApiError::new("usage", "Use prime-fleet --help")),
        }
    };
    match execute() {
        Ok(value) => {
            println!("{}", value);
            0
        }
        Err(error) => {
            eprintln!(
                "{}",
                serde_json::to_string(&error).unwrap_or_else(|_| "{\"code\":\"error\"}".into())
            );
            1
        }
    }
}
