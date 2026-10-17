# TaleSpire Map Viewer (desktop app)

A [Tauri v2](https://v2.tauri.app) shell around `../viewer`. The viewer is unchanged, plain HTML/JS.
The app adds:

- direct access to `Documents/TaleSpireMapExporter/` (the mod's export folder), so the GM never picks
  files: **Open latest export**, a recent-exports list, and a notice when a new export appears
- saving "map + notes" and "shaped" files straight into that folder
- **Show exports folder** (Finder / Explorer)

Those commands are in `src-tauri/src/lib.rs`. They only accept plain `*.json` file names inside the
export folder, never paths, so the page can't read or write anywhere else.

## Build

Needs Rust (<https://rustup.rs>) and Node.js.

```sh
cd app
npm install
npm run build      # -> src-tauri/target/release/bundle/{macos,dmg}/
npm run dev        # run without bundling, for development
```

`frontendDist` points straight at `../../viewer`, so a rebuild picks up viewer changes with no copy
step. `viewer/` vendors three.js (`viewer/vendor/three`, r160), so the app works offline.

If bundling fails with a `bundle_dmg.sh` error, an older DMG from a previous build is probably still
mounted (or the app is running from it). Eject it in Finder and build again. To skip the DMG and
just install locally:

```sh
npx tauri build --bundles app
ditto "src-tauri/target/release/bundle/macos/TaleSpire Map Viewer.app" "/Applications/TaleSpire Map Viewer.app"
```

Don't launch the app from a build's temporary disk image (`/Volumes/dmg.*`): it's a stale copy, and
it blocks the next DMG build.

## Icon

`icon.svg` is the source; regenerate the icon set with `npx tauri icon icon.svg -o src-tauri/icons`,
then delete the `android/`, `ios/` and `Square*` outputs.
