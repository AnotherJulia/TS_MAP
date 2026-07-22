# TaleSpireMapExporter (BepInEx plugin)

A BepInEx/Harmony plugin that exports the currently placed board content (tiles, walls, props,
creatures) to a JSON file, for viewing in `../viewer/`. See `../schema/export-schema.md` for the
exact file format.

## Status

Builds and loads, and exports the **whole board** - creatures *and* tiles/walls/props.
`BoardExporter.GatherPlacedObjects` (`TaleSpireMapExporter/BoardExporter.cs`) reads:

- **Creatures** - live position/rotation from each placed creature's Transform, found by matching
  the `CreatureBoardAsset` component TaleSpire attaches to them.
- **Tiles/walls/props** - read from the board data model. Each `Board` holds a `Zones` collection
  (~589 spatial 16-unit grid cells); each `Zone.InactiveSet` (`InactiveZoneData`) has two parallel
  lists: `Placeables` (`NativeGreedyList<Placeable>`, one per instance, carrying `WorldOrigin`/
  `SelectionBounds`/`Rotation`) and `Layouts` (`NativeList<PlaceableLayout>`, one per asset run,
  carrying the asset `ContentGuid`, `AssetCount`, and `Kind`). Walking `Layouts` in order, each
  layout owns the next `AssetCount` consecutive `Placeables`, giving asset GUID + world transform
  for every placed object.

The one thing that blocked this earlier was that `NativeGreedyList<T>` exposes its element count as
**`ActiveLength`** (not `Count`/`Length`) alongside a normal int indexer - once the game's own
assemblies were decompiled (`ilspycmd` against `TaleSpire_Data/Managed/*.dll`) that was obvious, and
`ReflectionDumper` now recognises it. See "How the data model was found" below for the full trail.

Rotation is a Y-axis rotation in 24 steps of 15 deg (`DataModel.AssetMath`); the exporter emits it
as a quaternion. Positions are world-space (`Placeable.WorldOrigin`); `SelectionBounds.size` gives a
per-object AABB you can extrude a box mesh from in the viewer.

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

## How the data model was found (historical trail)

This is done - `GatherPlacedObjects` reads the full board (see Status above). The diagnostic
hotkeys below (`SceneScanner.cs`, `ReflectionDumper.cs`) are what mapped the data model without
reading disassembled code cold: let the running game tell you what exists first, then decompile one
already-known class to confirm exact member names. Kept for future spelunking (e.g. adding lights,
atmosphere, or GM data to the export). The final confirmation step used `ilspycmd` (a global dotnet
tool: `dotnet tool install -g ilspycmd`) against `TaleSpire_Data/Managed/*.dll` -
`Bouncyrock.TaleSpire.DataModel.Runtime.dll` holds `Placeable`, `PlaceableLayout`, `Zone`,
`InactiveZoneData`; `Bouncyrock.BouncePackage.Runtime.dll` holds `NativeGreedyList<T>`.

