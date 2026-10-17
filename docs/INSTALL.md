# Install guide

Two pieces:

1. **The TaleSpire mod** (TaleSpire Map Exporter). It runs inside TaleSpire and saves the board you're
   on to a file.
2. **The viewer app** (TaleSpire Map Viewer). It opens those files so you can shape the map, explore
   it, and take notes.

You only need to do this once per computer.

---

## macOS

TaleSpire's Mac version from Steam works with the mod, on both Apple Silicon (M1–M5) and Intel Macs.

### 1. Install the mod

You need the TS_MAP folder (this repository) on your Mac.

1. **Install the .NET SDK**, which builds the mod. Use either of these in Terminal:
   ```sh
   brew install --cask dotnet-sdk
   ```
   or, with no admin password:
   ```sh
   curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel LTS
   ```
2. **Run the installer** from the TS_MAP folder:
   ```sh
   mod/install-mac.sh
   ```
   It downloads BepInEx (the mod loader, checksum-verified) into TaleSpire's game folder, sets it up,
   builds the mod, and copies it in. You can run it again any time; it's safe.
3. **Set the Steam launch option.** The script prints this line at the end:
   - In Steam, right-click **TaleSpire → Properties → General → Launch Options**.
   - Paste the line:
     ```
     "/Users/<you>/Library/Application Support/Steam/steamapps/common/TaleSpire/run_bepinex.sh" %command%
     ```
4. **Start TaleSpire from Steam** as usual.

> On Apple Silicon the launcher starts TaleSpire through Rosetta (as an Intel app), because BepInEx
> can't patch games running natively on Apple Silicon. It runs a little slower but works. Rosetta is
> usually already installed; if not, macOS will offer to install it.

### 2. Install the viewer app

- **Prebuilt:** open `TaleSpire Map Viewer_<version>_aarch64.dmg` and drag the app into
  **Applications**. The DMG is in `app/src-tauri/target/release/bundle/dmg/` after a build, or wherever
  it was shared with you.
- **Build it yourself** (needs Rust, `rustup.rs`, and Node.js):
  ```sh
  cd app
  npm install
  npm run build
  ```

The app isn't signed with an Apple developer certificate. The first time, **right-click the app →
Open → Open**. If macOS says it's "damaged", run this once:
```sh
xattr -dr com.apple.quarantine "/Applications/TaleSpire Map Viewer.app"
```

---

## Windows

1. Install the **BepInExPack for TaleSpire** with r2modman, or manually from
   <https://talespire.thunderstore.io/package/bbepisTaleSpire/BepInExPack/>.
2. Install the **.NET SDK** (<https://dotnet.microsoft.com/download>).
3. Build and install the mod. It copies itself into `BepInEx/plugins` automatically:
   ```bat
   cd mod\TaleSpireMapExporter
   dotnet build -c Release
   ```
   If TaleSpire isn't in the default Steam folder, add
   `-p:TaleSpirePath="D:\Games\Steam\steamapps\common\TaleSpire"`.
4. Viewer: build the app on Windows (`cd app && npm install && npm run build`, which produces an
   installer in `app/src-tauri/target/release/bundle/`), or use the browser version (below).

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

Look in the TaleSpire game folder:

| What you see | Meaning | Fix |
|---|---|---|
| No `BepInEx/LogOutput.log` at all | BepInEx isn't starting | Check the Steam launch option, and start TaleSpire from **Steam** (not the `.app` directly) |
| `preloader_*.log` in `TaleSpire.app/Contents/MacOS/` | BepInEx crashed while starting | Re-run `mod/install-mac.sh` (it sets up the Rosetta launch) |
| Log exists but no `TaleSpire Map Exporter … loaded` | Mod isn't installed | Re-run `mod/install-mac.sh` and check `BepInEx/plugins/TaleSpireMapExporter/` |
| `loaded` is there, hotkey still silent | Keys not reaching the mod | Set `LogKeyPresses = true` under `[Diagnostics]` in `BepInEx/config/com.jsbertsch.talespiremapexporter.cfg`, restart, press the keys, and check the log |

The game folder on a Mac is
`~/Library/Application Support/Steam/steamapps/common/TaleSpire/`. In Steam: right-click TaleSpire →
Manage → Browse local files.

### Uninstall

- Clear the Steam launch option. TaleSpire then starts without any mods.
- Optionally delete `BepInEx/`, `run_bepinex.sh`, `libdoorstop.dylib`, `.doorstop_version` and
  `changelog.txt` from the game folder.
- Drag the viewer app to the Bin.

---

## Browser version (no app)

The viewer also runs in a browser. On a Mac, double-click **`open-viewer.command`** in the TS_MAP
folder. Anywhere else, run `python3 -m http.server 8765` in the TS_MAP folder and open
<http://localhost:8765/viewer/>. Opening `viewer/index.html` directly doesn't work, because browsers
block it. Without the app you load exports by dragging the file in, and notes are saved in that
browser.
