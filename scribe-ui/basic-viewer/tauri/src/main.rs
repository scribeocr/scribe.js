// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_cli::CliExt;

/// Managed state that stores the initial CLI args so the frontend can pull them
/// after its event listeners are ready (avoids race conditions).
struct InitialArgs(Mutex<serde_json::Value>);

/// Parse `--key=value` arguments from an argv array.
fn parse_args(argv: &[String]) -> HashMap<String, String> {
    let mut args = HashMap::new();
    for arg in argv {
        if let Some(rest) = arg.strip_prefix("--") {
            if let Some((key, value)) = rest.split_once('=') {
                args.insert(key.to_string(), value.to_string());
            }
        }
    }
    args
}

/// Convert CLI plugin matches to a HashMap.
fn cli_matches_to_map(matches: &tauri_plugin_cli::Matches) -> HashMap<String, String> {
    let mut args = HashMap::new();
    for (key, value) in &matches.args {
        if let Some(s) = value.value.as_str() {
            args.insert(key.clone(), s.to_string());
        }
    }
    args
}

/// Build a JSON payload from parsed args, matching the Electron IPC format.
fn args_to_payload(args: &HashMap<String, String>) -> serde_json::Value {
    let action = args.get("action").map(|s| s.as_str()).unwrap_or("load");
    match action {
        "navigate" => {
            let page: i64 = args
                .get("page")
                .and_then(|p| p.parse().ok())
                .unwrap_or(0);
            serde_json::json!({ "event": "viewer-navigate", "data": { "page": page } })
        }
        "highlight" => {
            let highlights_str = args.get("highlights").map(|s| s.as_str()).unwrap_or("[]");
            let highlights: serde_json::Value =
                serde_json::from_str(highlights_str).unwrap_or(serde_json::json!([]));
            serde_json::json!({ "event": "viewer-highlight", "data": { "highlights": highlights } })
        }
        _ => {
            if let Some(file) = args.get("file") {
                let page: i64 = args
                    .get("page")
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(0);
                let abs_path = std::path::Path::new(file)
                    .canonicalize()
                    .unwrap_or_else(|_| std::path::PathBuf::from(file));
                serde_json::json!({
                    "event": "load-file",
                    "data": { "file": abs_path.to_string_lossy(), "page": page }
                })
            } else {
                serde_json::json!({ "event": "none" })
            }
        }
    }
}

/// Emit the appropriate event to the frontend based on a payload.
fn emit_payload(app: &tauri::AppHandle, payload: &serde_json::Value) {
    let event = payload["event"].as_str().unwrap_or("none");
    if event == "none" {
        return;
    }
    let _ = app.emit(event, &payload["data"]);
}

/// Read a file from disk and return its bytes.
#[tauri::command]
fn read_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
}

/// Return the initial CLI args payload so the frontend can process them
/// after setting up event listeners.
#[tauri::command]
fn get_initial_args(state: tauri::State<'_, InitialArgs>) -> serde_json::Value {
    state.0.lock().unwrap().clone()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Second instance launched — parse its args and emit to the existing window.
            let args = parse_args(&argv);
            let payload = args_to_payload(&args);
            emit_payload(app, &payload);

            // Focus/restore the existing window.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![read_file, get_initial_args])
        .setup(|app| {
            // Parse CLI args from the initial launch and store them.
            let payload = match app.cli().matches() {
                Ok(matches) => {
                    let args = cli_matches_to_map(&matches);
                    args_to_payload(&args)
                }
                Err(_) => serde_json::json!({ "event": "none" }),
            };
            app.manage(InitialArgs(Mutex::new(payload)));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
