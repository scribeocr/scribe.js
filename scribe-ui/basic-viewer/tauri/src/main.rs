// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_cli::CliExt;

/// Managed state that stores the initial CLI args so the frontend can pull them
/// after its event listeners are ready (avoids race conditions).
struct InitialArgs(Mutex<serde_json::Value>);

/// Whether the frontend has pulled the initial args yet.
struct ArgsConsumed(AtomicBool);

/// Handles to the menu items whose enabled and checked state tracks the frontend.
#[cfg(target_os = "macos")]
struct MenuHandles {
    print: tauri::menu::MenuItem<tauri::Wry>,
    recognize: tauri::menu::MenuItem<tauri::Wry>,
    export_pdf: tauri::menu::MenuItem<tauri::Wry>,
    combine: tauri::menu::MenuItem<tauri::Wry>,
    split: tauri::menu::MenuItem<tauri::Wry>,
    rotate_left: tauri::menu::MenuItem<tauri::Wry>,
    rotate_right: tauri::menu::MenuItem<tauri::Wry>,
    cover: tauri::menu::CheckMenuItem<tauri::Wry>,
    fields: tauri::menu::CheckMenuItem<tauri::Wry>,
    dark: tauri::menu::CheckMenuItem<tauri::Wry>,
}

/// Parse `--key=value` arguments from an argv array.
/// A bare positional argument is a file path (what a double-clicked file association passes).
fn parse_args(argv: &[String]) -> HashMap<String, String> {
    let mut args = HashMap::new();
    for arg in argv.iter().skip(1) {
        if let Some(rest) = arg.strip_prefix("--") {
            if let Some((key, value)) = rest.split_once('=') {
                args.insert(key.to_string(), value.to_string());
            }
        } else if !arg.starts_with('-') && !args.contains_key("file") {
            args.insert("file".to_string(), arg.to_string());
        }
    }
    args
}

