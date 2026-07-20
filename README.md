# TS_MAP — TaleSpire Board → 3D Vector Map Viewer

Exports the currently placed slabs/tiles/props/creatures from a TaleSpire board and renders them as
an abstract 3D vector map in a browser. Renders geometry (position/rotation/size), not TaleSpire's
actual (proprietary) 3D models — boxes and wireframes, color-coded by category.

## Layout

- `mod/` — the BepInEx/Harmony C# plugin that runs inside TaleSpire and exports a JSON snapshot of
  the current board. See `mod/README.md` for build/install instructions and current status.
- `viewer/` — a static, no-build-step Three.js web page that loads an exported JSON file and renders
  it. Fully working today against the synthetic sample export.
- `schema/` — the JSON contract shared between the two (`export-schema.md`), plus
  `sample-export.json`, a synthetic example used to develop/test the viewer without TaleSpire running.

## Workflow

1. Build and install the plugin (`mod/README.md`), launch TaleSpire, load a board.
2. Press **Ctrl+Shift+E** to export the board to a JSON file in `Documents/TaleSpireMapExporter/`.
3. Open `viewer/index.html` in a browser and drag that JSON file onto the page (or use the "Load
   export…" picker).

## Current status

- **Viewer**: done and tested against `schema/sample-export.json` (a synthetic small room). Open
  `viewer/index.html` — it auto-loads the sample when served over http(s), or drag the file in
  manually when opened directly via `file://`.
- **Mod**: builds and loads, hotkey/config/file-writing all work, but it currently exports an empty
  board. The one remaining piece is reading TaleSpire's real placed-object data at runtime — see
  "Next step" in `mod/README.md`. This requires a Windows TaleSpire install to investigate and test,
  so it's the next thing to pick up there.
- Coordinate mapping (Unity left-handed → Three.js right-handed) is implemented as a best-guess
  single-axis flip in `viewer/main.js` and needs confirming against a real export once the mod's
  data-reading step is done.
