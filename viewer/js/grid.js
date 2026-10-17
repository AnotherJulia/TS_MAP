// TaleSpire's movement grid: 1x1 unit cells aligned to whole world coordinates (tiles
// are placed on integer origins). Pure logic, no Three.js, so it can be unit-tested.
//
// A cell holds the vertical intervals [bottom, top] of every movement-blocking box that
// overlaps it. A "surface" is the top of an interval with enough free headroom above it
// to stand on. A token stands on one surface of one cell, and can step to a neighbouring
// cell's surface if that is within STEP_UP above or DROP below its current height.

export const GRID_DEFAULTS = {
  stepUp: 1.01,   // stairs / raised floors up to one unit
  drop: 2.51,     // short drops; further falls need "free move"
  headroom: 1.4,  // free height a creature needs above a surface
  eps: 0.02,
};

export const cellKey = (cx, cz) => `${cx},${cz}`;
export const cellOf = (x, z) => ({ cx: Math.floor(x), cz: Math.floor(z) });

// boxes: [{ min: {x,y,z}, max: {x,y,z} }] in the same space the grid is used in.
export function buildWalkGrid(boxes, opts = {}) {
  const o = { ...GRID_DEFAULTS, ...opts };
  const intervals = new Map();
  for (const b of boxes) {
    const x0 = Math.floor(b.min.x + o.eps), x1 = Math.ceil(b.max.x - o.eps) - 1;
    const z0 = Math.floor(b.min.z + o.eps), z1 = Math.ceil(b.max.z - o.eps) - 1;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = cellKey(cx, cz);
        let list = intervals.get(k);
        if (!list) intervals.set(k, (list = []));
        list.push([b.min.y, b.max.y]);
      }
    }
  }

  const surfaces = new Map();
  for (const [k, list] of intervals) {
    const tops = [];
    for (const [, top] of list) {
      const blocked = list.some(([lo, hi]) => lo < top + o.headroom && hi > top + o.eps);
      if (!blocked && !tops.some((t) => Math.abs(t - top) < 0.01)) tops.push(top);
    }
    tops.sort((a, b) => a - b);
    if (tops.length) surfaces.set(k, tops);
  }
  return { surfaces, opts: o };
}

export function surfacesAt(grid, cx, cz) {
  return grid.surfaces.get(cellKey(cx, cz)) ?? [];
}

// The surface in (cx, cz) a token at height y would step onto, or null.
export function surfaceNear(grid, cx, cz, y) {
  let best = null;
  for (const t of surfacesAt(grid, cx, cz)) {
    if (t > y + grid.opts.stepUp || t < y - grid.opts.drop) continue;
    if (best === null || Math.abs(t - y) < Math.abs(best - y)) best = t;
  }
  return best;
}

export const DIRECTIONS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

// One step from `from` ({cx, cz, y}); diagonals may not cut wall corners.
export function step(grid, from, dx, dz) {
  const y = surfaceNear(grid, from.cx + dx, from.cz + dz, from.y);
  if (y === null) return null;
  if (dx !== 0 && dz !== 0) {
    if (surfaceNear(grid, from.cx + dx, from.cz, from.y) === null) return null;
    if (surfaceNear(grid, from.cx, from.cz + dz, from.y) === null) return null;
  }
  return { cx: from.cx + dx, cz: from.cz + dz, y };
}

const nodeKey = (n) => `${n.cx},${n.cz},${n.y.toFixed(2)}`;

// Breadth-first search (every step, diagonal or not, costs one square - the common
// tabletop rule). goal: { cx, cz, y? }; with y, the goal surface nearest to it is meant.
// Returns the list of nodes from start to goal, or null.
export function findPath(grid, start, goal, maxNodes = 40000) {
  const goalY = goal.y ?? null;
  const goalSurfaces = surfacesAt(grid, goal.cx, goal.cz);
  if (!goalSurfaces.length) return null;
  const target = goalY === null
    ? null
    : goalSurfaces.reduce((a, b) => (Math.abs(b - goalY) < Math.abs(a - goalY) ? b : a));
  const isGoal = (n) => n.cx === goal.cx && n.cz === goal.cz && (target === null || Math.abs(n.y - target) < 0.01);

  const prev = new Map([[nodeKey(start), null]]);
  const queue = [start];
  for (let head = 0; head < queue.length && prev.size < maxNodes; head++) {
    const n = queue[head];
    if (isGoal(n)) {
      const path = [];
      for (let cur = n; cur; cur = prev.get(nodeKey(cur))) path.push(cur);
      return path.reverse();
    }
    for (const [dx, dz] of DIRECTIONS) {
      const next = step(grid, n, dx, dz);
      if (!next) continue;
      const k = nodeKey(next);
      if (prev.has(k)) continue;
      prev.set(k, n);
      queue.push(next);
    }
  }
  return null;
}