/// Convert CLI plugin matches to a HashMap.
/// The positional `path` arg (a double-clicked file) folds into `file`.
fn cli_matches_to_map(matches: &tauri_plugin_cli::Matches) -> HashMap<String, String> {
    let mut args = HashMap::new();
    for (key, value) in &matches.args {
        if let Some(s) = value.value.as_str() {
            let key = if key == "path" { "file" } else { key };
            args.entry(key.to_string()).or_insert_with(|| s.to_string());
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

/// Apply the frontend's menu state to the native menu items: enabled flags and checkmarks.
#[tauri::command]
fn sync_menu(app: tauri::AppHandle, state: serde_json::Value) {
    #[cfg(target_os = "macos")]
    if let Some(h) = app.try_state::<MenuHandles>() {
        let flag = |key: &str| state.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
        let doc = flag("docOpen");
        let _ = h.print.set_enabled(doc);
        let _ = h.export_pdf.set_enabled(doc);
        let _ = h.rotate_left.set_enabled(doc);
        let _ = h.rotate_right.set_enabled(doc);
        let _ = h.recognize.set_enabled(flag("recognize"));
        let _ = h.combine.set_enabled(flag("combine"));
        let _ = h.split.set_enabled(flag("split"));
        let _ = h.cover.set_enabled(flag("coverEnabled"));
        let _ = h.cover.set_checked(flag("coverChecked"));
        let _ = h.fields.set_enabled(flag("fieldsEnabled"));
        let _ = h.fields.set_checked(flag("fieldsChecked"));
        let _ = h.dark.set_checked(flag("darkChecked"));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, state);
}

/// Return the initial CLI args payload so the frontend can process them
/// after setting up event listeners.
#[tauri::command]
fn get_initial_args(
    state: tauri::State<'_, InitialArgs>,
    consumed: tauri::State<'_, ArgsConsumed>,
) -> serde_json::Value {
    consumed.0.store(true, Ordering::SeqCst);
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
        .invoke_handler(tauri::generate_handler![read_file, get_initial_args, sync_menu])
        .on_menu_event(|app, event| {
            // Forward the app-command items to the frontend; predefined items handle themselves natively.
            let id = event.id().as_ref();
            match id {
                "open" | "print" | "recognize" | "export-pdf" | "combine" | "split"
                | "rotate-left" | "rotate-right" | "cover-alone" | "dark-mode"
                | "highlight-fields" => {
                    let _ = app.emit("menu-action", id);
                }
                "website" => {
                    let _ = std::process::Command::new("open")
                        .arg("https://viewer.21.ai")
                        .spawn();
                }
                _ => {}
            }
        })
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
            app.manage(ArgsConsumed(AtomicBool::new(false)));

            // macOS gets a real application menu carrying the app's commands; the in-window menu button is hidden there.
            // Document-gated items start disabled, and the frontend pushes their live state through `sync_menu`.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{
                    AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu,
                };
                let app_menu = Submenu::with_items(
                    app,
                    "21 Viewer",
                    true,
                    &[
                        &PredefinedMenuItem::about(
                            app,
                            None,
                            Some(AboutMetadata {
                                name: Some("21 Viewer".into()),
                                version: Some(app.package_info().version.to_string()),
                                ..Default::default()
                            }),
                        )?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::services(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::hide(app, None)?,
                        &PredefinedMenuItem::hide_others(app, None)?,
                        &PredefinedMenuItem::show_all(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::quit(app, None)?,
                    ],
                )?;
                let open = MenuItem::with_id(app, "open", "Open…", true, Some("CmdOrCtrl+O"))?;
                let recognize =
                    MenuItem::with_id(app, "recognize", "Recognize Text…", false, None::<&str>)?;
                let export_pdf =
                    MenuItem::with_id(app, "export-pdf", "Export as PDF…", false, None::<&str>)?;
                let combine = MenuItem::with_id(
                    app,
                    "combine",
                    "Combine Open Documents…",
                    false,
                    None::<&str>,
                )?;
                let split =
                    MenuItem::with_id(app, "split", "Split at Bookmarks", false, None::<&str>)?;
                let print =
                    MenuItem::with_id(app, "print", "Print…", false, Some("CmdOrCtrl+P"))?;
                let file_menu = Submenu::with_items(
                    app,
                    "File",
                    true,
                    &[
                        &open,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::close_window(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &recognize,
                        &export_pdf,
                        &combine,
                        &split,
                        &PredefinedMenuItem::separator(app)?,
                        &print,
                    ],
                )?;
                let edit_menu = Submenu::with_items(
                    app,
                    "Edit",
                    true,
                    &[
                        &PredefinedMenuItem::undo(app, None)?,
                        &PredefinedMenuItem::redo(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::cut(app, None)?,
                        &PredefinedMenuItem::copy(app, None)?,
                        &PredefinedMenuItem::paste(app, None)?,
                        &PredefinedMenuItem::select_all(app, None)?,
                    ],
                )?;
                let rotate_left = MenuItem::with_id(
                    app,
                    "rotate-left",
                    "Rotate Left",
                    false,
                    Some("Shift+CmdOrCtrl+L"),
                )?;
                let rotate_right = MenuItem::with_id(
                    app,
                    "rotate-right",
                    "Rotate Right",
                    false,
                    Some("Shift+CmdOrCtrl+R"),
                )?;
                let cover = CheckMenuItem::with_id(
                    app,
                    "cover-alone",
                    "Separate Cover Page",
                    false,
                    false,
                    None::<&str>,
                )?;
                let fields = CheckMenuItem::with_id(
                    app,
                    "highlight-fields",
                    "Highlight Fields",
                    false,
                    false,
                    None::<&str>,
                )?;
                let dark = CheckMenuItem::with_id(
                    app,
                    "dark-mode",
                    "Dark Mode",
                    true,
                    false,
                    None::<&str>,
                )?;
                let view_menu = Submenu::with_items(
                    app,
                    "View",
                    true,
                    &[
                        &rotate_left,
                        &rotate_right,
                        &PredefinedMenuItem::separator(app)?,
                        &cover,
                        &fields,
                        &dark,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::fullscreen(app, None)?,
                    ],
                )?;
                let window_menu = Submenu::with_items(
                    app,
                    "Window",
                    true,
                    &[
                        &PredefinedMenuItem::minimize(app, None)?,
                        &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
                    ],
                )?;
                let help_menu = Submenu::with_items(
                    app,
                    "Help",
                    true,
                    &[&MenuItem::with_id(
                        app,
                        "website",
                        "21 Viewer Website",
                        true,
                        None::<&str>,
                    )?],
                )?;
                let menu = Menu::with_items(
                    app,
                    &[
                        &app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu,
                    ],
                )?;
                app.set_menu(menu)?;
                app.manage(MenuHandles {
                    print,
                    recognize,
                    export_pdf,
                    combine,
                    split,
                    rotate_left,
                    rotate_right,
                    cover,
                    fields,
                    dark,
                });
            }

            // First paint matches the app's canvas color for the active theme, so launch
            // does not flash a mismatched background before the webview renders.
            if let Some(window) = app.get_webview_window("main") {
                let dark = matches!(window.theme(), Ok(tauri::Theme::Dark));
                let color = if dark {
                    tauri::window::Color(0x12, 0x15, 0x1b, 0xff)
                } else {
                    tauri::window::Color(0xf4, 0xf6, 0xfa, 0xff)
                };
                let _ = window.set_background_color(Some(color));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // macOS delivers file opens (double-click, "Open With", drag onto the Dock icon) as an event rather than argv.
            // Windows and Linux pass a positional path through argv, which parse_args and the CLI plugin already handle.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                for path in urls.iter().filter_map(|u| u.to_file_path().ok()) {
                    let payload = serde_json::json!({
                        "event": "load-file",
                        "data": { "file": path.to_string_lossy(), "page": 0 }
                    });
                    if app_handle.state::<ArgsConsumed>().0.load(Ordering::SeqCst) {
                        emit_payload(app_handle, &payload);
                    } else {
                        // The frontend has not pulled its initial args yet, so a launch-by-open lands there instead of racing the listener setup.
                        *app_handle.state::<InitialArgs>().0.lock().unwrap() = payload;
                    }
                }
            }
            let _ = (&app_handle, &event);
        });
}
