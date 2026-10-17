# Export file format

The contract between the TaleSpire mod (`mod/`) and the viewer (`viewer/`), and the format anything
else (e.g. GridLinkOS) should import. `viewer/sample-export.json` is a small synthetic example in the
current format.

```jsonc
{
  "boardName": "Garment district",
  "boardId": "7006b5b9-…",            // TaleSpire board GUID (mod v0.2+), or null
  "exporterVersion": "0.3.0",          // mod version that wrote the file (v0.2+)
  "exportedAt": "2026-10-17T00:02:14Z",
  "selection": { "min": {…}, "max": {…} },   // only when just TaleSpire's selection was exported (v0.3+)
  "objects": [
    {
      "id": "string, unique within this file",
      "assetGuid": "TaleSpire asset GUID",
      "name": "resolved name, or the GUID",
      "category": "tile | prop | creature | unknown",
      "position": { "x": 0, "y": 0, "z": 0 },      // CENTER of the bounding box (v0.3+)
      "origin":   { "x": 0, "y": 0, "z": 0 },      // TaleSpire placement origin (tiles/props, v0.3+)
      "rotation": { "x": 0, "y": 0, "z": 0, "w": 1 },
      "size":     { "x": 1, "y": 1, "z": 1 }       // world-space bounding box size
    }
  ]
}
```

## Coordinates and boxes

- Units are TaleSpire world units. **1 unit = one grid square** (5 ft). The movement grid is
  aligned to whole numbers: tile origins are integers, or half-integers for half-size pieces.
- Unity coordinates: left-handed, Y up. The viewer converts to Three.js by negating `z`.
- `position` + `size` describe an **axis-aligned box that already includes the piece's rotation**.
  It comes from TaleSpire's own `Placeable.SelectionBounds`:
  - tiles: `[origin, origin + size]`, where TaleSpire swaps x/z for 90° and 270° rotations;
  - props: TaleSpire rotates the collider bounds around the origin (`AssetMath.RotatePropBounds`).

  So **don't apply `rotation` to the box again**. `rotation` is the piece's facing (24 steps of 15°
  about Y), kept for information.
- Creatures: `position` is the creature's transform position, and `size` is the transform scale.

### Older exports (mod v0.1 / v0.2)

These have no `origin` field. Their `position` is TaleSpire's placement origin, not the center. For
tiles that's the box's minimum corner, so the center is `position + size / 2`. For props it's only
approximately the footprint center. `viewer/js/data.js` handles both.

## Fields the viewer adds

The mod never writes these. The viewer adds them when saving:

- **Save map + notes**:
  - `locations`: `[{ id, x, y, z, top, title, description }]` in viewer (Three.js) coordinates.
  - `edits`: `{ removed: [objectKey…], clip: { xmin, xmax, ymin, ymax, zmin, zmax }, token, tokenTrail, unit }`.
  - `objectKey` is `assetGuid@x,y,z` (the Unity center, 2 decimals). That keeps it stable across
    re-exports, unlike `id`.
  - Loading a file that has `locations`/`edits` replaces the viewer's saved state for that board.
- **Export shaped map**: `objects` is filtered down to the kept pieces (not removed, center inside
  the cut box). `shapedFrom` records where it came from, and `locations` holds the notes inside the
  cut. It's otherwise a normal export, so it loads like any other.
