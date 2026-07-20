# Export JSON schema

This is the contract between the TaleSpire mod (`mod/`) and the web viewer (`viewer/`). Neither side
should assume anything beyond what's documented here.

```json
{
  "boardName": "string",
  "exportedAt": "ISO-8601 timestamp",
  "objects": [
    {
      "id": "string, unique per placed instance",
      "assetGuid": "string, TaleSpire asset NGUID",
      "name": "string, resolved from the asset index, or assetGuid if unresolved",
      "category": "floor | wall | prop | creature | unknown",
      "position": { "x": 0, "y": 0, "z": 0 },
      "rotation": { "x": 0, "y": 0, "z": 0, "w": 1 },
      "size": { "x": 1, "y": 1, "z": 1 }
    }
  ]
}
```

## Field notes

- `position` is treated by the viewer as the **center** of the placeholder box. If real exports turn
  out to anchor at a bounds corner instead (as TaleSpire's internal slab format suggests may be the
  case), adjust either the mod's export step or the viewer's box placement — not both — once real
  data is available.
- `rotation` is a unit quaternion. Unity is left-handed (Y-up); Three.js is right-handed (Y-up). The
  viewer negates `z` and `w` and negates position `z` to convert. Re-check this against a real export
  before trusting it visually.
- `category` drives placeholder color in the viewer. Unrecognized values fall back to `unknown`'s color.
- Coordinates and sizes are in TaleSpire world units (unconverted).

`sample-export.json` in this directory is a synthetic example (a small room with floor, walls, a
prop, and a creature) used to develop and test the viewer without needing TaleSpire running.
