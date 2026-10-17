# TS_MAP: TaleSpire boards → shaped 3D maps and netspace

Build a location in TaleSpire, export it with one key, then shape it in the **TaleSpire Map Viewer**
app:

- remove walls and roofs, and cut the map down to the part you want
- view it as a city map, a clean wireframe grid, or Cyberpunk 2077-style **cyberspace**
- walk a token across TaleSpire's grid, with movement counted in squares, feet or metres, including
  a first-person view
- pin location notes that players can read
- save the shaped result, to share or to import elsewhere (the plan is GridLinkOS netrunning)

The viewer draws the board's *shapes* (boxes from TaleSpire's own bounds), not TaleSpire's 3D
models.

**Setting up? → [docs/INSTALL.md](docs/INSTALL.md)**

## Using it

### In TaleSpire

| Key | Does |
|---|---|
| **Ctrl+Shift+E** | Export the board to `Documents/TaleSpireMapExporter/` |
| Ctrl+Shift+E with an area selected (TaleSpire's selection tool) | Export only that area |

A message at the top of the screen confirms each export.

### In the viewer

Click **Open latest export**. New exports also pop up a notice you can click.

**Tools** (left panel, or keys 1–4):

| Tool | What it's for |
|---|---|
| **1 Look** | Left-drag rotates, Shift-drag pans. Hover a marker to read its note. |
| **2 Select** | Click a piece, or drag a box to select many (Shift adds). **Delete** removes. Also: *Keep only these*, *Select same type* (e.g. every piece of one roof), *Cut to selection*, *Undo* (Ctrl/Cmd+Z), *Restore all*. |
| **3 Token** | Click a floor to place the token; click elsewhere and it walks there on the grid around walls. Arrow keys step, PgUp/PgDn change floor, Shift-click places without walking. Moves are counted in 5 ft, 2 m (Cyberpunk RED) or plain squares. |
| **4 Notes** | Click a building to add a location note; click a marker to edit it. |

**Cut panel:** sliders trim the map from each side and from above or below. **[** and **]** move the
top cut down and up (with Shift, the bottom cut), so you can look under roofs like TaleSpire's
height slider.

**Camera** (TaleSpire-style): **WASD** move · **Q/E** rotate · **R/F** up/down · right-drag rotate ·
middle-drag pan · wheel or pinch zoom · **Shift** faster · **Home** frame the map · **M** top-down
map view.

**Styles** (**G** cycles):

| Style | Look |
|---|---|
| Map | Shaded city blocks, height-tinted, with light strips as "subway" lines |
| Wireframe grid | Glowing edges and TaleSpire's grid on near-black |
| Cyberspace (2077) | Cyberpunk 2077's netspace/braindance look: black masses made of fine glowing specks (dots on floors and walls, a few drip streaks), floating particles, light carried by the pawn and irregular scan pulses |

**First person (V):** press **V** to see through the token's eyes. If there's no token yet, it's
placed on the floor in the middle of the view. **Click a floor to walk there** (along the grid,
counted), drag to look, **WASD** steps, **Q/E** turn, **V** or **Esc** to leave. Pairs best with the
Cyberspace style.

**Cyberspace controls** (Tools panel, shown in that style only):

- **Detail:** speck size, from coarse to very fine.
- **Light from below (B):** each wall glows near its own floor and fades upward.
- With a token placed, the pawn carries the light (about 7 squares) and sends out scan pulses at
  irregular intervals.

**Saving:** everything (notes, removals, cuts, token) saves automatically per board.

- **Save map + notes** writes a single file that brings all of it back when loaded anywhere.
- **Export shaped map** writes only what's left after removing and cutting, as a normal export file.

## Development

- `viewer/` has no build step. Edit and reload; in the app, rebuild with `cd app && npm run build`.
- **Check shaders after editing any GLSL:** `node viewer/tools/check-shaders.mjs` (needs
  `brew install glslang`). WebGL reports a broken shader only as a silent black screen. For example,
  `patch` is a reserved word in GLSL ES 3.0.
- How the Cyberspace style works (`viewer/js/cyberspace.js`):
  - the specks are drawn per pixel in the board's box shader, on a fine grid on each face
  - floor stalks, wall fuzz, drips, relief specks and dust are real particles, regenerated when
    pieces are removed
  - post-processing adds tight bloom, plus fringing and smear at the screen edges and a vignette
- Movement grid and pathfinding: `viewer/js/grid.js` (pure, testable with Node). Camera:
  `viewer/js/controls.js`. Export normalisation: `viewer/js/data.js`.

## Repository layout

| Folder | What |
|---|---|
| `mod/` | BepInEx plugin for TaleSpire (C#) and `install-mac.sh`. See [mod/README.md](mod/README.md). |
| `viewer/` | The viewer: static HTML/JS with three.js vendored in (no build step, works offline). |
| `app/` | Tauri desktop wrapper around `viewer/`, plus native file access to the export folder. See [app/README.md](app/README.md). |
| `schema/` | The export file format ([export-schema.md](schema/export-schema.md)). |
| `docs/` | [Install guide](docs/INSTALL.md). |
| `open-viewer.command` | Runs the viewer in a browser instead of the app (macOS). |
