// Turns an export file into render-ready records in Three.js space.
//
// Coordinates: TaleSpire/Unity is left-handed Y-up, Three.js right-handed Y-up, so
// z is negated and nothing else changes. Every object becomes an axis-aligned box:
// TaleSpire's own SelectionBounds is already a world-space AABB with rotation baked in
// (see mod/TaleSpireMapExporter/BoardExporter.cs), so boxes are never rotated again.

// Mod v0.3+ exports the AABB center as `position` and tags placeables with `origin`.
// Older exports (v0.1/0.2) put TaleSpire's placement origin in `position`: for tiles that
// is the AABB's min corner, for props it's only roughly the footprint center.
function centerOf(o, modern) {
  const p = o.position ?? { x: 0, y: 0, z: 0 };
  const s = o.size ?? { x: 1, y: 1, z: 1 };
  if (modern) return { x: p.x, y: p.y, z: p.z };
  if (o.category === "creature") return { x: p.x, y: p.y + s.y / 2, z: p.z };
  if (o.category === "tile") return { x: p.x + s.x / 2, y: p.y + s.y / 2, z: p.z + s.z / 2 };
  return { x: p.x, y: p.y + s.y / 2, z: p.z };
}

// Stable identity for an object across re-exports of the same board (mod ids include
// zone/list indices, which shift whenever the board is edited).
export function objectKey(guid, c) {
  return `${guid}@${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)}`;
}

export function normalizeExport(data) {
  const modern = data.objects.some((o) => o.origin);
  const records = [];
  for (const o of data.objects) {
    const c = centerOf(o, modern);
    const s = o.size ?? { x: 1, y: 1, z: 1 };
    const sx = Math.abs(s.x), sy = Math.abs(s.y), sz = Math.abs(s.z);
    const x = c.x, y = c.y, z = -c.z;
    records.push({
      src: o,
      key: objectKey(o.assetGuid ?? "?", c),
      guid: o.assetGuid,
      category: o.category ?? "unknown",
      x, y, z, sx, sy, sz,
      min: { x: x - sx / 2, y: y - sy / 2, z: z - sz / 2 },
      max: { x: x + sx / 2, y: y + sy / 2, z: z + sz / 2 },
    });
  }
  return { records, modern };
}
