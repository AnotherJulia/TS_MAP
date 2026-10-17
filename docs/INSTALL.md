# Install guide

Two pieces:

1. **The viewer app** (TaleSpire Map Viewer). It opens exported boards so you can shape the map,
   explore it, and take notes. **It also installs the mod for you.**
2. **The TaleSpire mod** (TaleSpire Map Exporter). It runs inside TaleSpire and saves the board you're
   on to a file when you press Ctrl+Shift+E.

You only do this once per computer. Works on Windows 10/11 (64-bit) and macOS (Apple Silicon and
Intel) with TaleSpire from Steam.

---

## Recommended: install the app, let it install the mod

1. **Download** the zip for your platform from the repository's **Releases** page and extract it.
   Each zip has a step-by-step `How to install.html`.
2. **Install the app** from `1 - Viewer app`:
   - **Windows:** run the setup `.exe`. If SmartScreen shows "Windows protected your PC", click
     **More info → Run anyway**. It installs for your user only (no admin needed).
   - **macOS:** open the `.dmg` and drag the app into Applications. The first launch says *"Apple could
     not verify…"* because the app isn't notarized. Click **Done**, then go to **System Settings →
     Privacy & Security**, click **Open Anyway** next to the blocked app, and confirm. (The old
     right-click → Open trick no longer works on macOS 15+.) Alternatively, run this once:
     ```sh
     xattr -dr com.apple.quarantine "/Applications/TaleSpire Map Viewer.app"
     ```
3. **In the app, click _Install TaleSpire mod_** (start screen, or **TaleSpire mod…** in the side
   panel):
   - **Detect** finds TaleSpire in your Steam libraries, on any drive. **Browse…** lets you pick the
     folder yourself: the one containing `TaleSpire.exe` / `TaleSpire.app`.
   - **Install mod** downloads BepInEx (the mod loader, from the official release, checksum-verified),
     sets it up, and installs the mod bundled with the app. On Windows, close TaleSpire first.
   - **macOS only:** click **Copy** next to the launch option the app shows. In Steam, right-click
     **TaleSpire → Properties → General → Launch Options** and paste it. The panel shows ✓ once Steam
     has it.
4. **Start TaleSpire from Steam.**

The panel shows what's installed (BepInEx, mod version, launch option) and offers **Update mod**
when a newer app ships a newer mod. **Remove mod** uninstalls it.

> **Apple Silicon:** with the mod, TaleSpire starts through Rosetta (as an Intel app), because BepInEx
> can't patch games running natively on Apple Silicon. It runs a little slower but works.

> **r2modman / Thunderstore users (Windows):** if you start TaleSpire through r2modman, BepInEx runs
> from your r2modman profile instead of the game folder. Copy `BepInEx\plugins\TaleSpireMapExporter`
> from the game folder into the profile's `BepInEx\plugins` folder.

---

## Alternative: script installers

For installing the mod without the app. They're in the release zip's `Manual mod install (optional)`
folder, or in `mod/` in this repository.

- **Windows:** close TaleSpire and double-click `Install mod.bat` (in the repo: `mod/install-windows.bat`).
  If it can't find TaleSpire, run it from PowerShell with the folder:
  ```powershell
  .\install-windows.ps1 -GamePath "D:\SteamLibrary\steamapps\common\TaleSpire"
  ```
  Other options: `-Build` builds the mod from source (needs the .NET SDK and this repository), and
  `-Uninstall [-RemoveBepInEx]` removes it.
- **macOS:** in Terminal, type `bash ` and drag in `install-mac.sh`, then press Return. (Double-clicking
  `Install mod.command` also works, after allowing it under Privacy & Security → Open Anyway.) Then set
  the Steam launch option it prints. In the repository, `mod/install-mac.sh` builds from source if the
  .NET SDK is installed, and otherwise uses `mod/dist`.

---

## From source (developers)

- **Mod:** `mod/build-dist.sh` builds the plugin into `mod/dist/`. The installers and the app use that
  copy. `dotnet build` in `mod/TaleSpireMapExporter` also deploys straight into a local TaleSpire.
- **App:** needs Rust (<https://rustup.rs>) and Node.js. Run `cd app && npm install && npm run build`;
  see [app/README.md](../app/README.md).

---

## Check that it works

1. Start TaleSpire and open a board.
2. Press **Ctrl+Shift+E**. On a Mac that's the **Control** key, not Command.
3. A message appears at the top of the TaleSpire window:
   `Exported "<board>" (N objects)` plus the file path.
4. In the viewer app, click **Open latest export**.

To export **only part of a board**, select that area with TaleSpire's own selection tool first, then
press Ctrl+Shift+E. The message says "Exported selection of …".

### If the hotkey does nothing

First open **TaleSpire mod…** in the app: every line should show ✓. Then look in the TaleSpire game
folder:

| What you see | Meaning | Fix |
|---|---|---|
| No `BepInEx/LogOutput.log` at all | BepInEx isn't starting | **Mac:** check the Steam launch option, and start TaleSpire from **Steam**. **Windows:** check `winhttp.dll` and `doorstop_config.ini` are next to `TaleSpire.exe` (click **Reinstall mod**); antivirus sometimes quarantines `winhttp.dll` |
| `preloader_*.log` in `TaleSpire.app/Contents/MacOS/` | BepInEx crashed while starting | Click **Reinstall mod** in the app (it sets up the Rosetta launch) |
| Log exists but no `TaleSpire Map Exporter … loaded` | Mod isn't installed | **Install mod** in the app, and check `BepInEx/plugins/TaleSpireMapExporter/` |
| `loaded` is there, hotkey still silent | Keys not reaching the mod | Set `LogKeyPresses = true` under `[Diagnostics]` in `BepInEx/config/com.jsbertsch.talespiremapexporter.cfg`, restart, press the keys, and check the log |

The game folder on a Mac is
`~/Library/Application Support/Steam/steamapps/common/TaleSpire/`. In Steam: right-click TaleSpire →
Manage → Browse local files.

### Uninstall

- **Mod:** **TaleSpire mod… → Remove mod** in the app. On macOS, also clear the Steam launch option.
  BepInEx itself stays; to remove it too, delete `BepInEx/`, `run_bepinex.sh` / `winhttp.dll`,
  `libdoorstop.dylib` / `doorstop_config.ini`, `.doorstop_version` and `changelog.txt` from the game
  folder.
- **App:** Windows: Settings → Apps. macOS: drag it to the Bin.

---

## Browser version (no app)

The viewer also runs in a browser, without the mod installer and folder access. On a Mac,
double-click **`open-viewer.command`** in the TS_MAP folder. Anywhere else, run
`python3 -m http.server 8765` in the TS_MAP folder and open <http://localhost:8765/viewer/>. Opening
`viewer/index.html` directly doesn't work, because browsers block it. In the browser you load exports
by dragging the file in, and notes are saved in that browser.
