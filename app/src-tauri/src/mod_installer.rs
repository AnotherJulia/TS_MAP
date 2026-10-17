//! Installs the TaleSpire Map Exporter mod (BepInEx + plugin) into a TaleSpire install from
//! inside the viewer app. These are the same steps as mod/install-mac.sh and
//! mod/install-windows.ps1. Doing it here means a GM only has to approve one thing on first
//! launch (this app), not a separate unsigned installer script.
//!
//! The plugin ships inside the app as a resource (tauri.conf.json `bundle.resources`, from
//! mod/dist), so the installed mod always matches the app's version.

use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::path::BaseDirectory;
use tauri::Manager;

/// Folder holding the bundled plugin (TaleSpireMapExporter.dll + manifest.json): the app's
/// `mod/` resource folder. Everything below takes this as a plain path so it's testable.
pub fn bundled_mod_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve("mod", BaseDirectory::Resource)
        .map_err(|e| format!("Bundled mod files not found: {e}"))
}

const PLUGIN: &str = "TaleSpireMapExporter";
const STEAM_APP_ID: &str = "720620";
const BEPINEX_VERSION: &str = "5.4.23.5";

// Official BepInEx release assets and their SHA-256 (from GitHub's release metadata).
#[cfg(target_os = "macos")]
const BEPINEX_ZIP: (&str, &str) = (
    "BepInEx_macos_universal_5.4.23.5.zip",
    "01c2ae782eb016dfd6c345a18dbd2dcafffb3d9d318449d6486689f426b4a323",
);
#[cfg(target_os = "windows")]
const BEPINEX_ZIP: (&str, &str) = (
    "BepInEx_win_x64_5.4.23.5.zip",
    "82f9878551030f54657792c0740d9d51a09500eeae1fba21106b0c441e6732c4",
);
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const BEPINEX_ZIP: (&str, &str) = ("", "");

#[derive(Serialize)]
pub struct ModStatus {
    pub game_path: String,
    /// The folder looks like a TaleSpire install.
    pub valid: bool,
    pub bepinex: bool,
    /// Version of the installed plugin (from its manifest), if any.
    pub installed_version: Option<String>,
    /// Version of the plugin bundled with this app.
    pub bundled_version: String,
    /// macOS: the Steam launch option that starts TaleSpire through BepInEx.
    pub launch_option: Option<String>,
    /// macOS: whether Steam already has that launch option (read from Steam's localconfig.vdf).
    pub launch_option_set: Option<bool>,
    pub game_running: bool,
    pub platform: &'static str,
}

#[derive(Serialize)]
pub struct InstallReport {
    pub log: Vec<String>,
    pub status: ModStatus,
}

const PLATFORM: &str = if cfg!(target_os = "macos") {
    "macos"
} else if cfg!(target_os = "windows") {
    "windows"
} else {
    "other"
};

// --- finding TaleSpire -------------------------------------------------------------------

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default())
}

/// Accepts the TaleSpire folder itself, or (on macOS) TaleSpire.app / (on Windows) the exe.
pub fn normalize(path: &str) -> PathBuf {
    let p = PathBuf::from(path.trim());
    let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if name == "talespire.app" || name == "talespire.exe" {
        return p.parent().map(Path::to_path_buf).unwrap_or(p);
    }
    p
}

pub fn is_game_dir(dir: &Path) -> bool {
    if cfg!(target_os = "macos") {
        dir.join("TaleSpire.app").is_dir()
    } else if cfg!(target_os = "windows") {
        dir.join("TaleSpire.exe").is_file()
    } else {
        dir.join("TaleSpire.exe").is_file() || dir.join("TaleSpire.app").is_dir()
    }
}

#[cfg(target_os = "windows")]
fn steam_roots() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;
    let mut roots = Vec::new();
    if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Valve\\Steam") {
        if let Ok(p) = key.get_value::<String, _>("SteamPath") {
            roots.push(PathBuf::from(p.replace('/', "\\")));
        }
    }
    for sub in ["SOFTWARE\\WOW6432Node\\Valve\\Steam", "SOFTWARE\\Valve\\Steam"] {
        if let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(sub) {
            if let Ok(p) = key.get_value::<String, _>("InstallPath") {
                roots.push(PathBuf::from(p));
            }
        }
    }
    roots.push(PathBuf::from("C:\\Program Files (x86)\\Steam"));
    roots
}