1. **Scan the live scene instead of guessing from source.** Press the scan hotkey (default
   **Ctrl+Alt+E**, configurable in the generated `.cfg` alongside the export hotkey) while a board is
   loaded. This writes `scene-scan_<timestamp>.txt` to the export folder - a plain-text dump of every
   root GameObject's hierarchy path plus its component type names (`SceneScanner.cs`). No decompiler
   needed for this step.

   In practice, walls/floors/props turned out **not** to be individual named GameObjects the way
   creatures are (`Character(Clone)` with `CreatureBoardAsset`) - a scan of a real populated board
   found zero non-creature `(Clone)` instances, and the only `TsAsset`-tagged objects present were a
   one-of-each asset catalog (no duplicates), not placed content. So placed tiles/props are tracked as
   *data* somewhere, not as one-GameObject-per-tile. The scan did surface the likely home for that
   data though: a manager cluster under `SingletonHub` alongside `CreatureManager` -
   `BoardSessionManager`, `BoardSyncManager`, `BoardPersistenceManager`, `SectorDownloadManager`, and
   `MovableManager`. `MovableManager` is the leading candidate (sits right next to `CreatureManager`,
   and a `MovableHandle` component shows up as the manipulation handle for whatever's selected).

2. **Reflect over candidates instead of decompiling them.** Press the inspect hotkey (default
   **Ctrl+Alt+I**) while a board is loaded. This finds every live instance whose type name matches
   any of `InspectTypeName` (comma-separated; defaults to `BoardSessionManager,BoardSyncManager,
   BoardPersistenceManager,SectorDownloadManager,ContentManager`, configurable in the `.cfg`) and
   dumps all of their fields - public, private, *and static* (many Unity singletons keep their real
   registry in a static field, which an instance-only dump misses), walking up the base-class chain -
   with each field's declaring type, field type, and value (or item count for collections) to
   `inspect-<TypeNames>_<timestamp>.txt` (`ReflectionDumper.cs`), all candidates in one file so trying
   several only costs one restart. This tells you a class's shape without opening a decompiler.

   Validated against `CreatureManager` first: it turned up `_creaturesData` (a `BList`, Bounce's
   custom collection type) with a count matching the live creature count exactly - confirming the
   tool works and that TaleSpire stores placed-object data in these manager-held collections rather
   than as one GameObject per instance (`MovableManager`, tried first, turned out to be an empty
   Photon singleton shell with no real data - the current defaults skip it in favor of the
   `Board*`/`ContentManager` cluster). That led to `BoardSessionManager._board : DataModel.Board` -
   a live, non-null plain object (not a Component), which is exactly the kind of root "board state"
   object we're after, but wasn't a `Component` so it only showed as a bare `DataModel.Board`
   ToString(). The dumper now follows plain-object (non-Unity, non-collection) field values one
   level in automatically (depth-limited, with a cycle guard), so re-running against
   `BoardSessionManager` should show `Board`'s own fields nested underneath `_board` - look there
   for a collection whose count matches your board's placed-object count.

   That surfaced `Board._zones : Zones` -> `Zones.List : BList<589 item(s)>` - independently
   corroborated by `BoardPresentation._presentations`/`_renderingZones` both also showing 589 -
   separate from the 47-creature count from `CreatureManager`. `Board._sectors` (14) matches
   `SectorDownloadManager._summaries` (14) too, confirming the sector/zone terminology is
   consistent across managers.

3. **Peek at individual collection elements instead of increasing the dump's blast radius.** Press
   the peek hotkey (default **Ctrl+Alt+P**) while a board is loaded. This navigates
   `PeekFieldPath` (dot-separated field names, with an optional `[N]` index on a segment to pick
   one element out of an intermediate collection - e.g. `List[0]`) starting from a live instance of
   `PeekRootTypeName` (defaults to `BoardSessionManager`), treats the field at the end as a
   collection, and dumps the fields of its first `PeekMaxElements` (default 3) items to
   `peek-<Root>-<Path>_<timestamp>.txt`. This is how to see what one element looks like without
   blindly raising the whole-object dump's depth limit and getting flooded with irrelevant
   shader/rendering fields.

   Peeking `_board._zones.List[0]` showed `Zone` is a *spatial* container, not a per-object one -
   589 is the count of populated 16-unit grid cells, not placed objects. But it led straight to the
   real target: `Zone.InactiveSet.Placeables : NativeGreedyList<DataModel.Placeable>` - matching
   `ContentManager._placeablesData`'s `PlaceableDataV0` catalog schema seen earlier, this is almost
   certainly the runtime instance list for tiles/walls/props, one list per zone. `NativeGreedyList`
   doesn't implement `IEnumerable` (like the other `Native*` containers throughout these dumps), so
   `PeekFieldPath` now supports indexer-based collections (`Count`/`Length` + an int indexer) as a
   fallback, and path segments can index into an intermediate collection (`List[0]`) to get from
   "all zones" to "the Placeables inside zone 0". Default is now
   `_board._zones.List[0].InactiveSet.Placeables` - if zone 0 (a board-edge cell) comes up empty,
   try a middle index (`List[290]` or so) instead.
4. Confirmed the exact element shape by decompiling the two now-known classes (`Placeable`,
   `NativeGreedyList<T>`) - a targeted lookup, not open-ended reverse engineering. That revealed the
   count property is `ActiveLength`, the parallel `Layouts` list carries the asset GUID, and rotation
   is a 15-deg Y step. `BoardExporter.GatherPlaceables` implements the read; `ReflectionDumper` now
   recognises `ActiveLength`/`FullLength` as count properties.

Remaining niceties (optional):

- Point `AssetIndexPath` (in the generated config) at one of TaleSpire's own asset databases -
  `Taleweaver/<packId>/index.json` in the game install - so exports resolve asset GUIDs to real
  names/categories instead of raw GUIDs. (The `Kind` from the data model already gives a coarse
  category - tile/prop/etc - even without this.)
- If you later want lights/atmosphere/GM data, the same diagnostic hotkeys + `ilspycmd` approach
  applies; the manager cluster under `SingletonHub` is the place to look.

Report back what you find (the scene-scan excerpt, class names, field names, sample logged values) so
the export/category logic and the viewer's coordinate-mapping assumptions can be corrected against
real data.
