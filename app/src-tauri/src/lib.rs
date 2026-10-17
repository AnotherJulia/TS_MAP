//! Desktop shell around the static viewer in ../../viewer. The viewer does all the
//! rendering; these commands just give it direct access to the folder the TaleSpire mod
//! exports into (Documents/TaleSpireMapExporter, the mod's default ExportFolder), so the
//! GM never has to hunt for files.

mod mod_installer;

use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::Manager;

const EXPORT_FOLDER_NAME: &str = "TaleSpireMapExporter";

#[derive(Serialize)]
struct ExportEntry {
    name: String,
    modified_ms: u64,
}

fn exports_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    Ok(docs.join(EXPORT_FOLDER_NAME))
}

/// Only plain `*.json` file names inside the exports folder - never a path - so the
/// webview can't be used to read or write anywhere else.
fn checked_file(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let is_plain = !name.is_empty()
        && !name.contains(['/', '\\'])
        && name != "."
        && name != ".."
        && name.to_lowercase().ends_with(".json");
    if !is_plain {
        return Err(format!("Not a valid export file name: {name}"));
    }
    Ok(exports_dir(app)?.join(name))
}

/// Exports in the folder, newest first.
#[tauri::command]
fn list_exports(app: tauri::AppHandle) -> Result<Vec<ExportEntry>, String> {
    let dir = exports_dir(&app)?;
    let Ok(read_dir) = fs::read_dir(&dir) else {
        return Ok(Vec::new()); // folder doesn't exist until the first export
    };

    let mut entries: Vec<ExportEntry> = read_dir
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("json")))
        .filter_map(|e| {
            let modified = e.metadata().ok()?.modified().ok()?;
            Some(ExportEntry {
                name: e.file_name().to_string_lossy().into_owned(),
                modified_ms: modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64,
            })
        })
        .collect();
    entries.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(entries)
}

#[tauri::command]
fn read_export(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let path = checked_file(&app, &name)?;
    fs::read_to_string(&path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))
}

/// Writes "map + notes" files next to the exports; returns the full path for display.
#[tauri::command]
fn save_map_file(app: tauri::AppHandle, name: String, contents: String) -> Result<String, String> {
    let path = checked_file(&app, &name)?;
    fs::create_dir_all(exports_dir(&app)?).map_err(|e| e.to_string())?;
    fs::write(&path, contents).map_err(|e| format!("Couldn't write {}: {e}", path.display()))?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn open_exports_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = exports_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let program = "xdg-open";

    std::process::Command::new(program)
        .arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open {}: {e}", dir.display()))
}

// --- TaleSpire mod installer (see mod_installer.rs) ---------------------------------------

/// Auto-detected TaleSpire folder (searches every Steam library), if any.
#[tauri::command]
fn talespire_detect() -> Option<String> {
    mod_installer::detect().map(|p| p.display().to_string())
}

#[tauri::command]
fn talespire_status(app: tauri::AppHandle, path: String) -> Result<mod_installer::ModStatus, String> {
    let bundled = mod_installer::bundled_mod_dir(&app)?;
    Ok(mod_installer::status(&bundled, &mod_installer::normalize(&path)))
}

/// Native folder picker for the TaleSpire folder. Async so the blocking dialog stays off the
/// main thread.
#[tauri::command]
async fn talespire_pick(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file().set_title("Select your TaleSpire folder");
    if let Some(dir) = mod_installer::default_browse_dir() {
        dialog = dialog.set_directory(dir);
    }
    let picked = dialog.blocking_pick_folder()?;
    let path = picked.into_path().ok()?;
    Some(mod_installer::normalize(&path.display().to_string()).display().to_string())
}

/// Downloads BepInEx if needed and installs the bundled plugin. Runs on a worker thread
/// (it downloads), so the window stays responsive.
#[tauri::command]
async fn talespire_install(app: tauri::AppHandle, path: String) -> Result<mod_installer::InstallReport, String> {
    let game = mod_installer::normalize(&path);
    let bundled = mod_installer::bundled_mod_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || mod_installer::install(&bundled, &game))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn talespire_uninstall(app: tauri::AppHandle, path: String) -> Result<mod_installer::InstallReport, String> {
    let game = mod_installer::normalize(&path);
    let bundled = mod_installer::bundled_mod_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || mod_installer::uninstall(&bundled, &game))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_exports,
            read_export,
            save_map_file,
            open_exports_folder,
            talespire_detect,
            talespire_status,
            talespire_pick,
            talespire_install,
            talespire_uninstall
        ])
        .run(tauri::generate_context!())
        .expect("error while running TaleSpire Map Viewer");
}