#[cfg(not(target_os = "windows"))]
fn steam_roots() -> Vec<PathBuf> {
    vec![
        home().join("Library/Application Support/Steam"), // macOS
        home().join(".steam/steam"),                      // Linux
        home().join(".local/share/Steam"),
    ]
}

/// Every Steam library folder: each Steam root plus the extra libraries (other drives) listed
/// in steamapps/libraryfolders.vdf as `"path"  "D:\\SteamLibrary"`.
fn steam_libraries() -> Vec<PathBuf> {
    let mut libs: Vec<PathBuf> = Vec::new();
    for root in steam_roots() {
        if !root.is_dir() {
            continue;
        }
        libs.push(root.clone());
        if let Ok(vdf) = fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")) {
            for line in vdf.lines() {
                let line = line.trim();
                if let Some(rest) = line.strip_prefix("\"path\"") {
                    let parts: Vec<&str> = rest.split('"').collect();
                    if parts.len() >= 2 {
                        libs.push(PathBuf::from(parts[1].replace("\\\\", "\\")));
                    }
                }
            }
        }
    }
    libs.dedup();
    libs
}

pub fn detect() -> Option<PathBuf> {
    steam_libraries()
        .into_iter()
        .map(|lib| lib.join("steamapps").join("common").join("TaleSpire"))
        .find(|dir| is_game_dir(dir))
}

/// Where the folder picker should start: the Steam "common" folder, if there is one.
pub fn default_browse_dir() -> Option<PathBuf> {
    steam_libraries()
        .into_iter()
        .map(|lib| lib.join("steamapps").join("common"))
        .find(|dir| dir.is_dir())
}

// --- status ------------------------------------------------------------------------------

fn plugin_dir(game: &Path) -> PathBuf {
    game.join("BepInEx").join("plugins").join(PLUGIN)
}

fn manifest_version(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("version_number")?.as_str().map(str::to_string)
}

fn launch_option(game: &Path) -> String {
    format!("\"{}\" %command%", game.join("run_bepinex.sh").display())
}

/// macOS: does any Steam user have a TaleSpire launch option that runs run_bepinex.sh?
/// Read-only scan of userdata/*/config/localconfig.vdf (Steam rewrites that file itself, so
/// the app never edits it).
fn launch_option_set() -> bool {
    let userdata = home().join("Library/Application Support/Steam/userdata");
    let Ok(users) = fs::read_dir(userdata) else { return false };
    for user in users.flatten() {
        let Ok(vdf) = fs::read_to_string(user.path().join("config").join("localconfig.vdf")) else {
            continue;
        };
        let needle = format!("\"{STEAM_APP_ID}\"");
        let mut from = 0;
        while let Some(pos) = vdf[from..].find(&needle) {
            let start = from + pos;
            let end = (start + 4000).min(vdf.len());
            let window = vdf.get(start..end).unwrap_or("");
            if window
                .lines()
                .any(|l| l.contains("\"LaunchOptions\"") && l.contains("run_bepinex.sh"))
            {
                return true;
            }
            from = start + needle.len();
        }
    }
    false
}

fn hidden_command(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash
    }
    cmd
}

