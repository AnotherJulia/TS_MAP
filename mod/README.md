# TaleSpireMapExporter (BepInEx plugin)

A BepInEx/Harmony plugin that exports the currently placed board content (tiles, walls, props,
creatures) to a JSON file, for viewing in `../viewer/`. See `../schema/export-schema.md` for the
exact file format.

## Status

Builds and loads, and the hotkey/config/file-writing pipeline works end-to-end - but it currently
exports an **empty board** (`objects: []`). The one piece not implemented yet is reading TaleSpire's
actual live board state (`BoardExporter.GatherPlacedObjects` in `TaleSpireMapExporter/BoardExporter.cs`),
because the runtime class that holds all placed tiles/props isn't publicly documented anywhere. See
"Next step" below - this is the main thing to do next.

## Prerequisites (Windows, since TaleSpire/BepInEx are Windows-only)

- TaleSpire installed via Steam, with the community BepInExPack installed (via r2modman/Thunderstore,
  or manually - see https://talespire.thunderstore.io/package/bbepisTaleSpire/BepInExPack/).
- .NET SDK matching `net472` (the Visual Studio Build Tools / `dotnet` CLI both work).
- [ILSpy](https://github.com/icsharpcode/ILSpy) or [dnSpy](https://github.com/dnSpy/dnSpy) for the
  "next step" below.

## Build

```
cd mod/TaleSpireMapExporter
dotnet build -p:TaleSpirePath="C:\Program Files (x86)\Steam\steamapps\common\TaleSpire"
```

Omit `-p:TaleSpirePath=...` if TaleSpire is installed at the default path already hardcoded as the
fallback in the `.csproj`.

## Install

Copy the built `TaleSpireMapExporter.dll` (and `manifest.json`, copied alongside it automatically)
into `TaleSpire/BepInEx/plugins/TaleSpireMapExporter/`, then launch TaleSpire. Check
`BepInEx/LogOutput.log` for a `TaleSpire Map Exporter v0.1.0 loaded` line to confirm it's running.

## Use

Load a board, press **Ctrl+Shift+E** (configurable in `BepInEx/config/com.jsbertsch.talespiremapexporter.cfg`
after the first run), and a JSON file will appear in `Documents/TaleSpireMapExporter/`. Drag that file
into the web viewer (`../viewer/index.html`).

## Next step: wiring up real board data

`BoardExporter.GatherPlacedObjects` currently just logs a warning and returns an empty list. To make
it real:

1. Open the installed `TaleSpire_Data/Managed/Assembly-CSharp.dll` in ILSpy/dnSpy and search for
   whatever manages **currently placed, non-creature** board content (tiles/walls/props) - creatures
   are already known to be reachable via `Bouncyrock.TaleSpire.Runtime`'s creature manager (the same
   one LordAshes' InterfacePlugin uses to look up a `CreatureBoardAsset` by id/name).
2. Once you've found the class/collection, log its count and a few sample entries first (position,
   rotation, asset GUID) to confirm the data looks sane, before wiring up full serialization.
3. Fill in `GatherPlacedObjects` and `TryGetBoardName` using what you found - there's a commented
   sketch in `BoardExporter.cs` showing the expected shape.
4. Optionally point `AssetIndexPath` (in the generated config file) at a community `index.json` asset
   database so exports get real names/categories instead of raw GUIDs.

Report back what you find (class names, field names, sample logged values) so the export/category
logic and the viewer's coordinate-mapping assumptions can be corrected against real data.