fn game_running() -> bool {
    if cfg!(target_os = "windows") {
        hidden_command("tasklist")
            .args(["/FI", "IMAGENAME eq TaleSpire.exe", "/NH"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("talespire.exe"))
            .unwrap_or(false)
    } else {
        hidden_command("pgrep")
            .args(["-f", "TaleSpire.app/Contents/MacOS/TaleSpire"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

pub fn status(bundled: &Path, game: &Path) -> ModStatus {
    let valid = is_game_dir(game);
    let plugin = plugin_dir(game);
    let installed_version = if plugin.join(format!("{PLUGIN}.dll")).is_file() {
        Some(manifest_version(&plugin.join("manifest.json")).unwrap_or_else(|| "unknown".into()))
    } else {
        None
    };
    let bundled_version = manifest_version(&bundled.join("manifest.json")).unwrap_or_else(|| "?".into());
    let mac = cfg!(target_os = "macos");
    ModStatus {
        game_path: game.display().to_string(),
        valid,
        bepinex: game.join("BepInEx").join("core").join("BepInEx.dll").is_file(),
        installed_version,
        bundled_version,
        launch_option: (mac && valid).then(|| launch_option(game)),
        launch_option_set: (mac && valid).then(launch_option_set),
        game_running: game_running(),
        platform: PLATFORM,
    }
}

// --- install / remove --------------------------------------------------------------------

fn download_bepinex(log: &mut Vec<String>) -> Result<Vec<u8>, String> {
    let (file, sha) = BEPINEX_ZIP;
    if file.is_empty() {
        return Err("Installing the mod from the app is supported on macOS and Windows only.".into());
    }
    let url = format!("https://github.com/BepInEx/BepInEx/releases/download/v{BEPINEX_VERSION}/{file}");
    log.push(format!("Downloading {file} ..."));
    let response = ureq::get(&url).call().map_err(|e| format!("Download failed: {e}"))?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(64 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Download failed: {e}"))?;
    let digest: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    if digest != sha {
        return Err(format!("Checksum mismatch for {file} - not installing (got {digest})."));
    }
    log.push("Checksum OK.".into());
    Ok(bytes)
}

fn extract_zip(bytes: Vec<u8>, dest: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else { continue }; // skips unsafe paths
        let out = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = fs::File::create(&out).map_err(|e| format!("{}: {e}", out.display()))?;
        std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&out, fs::Permissions::from_mode(mode));
        }
    }
    Ok(())
}

/// macOS: point run_bepinex.sh at TaleSpire.app and launch it as x86_64 under Rosetta -
/// BepInEx 5's MonoMod can't detour on Apple Silicon (the preloader crashes). Idempotent.
#[cfg(target_os = "macos")]
fn configure_mac_launcher(game: &Path, log: &mut Vec<String>) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let script = game.join("run_bepinex.sh");
    let text = fs::read_to_string(&script).map_err(|e| format!("{}: {e}", script.display()))?;
    let patched = text
        .replace("executable_name=\"\"\n", "executable_name=\"TaleSpire.app\"\n")
        .replace("export ARCHPREFERENCE=\"arm64,x86_64\"", "export ARCHPREFERENCE=\"x86_64\"")
        .replace("exec arch -e DYLD_INSERT_LIBRARIES=", "exec arch -x86_64 -e DYLD_INSERT_LIBRARIES=");
    if patched != text {
        fs::write(&script, patched).map_err(|e| e.to_string())?;
        log.push("Configured the launcher (TaleSpire.app, Rosetta).".into());
    }
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    for item in ["libdoorstop.dylib", "BepInEx"] {
        let _ = hidden_command("xattr").args(["-dr", "com.apple.quarantine"]).arg(game.join(item)).status();
    }
    Ok(())
}

fn ensure_game(game: &Path) -> Result<(), String> {
    if !is_game_dir(game) {
        return Err(format!(
            "{} doesn't look like the TaleSpire folder (it should contain {}).",
            game.display(),
            if cfg!(target_os = "macos") { "TaleSpire.app" } else { "TaleSpire.exe" }
        ));
    }
    if cfg!(target_os = "windows") && game_running() {
        return Err("TaleSpire is running - close it first (its files are in use).".into());
    }
    Ok(())
}

pub fn install(bundled: &Path, game: &Path) -> Result<InstallReport, String> {
    ensure_game(game)?;
    let mut log = Vec::new();

    if game.join("BepInEx").join("core").join("BepInEx.dll").is_file() {
        log.push("BepInEx is already installed.".into());
    } else {
        let bytes = download_bepinex(&mut log)?;
        extract_zip(bytes, game)?;
        log.push(format!("Installed BepInEx {BEPINEX_VERSION}."));
    }

    #[cfg(target_os = "macos")]
    configure_mac_launcher(game, &mut log)?;

    let dir = plugin_dir(game);
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for name in [format!("{PLUGIN}.dll"), "manifest.json".to_string()] {
        fs::copy(bundled.join(&name), dir.join(&name)).map_err(|e| format!("Copying {name}: {e}"))?;
    }
    let status = status(bundled, game);
    log.push(format!("Installed the mod v{} into {}.", status.bundled_version, dir.display()));
    if cfg!(target_os = "macos") && status.game_running {
        log.push("TaleSpire is running: restart it to load the new mod.".into());
    }
    Ok(InstallReport { log, status })
}

pub fn uninstall(bundled: &Path, game: &Path) -> Result<InstallReport, String> {
    ensure_game(game)?;
    let dir = plugin_dir(game);
    let mut log = Vec::new();
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        log.push(format!("Removed {}.", dir.display()));
    } else {
        log.push("The mod isn't installed.".into());
    }
    log.push("BepInEx itself was left in place (other mods may use it).".into());
    Ok(InstallReport { log, status: status(bundled, game) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundled() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../mod/dist")
    }

    fn fake_game() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ts-fake-game-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        if cfg!(target_os = "macos") {
            fs::create_dir_all(dir.join("TaleSpire.app/Contents/MacOS")).unwrap();
        } else {
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("TaleSpire.exe"), b"").unwrap();
        }
        dir
    }

    #[test]
    fn normalize_accepts_app_or_exe() {
        assert_eq!(normalize("/x/TaleSpire/TaleSpire.app"), PathBuf::from("/x/TaleSpire"));
        assert_eq!(normalize(" /x/TaleSpire "), PathBuf::from("/x/TaleSpire"));
    }

    #[test]
    fn status_of_non_game_folder() {
        let s = status(&bundled(), &std::env::temp_dir());
        assert!(!s.valid);
        assert_eq!(s.bundled_version, manifest_version(&bundled().join("manifest.json")).unwrap());
    }

    // Real install into a throwaway folder: downloads BepInEx, verifies, unpacks, configures
    // the launcher (macOS), copies the plugin; then reinstall and uninstall.
    #[test]
    fn install_update_uninstall() {
        let game = fake_game();
        let before = status(&bundled(), &game);
        assert!(before.valid && !before.bepinex && before.installed_version.is_none());

        let report = install(&bundled(), &game).expect("install");
        println!("{}", report.log.join("\n"));
        assert!(report.status.bepinex);
        assert_eq!(report.status.installed_version.as_deref(), Some(report.status.bundled_version.as_str()));
        if cfg!(target_os = "macos") {
            let script = fs::read_to_string(game.join("run_bepinex.sh")).unwrap();
            assert!(script.contains("executable_name=\"TaleSpire.app\""));
            assert!(script.contains("exec arch -x86_64 -e DYLD_INSERT_LIBRARIES="));
            assert!(report.status.launch_option.unwrap().ends_with("run_bepinex.sh\" %command%"));
        }

        let again = install(&bundled(), &game).expect("reinstall");
        assert!(again.log.iter().any(|l| l.contains("already installed")));

        let removed = uninstall(&bundled(), &game).expect("uninstall");
        assert!(removed.status.installed_version.is_none());
        assert!(removed.status.bepinex, "BepInEx is left in place");
        let _ = fs::remove_dir_all(&game);
    }

    #[test]
    fn detect_finds_real_install_if_present() {
        // Informational on machines with TaleSpire installed via Steam (read-only).
        let found = detect();
        println!("detected: {found:?}");
        if let Some(game) = found {
            let s = status(&bundled(), &game);
            println!(
                "real install: valid={} bepinex={} installed={:?} bundled={} launch_option_set={:?} running={}",
                s.valid, s.bepinex, s.installed_version, s.bundled_version, s.launch_option_set, s.game_running
            );
        }
    }
}
