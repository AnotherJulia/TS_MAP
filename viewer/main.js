import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { normalizeExport } from "./js/data.js";
import { buildWalkGrid, surfacesAt, findPath, step } from "./js/grid.js";
import { TaleSpireControls, isTyping } from "./js/controls.js";
import { createNetspaceMaterial } from "./js/netspace-material.js";
import { createCyberspace } from "./js/cyberspace.js";

// Present only inside the desktop app (tauri.conf.json: withGlobalTauri). The viewer
// still runs as a plain web page without it.
const tauri = window.__TAURI__ ?? null;

// =====================================================================================
// Look
// =====================================================================================

// "Map" style: cyberpunk duotone - a building-mass gradient (ground color at the low end
// of the height ramp, building color at the top) against a cyan infrastructure network
// (water + light strips). Colors and path settings are live-tweakable (Map style panel).
let groundColor = new THREE.Color().setHSL(0.012, 0.58, 0.2);
let buildingColor = new THREE.Color().setHSL(0.012, 0.8, 0.5);
const JITTER_AMOUNT = 0.035; // per-instance lightness jitter so flat areas don't read as one mass
const WATER = { h: 0.58, s: 0.55, l: 0.42 };
const GLOW = { h: 0.53, s: 0.9, l: 0.62 }; // standalone light fixtures
let pathColor = new THREE.Color(0x1c7f9c);
let pathWidth = 0.16;
let pathSensitivity = 0.9;
const MAP_SELECTED = new THREE.Color(0x00e6ff);
const MAP_BACKGROUND = new THREE.Color(0x14161a);

// Three drawing styles (style selector / G):
//   map   - the shaded rust/cyan city map above
//   wire  - clean glowing edges on near-black (js/netspace-material.js); instance color
//           tints fill and edges
//   cyber - Cyberpunk 2077 netspace: point clouds, data rain, bloom (js/cyberspace.js)
const STYLES = ["map", "wire", "cyber"];
const NET = {
  low: new THREE.Color(0x0b4f66),
  high: new THREE.Color(0x7ff3ff),
  wall: new THREE.Color(0x19d7ff),
  prop: new THREE.Color(0xff2e88),
  water: new THREE.Color(0x3a5cff),
  light: new THREE.Color(0xfcee0a),
  selected: new THREE.Color(0xffffff),
  background: new THREE.Color(0x02050a),
};
const CYBER = {
  surface: new THREE.Color(1, 1, 1),   // tints the speck shader
  water: new THREE.Color(0.55, 0.65, 1.4),
  selected: new THREE.Color(1.6, 0.45, 0.8), // magenta-hot, unmistakable against the blue
  background: new THREE.Color(0x000000),
};

let markerColor = 0xfcee0a;
const markerActiveColorFor = (hex) => new THREE.Color(hex).lerp(new THREE.Color(0xffffff), 0.45).getHex();
let markerActiveColor = markerActiveColorFor(markerColor);

// =====================================================================================
// Renderer, cameras, lights
// =====================================================================================

const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.localClippingEnabled = true; // the cut box

const scene = new THREE.Scene();
scene.background = MAP_BACKGROUND.clone();

// Perspective for exploring (TaleSpire-like); orthographic for the flat top-down map.
const perspCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 6000);
const orthoCamera = new THREE.OrthographicCamera(-10, 10, 10, -10, -3000, 6000);
let camera = perspCamera;

const controls = new TaleSpireControls(canvas);

// Neutral-white sky so the rust material's own saturation carries the color; cool cyan
// ground bounce keeps shadowed sides trending toward the network color.
scene.add(new THREE.HemisphereLight(0xf5f7fa, 0x0b2630, 0.7));
// Raking (low) sun so tall objects cast long shadows - how height reads from above.
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

// TaleSpire's 1-unit movement grid under the board (netspace style / token tool).
let floorGrid = null;

// LineMaterial widths depend on the viewport, so their resolution must track resizes.
const resizableLineMaterials = new Set();

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  perspCamera.aspect = w / h;
  perspCamera.updateProjectionMatrix();
  for (const m of resizableLineMaterials) m.resolution.set(w, h);
  cyber?.setSize(w, h);
}
window.addEventListener("resize", resize);
let cyber = null; // created once the clip planes exist (below)
resize();

// =====================================================================================
// State
// =====================================================================================

let board = null;        // { data, records, bounds: Box3 }
let mesh = null;         // one InstancedMesh for every rendered piece
let meshRecords = [];    // parallel to mesh instances
let pathNetwork = null;  // LineSegments2 for connected light strips (map style)
const removed = new Set();   // record keys removed by the GM
const selected = new Set();  // mesh instance indices
const undoStack = [];
let clip = null;             // { xmin, xmax, ymin, ymax, zmin, zmax } in scene units
let style = "map";
let topDown = false;
let firstPerson = false;
let lightFromBelow = true; // cyberspace: height gradient (toggle in the Tools panel / B)
let tool = "look";
let assetIndex = {};         // guidLower -> { n: name, w?: water, l?: light, p?: path light }
let lastExport = null;       // raw export (without our saved extras), for saving
let loadedExportName = null;

const assetFlag = (guid, flag) => assetIndex[String(guid).toLowerCase()]?.[flag] === 1;
const isWater = (guid) => assetFlag(guid, "w");
const isLight = (guid) => assetFlag(guid, "l");
const isPathLight = (guid) => assetFlag(guid, "p");
const assetName = (guid) => assetIndex[String(guid).toLowerCase()]?.n ?? null;

// =====================================================================================
// Cut box (clipping planes)
// =====================================================================================

// Fragments on the negative side of a plane are discarded, so each plane's normal
// points into the kept region.
const clipPlanes = [
  new THREE.Plane(new THREE.Vector3(1, 0, 0), 0),
  new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0),
  new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
  new THREE.Plane(new THREE.Vector3(0, -1, 0), 0),
  new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
  new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),
];
const clipBox = new THREE.Box3();
const clipHelper = new THREE.Box3Helper(clipBox, 0xffcf4a);
clipHelper.visible = false;
scene.add(clipHelper);

cyber = createCyberspace({ scene, renderer, clipPlanes });
resize();

function fullClip() {
  const b = board.bounds;
  return { xmin: b.min.x, xmax: b.max.x, ymin: b.min.y, ymax: b.max.y, zmin: b.min.z, zmax: b.max.z };
}

function isClipped() {
  if (!clip || !board) return false;
  const f = fullClip();
  return Object.keys(f).some((k) => Math.abs(f[k] - clip[k]) > 0.01);
}

function applyClip() {
  if (!clip) return;
  clipPlanes[0].constant = -clip.xmin;
  clipPlanes[1].constant = clip.xmax;
  clipPlanes[2].constant = -clip.ymin;
  clipPlanes[3].constant = clip.ymax;
  clipPlanes[4].constant = -clip.zmin;
  clipPlanes[5].constant = clip.zmax;
  clipBox.min.set(clip.xmin, clip.ymin, clip.zmin);
  clipBox.max.set(clip.xmax, clip.ymax, clip.zmax);
  clipHelper.visible = document.getElementById("cut-show").checked && isClipped();
  walkGridDirty = true;
  syncCutSliders();
  scheduleSave();
}

function insideClip(x, y, z, eps = 0.001) {
  if (!clip) return true;
  return x >= clip.xmin - eps && x <= clip.xmax + eps &&
         y >= clip.ymin - eps && y <= clip.ymax + eps &&
         z >= clip.zmin - eps && z <= clip.zmax + eps;
}

// A piece counts as "kept" (for walking and for the shaped export) when it hasn't been
// removed and its center is inside the cut box.
const isKept = (r) => !removed.has(r.key) && insideClip(r.x, r.y, r.z);

// =====================================================================================
// Materials and the instanced mesh
// =====================================================================================

// DoubleSide so a cut building shows its inner walls instead of vanishing.
const mapMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, clippingPlanes: clipPlanes });
const netMaterial = createNetspaceMaterial();
netMaterial.side = THREE.DoubleSide;
netMaterial.clippingPlanes = clipPlanes;

const hash01 = (i) => {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

function heightRange(records) {
  let min = Infinity;
  let max = -Infinity;
  for (const r of records) {
    if (r.max.y < min) min = r.max.y;
    if (r.max.y > max) max = r.max.y;
  }
  return { minTop: min, range: max - min };
}

const _hsl = { h: 0, s: 0, l: 0 };
function colorFor(r, i, hr, out) {
  const jitter = (hash01(i) - 0.5) * JITTER_AMOUNT;
  const t = hr.range > 1e-4 ? (r.max.y - hr.minTop) / hr.range : 0.5;
  if (style === "cyber") return out.copy(isWater(r.guid) ? CYBER.water : CYBER.surface);
  if (style === "wire") {
    if (isWater(r.guid)) return out.copy(NET.water);
    if (isLight(r.guid)) return out.copy(NET.light);
    if (r.category === "prop") return out.copy(NET.prop).multiplyScalar(0.8);
    out.lerpColors(NET.low, NET.high, t);
    if (r.sy > 1.2) out.lerp(NET.wall, 0.5); // walls / tall pieces glow a bit more
    return out;
  }
  if (isWater(r.guid)) return out.setHSL(WATER.h, WATER.s, THREE.MathUtils.clamp(WATER.l + jitter, 0, 1));
  if (isLight(r.guid)) return out.setHSL(GLOW.h, GLOW.s, THREE.MathUtils.clamp(GLOW.l + jitter, 0, 1));
  out.lerpColors(groundColor, buildingColor, t).getHSL(_hsl);
  return out.setHSL(_hsl.h, _hsl.s, THREE.MathUtils.clamp(_hsl.l + jitter, 0, 1));
}

function recolor() {
  if (!mesh) return;
  const hr = heightRange(meshRecords);
  const c = new THREE.Color();
  for (let i = 0; i < meshRecords.length; i++) {
    if (selected.has(i)) c.copy(style === "wire" ? NET.selected : style === "cyber" ? CYBER.selected : MAP_SELECTED);
    else colorFor(meshRecords[i], i, hr, c);
    mesh.setColorAt(i, c);
  }
  mesh.instanceColor.needsUpdate = true;
}

const _matrix = new THREE.Matrix4();
function writeMatrix(i) {
  const r = meshRecords[i];
  // Removed pieces collapse to (almost) nothing, so they neither draw nor get hit.
  const s = removed.has(r.key) ? 1e-6 : 1;
  _matrix.makeScale(Math.max(r.sx, 1e-3) * s, Math.max(r.sy, 1e-3) * s, Math.max(r.sz, 1e-3) * s);
  _matrix.setPosition(r.x, r.y, r.z);
  mesh.setMatrixAt(i, _matrix);
}

function disposeMesh() {
  if (mesh) {
    scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.dispose();
    mesh = null;
  }
  if (pathNetwork) {
    scene.remove(pathNetwork);
    pathNetwork.geometry.dispose();
    resizableLineMaterials.delete(pathNetwork.material);
    pathNetwork.material.dispose();
    pathNetwork = null;
  }
  meshRecords = [];
  selected.clear();
}

function buildMesh() {
  disposeMesh();
  const pieces = board.records.filter((r) => r.category !== "creature");

  // Floor/strip light tiles that connect up are drawn as glowing "subway" lines instead
  // of boxes (map style only - the other styles draw every piece their own way).
  let connected = new Set();
  if (style === "map") {
    const network = buildLightPathNetwork(pieces.filter((r) => isPathLight(r.guid) && !removed.has(r.key)));
    connected = network.connected;
    if (network.object3d) {
      pathNetwork = network.object3d;
      scene.add(pathNetwork);
    }
  }
  meshRecords = connected.size ? pieces.filter((r) => !connected.has(r)) : pieces;

  const material = style === "wire" ? netMaterial : style === "cyber" ? cyber.surfaceMaterial : mapMaterial;
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  meshFloorY = floorHeights(meshRecords);
  geometry.setAttribute("aFloorY", new THREE.InstancedBufferAttribute(meshFloorY, 1));
  mesh = new THREE.InstancedMesh(geometry, material, Math.max(meshRecords.length, 1));
  mesh.count = meshRecords.length;
  mesh.castShadow = style === "map";
  mesh.receiveShadow = style === "map";
  for (let i = 0; i < meshRecords.length; i++) writeMatrix(i);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.setColorAt(0, new THREE.Color()); // allocate instanceColor before recolor()
  recolor();
  scene.add(mesh);
  scheduleCyberRebuild();
}

// For each piece, the height of the floor it stands over: the highest floor-like top
// (thin tile) in its column at or below the piece's bottom. The cyberspace "light from
// below" gradient starts there, so every wall glows at its own foot and fades upward.
function floorHeights(records) {
  const floors = new Map();
  for (const r of board.records) {
    if (r.category === "creature" || r.sy > 0.6) continue;
    for (let cx = Math.floor(r.min.x + 0.01); cx < Math.ceil(r.max.x - 0.01); cx++) {
      for (let cz = Math.floor(r.min.z + 0.01); cz < Math.ceil(r.max.z - 0.01); cz++) {
        const k = `${cx},${cz}`;
        const list = floors.get(k);
        if (list) list.push(r.max.y);
        else floors.set(k, [r.max.y]);
      }
    }
  }
  const out = new Float32Array(Math.max(records.length, 1));
  records.forEach((r, i) => {
    let best = r.min.y;
    let found = false;
    for (const top of floors.get(`${Math.floor(r.x)},${Math.floor(r.z)}`) ?? []) {
      if (top <= r.min.y + 0.05 && (!found || top > best)) {
        best = top;
        found = true;
      }
    }
    out[i] = best;
  });
  return out;
}

// Cyberspace particles (stalks, wall fuzz, drips, dust) follow the kept pieces, so they're
// regenerated after removals (debounced; the surfaces themselves are a shader).
let meshFloorY = null;
let cyberTimer = null;
function scheduleCyberRebuild() {
  clearTimeout(cyberTimer);
  cyberTimer = setTimeout(() => {
    if (style !== "cyber" || !board) return;
    const keep = [];
    const keepFloor = [];
    meshRecords.forEach((r, i) => {
      if (removed.has(r.key)) return;
      keep.push(r);
      keepFloor.push(meshFloorY[i]);
    });
    cyber.build(keep, keepFloor);
  }, 80);
}

// Connects path-light tiles whose centers are within reach of each other (scaled by
// their footprints) with thick glowing segments. Isolated tiles stay boxes.
function buildLightPathNetwork(tiles) {
  const connected = new Set();
  if (tiles.length < 2) return { object3d: null, connected };
  const nodes = tiles.map((r) => ({
    pos: new THREE.Vector3(r.x, r.max.y + 0.03, r.z),
    footprint: Math.max(r.sx, r.sz),
    r,
  }));
  const positions = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (a.pos.distanceTo(b.pos) <= (a.footprint + b.footprint) * pathSensitivity) {
        positions.push(a.pos.x, a.pos.y, a.pos.z, b.pos.x, b.pos.y, b.pos.z);
        connected.add(a.r);
        connected.add(b.r);
      }
    }
  }
  if (!positions.length) return { object3d: null, connected };
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);
  const material = new LineMaterial({ color: pathColor.getHex(), linewidth: pathWidth, worldUnits: true });
  material.clippingPlanes = clipPlanes;
  material.resolution.set(window.innerWidth, window.innerHeight);
  resizableLineMaterials.add(material);
  const object3d = new LineSegments2(geometry, material);
  object3d.computeLineDistances();
  return { object3d, connected };
}

function positionSun() {
  const b = board.bounds;
  const center = b.getCenter(new THREE.Vector3());
  const size = b.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.z, 1);
  const height = Math.max(size.y, 1);
  const el = THREE.MathUtils.degToRad(35);
  const az = THREE.MathUtils.degToRad(-40);
  const dir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
  const distance = extent + height * 2;
  sun.position.copy(center).addScaledVector(dir, distance);
  sun.target.position.copy(center);
  sun.target.updateMatrixWorld();
  const half = extent * 1.3;
  Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 0.1, far: distance * 2 + height });
  sun.shadow.camera.updateProjectionMatrix();
}

function buildFloorGrid() {
  if (floorGrid) {
    scene.remove(floorGrid);
    floorGrid.geometry.dispose();
    floorGrid.material.dispose();
  }
  const b = board.bounds;
  const size = Math.ceil(Math.max(b.max.x - b.min.x, b.max.z - b.min.z)) + 8;
  floorGrid = new THREE.GridHelper(size, size, 0x0d3a48, 0x0a2630);
  // GridHelper is centered on its position: put lines on whole coordinates, like TaleSpire.
  const offset = size % 2 ? 0.5 : 0;
  floorGrid.position.set(Math.round((b.min.x + b.max.x) / 2) + offset, b.min.y - 0.02, Math.round((b.min.z + b.max.z) / 2) + offset);
  floorGrid.visible = style === "wire" || tool === "token";
  scene.add(floorGrid);
}

// =====================================================================================
// View toggles
// =====================================================================================

const styleSelect = document.getElementById("style-select");
const topDownToggle = document.getElementById("topdown-toggle");

function setStyle(name) {
  style = STYLES.includes(name) ? name : "map";
  styleSelect.value = style;
  scene.background = (style === "wire" ? NET.background : style === "cyber" ? CYBER.background : MAP_BACKGROUND).clone();
  document.body.classList.toggle("netspace", style !== "map");
  document.body.classList.toggle("cyber", style === "cyber");
  if (floorGrid) floorGrid.visible = style === "wire" || tool === "token";
  cyber.setVisible(style === "cyber");
  updateTokenLook();
  if (board) buildMesh(); // materials and the subway network differ per style
  savePrefs();
}

function setTopDown(on) {
  topDown = on;
  topDownToggle.checked = on;
  camera = on ? orthoCamera : perspCamera;
  controls.setTopDown(on);
  savePrefs();
}

styleSelect.addEventListener("change", () => setStyle(styleSelect.value));

// Detail slider: 0..1 maps to a speck grid of 0.06 (coarse) .. 0.012 (very fine) units.
const detailSlider = document.getElementById("detail-slider");
let detail = 0.54; // -> 0.025
const detailToCell = (t) => 0.06 * Math.pow(0.2, t);
function setDetail(t) {
  detail = t;
  detailSlider.value = String(t);
  cyber.setDetail(detailToCell(t));
  savePrefs();
}
detailSlider.addEventListener("input", () => setDetail(parseFloat(detailSlider.value)));

const lightToggle = document.getElementById("light-below-toggle");
function setLightFromBelow(on) {
  lightFromBelow = on;
  lightToggle.checked = on;
  savePrefs();
}
lightToggle.addEventListener("change", () => setLightFromBelow(lightToggle.checked));
topDownToggle.addEventListener("change", () => setTopDown(topDownToggle.checked));

function resetView() {
  if (!board) return;
  controls.fit(board.bounds, { topDown });
  controls.target.y = board.groundY; // focus (and the cyberspace light) at street level
}

// The most common floor height - street level on a city board, which can sit well above
// the board's lowest point when there are basements or sewers.
function commonFloorHeight(records, fallback) {
  const counts = new Map();
  for (const r of records) {
    if (r.category === "creature" || r.sy > 0.6) continue;
    const k = Math.round(r.max.y * 4) / 4;
    counts.set(k, (counts.get(k) ?? 0) + r.sx * r.sz);
  }
  let best = fallback;
  let bestCount = 0;
  for (const [k, c] of counts) if (c > bestCount) { best = k; bestCount = c; }
  return best;
}
document.getElementById("reset-view").addEventListener("click", resetView);

function savePrefs() {
  try {
    localStorage.setItem("tsmap-prefs", JSON.stringify({ style, topDown, lightFromBelow, detail }));
  } catch {}
}
function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem("tsmap-prefs") ?? "{}");
  } catch {
    return {};
  }
}

// =====================================================================================
// Tools
// =====================================================================================

const TOOL_HELP = {
  look: "Left-drag rotates, Shift-drag pans. Hover a marker to read its note.",
  select: "Click a piece to select it, drag a box to select many (Shift adds). Delete removes.",
  token: "Click a floor to place or walk the token. Arrow keys step, PgUp/PgDn change floor. Shift-click places without walking. V: first person.",
  notes: "Click a building to add a location note. Click a marker to edit it.",
};

function setTool(name) {
  tool = name;
  controls.leftDrag = name === "look" ? "rotate" : null;
  for (const b of document.querySelectorAll("#tool-buttons button")) b.classList.toggle("active", b.dataset.tool === name);
  for (const p of document.querySelectorAll(".tool-panel")) p.classList.toggle("visible", p.dataset.for === name);
  document.getElementById("tool-help").textContent = TOOL_HELP[name];
  canvas.dataset.tool = name;
  if (name !== "notes") selectedLocationId = null;
  if (floorGrid) floorGrid.visible = style === "wire" || name === "token";
  rebuildMarkers();
}
for (const b of document.querySelectorAll("#tool-buttons button")) b.addEventListener("click", () => setTool(b.dataset.tool));

// =====================================================================================
// Picking
// =====================================================================================

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function setPointer(event) {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
}

// First hit on a visible part of a piece: skips removed pieces and hits on geometry the
// cut box hides.
function pickPiece() {
  if (!mesh) return null;
  raycaster.setFromCamera(pointer, camera);
  for (const hit of raycaster.intersectObject(mesh, false)) {
    if (hit.instanceId == null || removed.has(meshRecords[hit.instanceId].key)) continue;
    if (!insideClip(hit.point.x, hit.point.y, hit.point.z, 0.01)) continue;
    return { index: hit.instanceId, record: meshRecords[hit.instanceId], point: hit.point };
  }
  return null;
}

// =====================================================================================
// Selection, removal, undo
// =====================================================================================

const selectStatusEl = document.getElementById("select-status");

function selectionChanged() {
  recolor();
  const n = selected.size;
  let text = n === 0 ? "Nothing selected" : `${n} piece${n === 1 ? "" : "s"} selected`;
  if (n === 1) {
    const r = meshRecords[[...selected][0]];
    text += ` · ${assetName(r.guid) ?? r.src.name ?? r.guid}`;
  }
  if (removed.size) text += ` · ${removed.size} removed`;
  selectStatusEl.textContent = text;
}

function clearSelection() {
  if (!selected.size) return;
  selected.clear();
  selectionChanged();
}

function setRemoved(keys, isRemoved) {
  for (const k of keys) {
    if (isRemoved) removed.add(k);
    else removed.delete(k);
  }
  for (let i = 0; i < meshRecords.length; i++) if (keys.has(meshRecords[i].key)) writeMatrix(i);
  mesh.instanceMatrix.needsUpdate = true;
  walkGridDirty = true;
  scheduleCyberRebuild();
  scheduleSave();
  updatePanel();
}

function removeKeys(keys, label) {
  const fresh = new Set([...keys].filter((k) => !removed.has(k)));
  if (!fresh.size) return;
  undoStack.push({ keys: fresh, removed: true, label });
  selected.clear();
  setRemoved(fresh, true);
  selectionChanged();
}

function removeSelection() {
  if (!selected.size) return;
  const n = selected.size;
  removeKeys(new Set([...selected].map((i) => meshRecords[i].key)), "remove");
  showToast(`Removed ${n} piece${n === 1 ? "" : "s"}. Ctrl/Cmd+Z to undo.`);
}

function keepOnlySelection() {
  if (!selected.size) return;
  const keep = new Set([...selected].map((i) => meshRecords[i].key));
  removeKeys(new Set(board.records.filter((r) => r.category !== "creature" && !keep.has(r.key)).map((r) => r.key)), "keep only");
  showToast("Kept only the selection. Ctrl/Cmd+Z to undo.");
}

function selectSameType() {
  const guids = new Set([...selected].map((i) => meshRecords[i].guid));
  meshRecords.forEach((r, i) => {
    if (guids.has(r.guid) && !removed.has(r.key) && insideClip(r.x, r.y, r.z)) selected.add(i);
  });
  selectionChanged();
}

function cutToSelection() {
  if (!selected.size) return;
  const box = new THREE.Box3();
  for (const i of selected) {
    const r = meshRecords[i];
    box.expandByPoint(new THREE.Vector3(r.min.x, r.min.y, r.min.z));
    box.expandByPoint(new THREE.Vector3(r.max.x, r.max.y, r.max.z));
  }
  clip = { xmin: box.min.x - 0.01, xmax: box.max.x + 0.01, ymin: box.min.y - 0.01, ymax: box.max.y + 0.01, zmin: box.min.z - 0.01, zmax: box.max.z + 0.01 };
  applyClip();
}

function undo() {
  const entry = undoStack.pop();
  if (!entry) return showToast("Nothing to undo.");
  setRemoved(entry.keys, !entry.removed);
  selectionChanged();
  showToast(`Undid ${entry.label}.`);
}

function restoreAll() {
  if (!removed.size) return;
  undoStack.push({ keys: new Set(removed), removed: false, label: "restore all" });
  setRemoved(new Set(removed), false);
  selectionChanged();
}

document.getElementById("sel-remove").addEventListener("click", removeSelection);
document.getElementById("sel-keep").addEventListener("click", keepOnlySelection);
document.getElementById("sel-same").addEventListener("click", selectSameType);
document.getElementById("sel-crop").addEventListener("click", cutToSelection);
document.getElementById("sel-undo").addEventListener("click", undo);
document.getElementById("sel-restore").addEventListener("click", restoreAll);

// Marquee (box) selection: every kept piece whose center projects inside the rectangle.
const marqueeEl = document.getElementById("marquee");
let marquee = null;

function drawMarquee(x, y) {
  marquee.x1 = x;
  marquee.y1 = y;
  Object.assign(marqueeEl.style, {
    display: "block",
    left: `${Math.min(marquee.x0, x)}px`,
    top: `${Math.min(marquee.y0, y)}px`,
    width: `${Math.abs(x - marquee.x0)}px`,
    height: `${Math.abs(y - marquee.y0)}px`,
  });
}

function finishMarquee(additive) {
  marqueeEl.style.display = "none";
  const x0 = Math.min(marquee.x0, marquee.x1), x1 = Math.max(marquee.x0, marquee.x1);
  const y0 = Math.min(marquee.y0, marquee.y1), y1 = Math.max(marquee.y0, marquee.y1);
  marquee = null;
  if (!additive) selected.clear();
  const v = new THREE.Vector3();
  const w = window.innerWidth, h = window.innerHeight;
  meshRecords.forEach((r, i) => {
    if (!isKept(r)) return;
    v.set(r.x, r.y, r.z).project(camera);
    if (v.z < -1 || v.z > 1) return;
    const sx = (v.x * 0.5 + 0.5) * w;
    const sy = (-v.y * 0.5 + 0.5) * h;
    if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) selected.add(i);
  });
  selectionChanged();
}

// =====================================================================================
// Cut panel
// =====================================================================================

const cutInputs = {
  ymax: document.getElementById("cut-ymax"),
  ymin: document.getElementById("cut-ymin"),
  xmin: document.getElementById("cut-xmin"),
  xmax: document.getElementById("cut-xmax"),
  zmin: document.getElementById("cut-zmin"),
  zmax: document.getElementById("cut-zmax"),
};
const CUT_PAIRS = { xmin: "xmax", xmax: "xmin", ymin: "ymax", ymax: "ymin", zmin: "zmax", zmax: "zmin" };

function setupCutSliders() {
  const f = fullClip();
  for (const [k, el] of Object.entries(cutInputs)) {
    const axis = k[0];
    el.min = String(Math.floor(f[`${axis}min`]));
    el.max = String(Math.ceil(f[`${axis}max`]));
  }
  syncCutSliders();
}

function syncCutSliders() {
  if (!clip) return;
  for (const [k, el] of Object.entries(cutInputs)) el.value = String(clip[k]);
}

for (const [k, el] of Object.entries(cutInputs)) {
  el.addEventListener("input", () => {
    if (!clip) return;
    clip[k] = parseFloat(el.value);
    const other = CUT_PAIRS[k];
    if (k.endsWith("min") && clip[k] > clip[other]) clip[other] = clip[k];
    if (k.endsWith("max") && clip[k] < clip[other]) clip[other] = clip[k];
    applyClip();
  });
}

function nudgeCutHeight(which, delta) {
  if (!clip) return;
  const f = fullClip();
  clip[which] = THREE.MathUtils.clamp(clip[which] + delta, f.ymin, f.ymax);
  if (clip.ymin > clip.ymax) clip[CUT_PAIRS[which]] = clip[which];
  applyClip();
  showToast(`Cut ${which === "ymax" ? "top" : "bottom"} at height ${clip[which].toFixed(2)}`, { duration: 1200 });
}

document.getElementById("cut-reset").addEventListener("click", () => {
  if (!board) return;
  clip = fullClip();
  applyClip();
});
document.getElementById("cut-show").addEventListener("change", applyClip);

// =====================================================================================
// Token on TaleSpire's grid
// =====================================================================================

const BLOCKING = new Set(["tile", "floor", "wall", "unknown"]); // props don't block movement
let walkGrid = null;
let walkGridDirty = true;
let token = null; // { cx, cz, y, moved }
let tokenTrail = []; // scene positions since the last reset
let tokenQueue = []; // pending steps to animate
let followTarget = null;
const tokenUnitEl = document.getElementById("token-unit");
const tokenStatusEl = document.getElementById("token-status");

function getWalkGrid() {
  if (walkGridDirty || !walkGrid) {
    walkGrid = buildWalkGrid(board.records.filter((r) => BLOCKING.has(r.category) && isKept(r)));
    walkGridDirty = false;
  }
  return walkGrid;
}

const tokenGroup = new THREE.Group();
{
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.3, 32, 16), new THREE.MeshBasicMaterial({ color: 0xfcee0a }));
  ball.position.y = 0.32;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.36, 0.46, 40),
    new THREE.MeshBasicMaterial({ color: 0xfcee0a, side: THREE.DoubleSide, transparent: true, opacity: 0.6 })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  ball.userData.look = "marker";
  ring.userData.look = "marker";
  // Cyberspace style: a glowing red figure, like the avatars in Cyberpunk's netspace.
  const red = new THREE.MeshBasicMaterial({ color: 0xff1f3d });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.62, 6, 16), red);
  body.position.y = 0.47;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 12), red);
  head.position.y = 1.05;
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.42, 40),
    new THREE.MeshBasicMaterial({ color: 0xff1f3d, side: THREE.DoubleSide, transparent: true, opacity: 0.35 })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.02;
  for (const m of [body, head, halo]) m.userData.look = "figure";
  tokenGroup.add(ball, ring, body, head, halo);
  tokenGroup.visible = false;
  scene.add(tokenGroup);
}

function updateTokenLook() {
  for (const child of tokenGroup.children) {
    child.visible = child.userData.look === (style === "cyber" ? "figure" : "marker");
  }
  trailLine.material.color.set(style === "cyber" ? 0xff1f3d : 0xfcee0a);
}
const trailLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xfcee0a, transparent: true, opacity: 0.75 }));
trailLine.frustumCulled = false;
scene.add(trailLine);

const cellCenter = (n) => new THREE.Vector3(n.cx + 0.5, n.y, n.cz + 0.5);

function updateTrail() {
  trailLine.geometry.dispose();
  trailLine.geometry = new THREE.BufferGeometry().setFromPoints(tokenTrail.map((p) => p.clone().setY(p.y + 0.05)));
}

function formatDistance(squares) {
  switch (tokenUnitEl.value) {
    case "2m": return `${squares * 2} m`;
    case "1sq": return `${squares} sq`;
    default: return `${squares * 5} ft`;
  }
}

function updateTokenStatus() {
  if (!token) {
    tokenStatusEl.textContent = "Click a floor to place the token.";
    return;
  }
  tokenStatusEl.textContent =
    `Moved ${token.moved} square${token.moved === 1 ? "" : "s"} (${formatDistance(token.moved)}) · height ${token.y.toFixed(2)}`;
}
tokenUnitEl.addEventListener("change", () => {
  updateTokenStatus();
  scheduleSave();
});

function placeToken(node) {
  token = { cx: node.cx, cz: node.cz, y: node.y, moved: 0 };
  tokenQueue = [];
  tokenGroup.position.copy(cellCenter(node));
  tokenGroup.visible = true;
  tokenTrail = [cellCenter(node)];
  updateTrail();
  followTarget = cellCenter(node);
  updateTokenStatus();
  scheduleSave();
}

function walkToken(path) {
  for (const n of path.slice(1)) {
    tokenQueue.push(n);
    tokenTrail.push(cellCenter(n));
  }
  const last = path[path.length - 1];
  token = { ...token, cx: last.cx, cz: last.cz, y: last.y, moved: token.moved + path.length - 1 };
  updateTrail();
  followTarget = cellCenter(last);
  updateTokenStatus();
  scheduleSave();
}

// The surface in the clicked cell closest to where the click landed.
function nodeFromHit(point) {
  const cx = Math.floor(point.x);
  const cz = Math.floor(point.z);
  const tops = surfacesAt(getWalkGrid(), cx, cz);
  if (!tops.length) return null;
  const y = tops.reduce((a, b) => (Math.abs(b - point.y) < Math.abs(a - point.y) ? b : a));
  return { cx, cz, y };
}

function tokenClick(event) {
  const hit = pickPiece();
  if (!hit) return;
  const node = nodeFromHit(hit.point);
  if (!node) return showToast("No floor to stand on there.", { error: true });
  if (!token || event.shiftKey) return placeToken(node);
  const path = findPath(getWalkGrid(), token, node);
  if (!path) return showToast("Can't reach that square from here. Shift-click to place the token there anyway.", { error: true });
  if (path.length > 1) walkToken(path);
}

// Arrow keys step on the grid relative to where the camera faces (snapped to an axis).
function tokenArrow(code) {
  if (!token) return showToast("Place the token first (Token tool, click a floor).");
  const f = controls.forward();
  const fwd = Math.abs(f.x) > Math.abs(f.z) ? [Math.sign(f.x), 0] : [0, Math.sign(f.z)];
  const right = [-fwd[1], fwd[0]];
  const dir = { ArrowUp: fwd, ArrowDown: [-fwd[0], -fwd[1]], ArrowRight: right, ArrowLeft: [-right[0], -right[1]] }[code];
  const next = step(getWalkGrid(), token, dir[0], dir[1]);
  if (!next) return showToast("Blocked.", { duration: 900 });
  walkToken([token, next]);
}

// PageUp/PageDown: hop to the next standable surface above/below in the same cell
// (stairs, ladders and lifts aren't modelled; this stands in for them).
function tokenLevel(up) {
  if (!token) return;
  const tops = surfacesAt(getWalkGrid(), token.cx, token.cz);
  const next = up ? tops.find((t) => t > token.y + 0.01) : [...tops].reverse().find((t) => t < token.y - 0.01);
  if (next === undefined) return showToast(`No floor ${up ? "above" : "below"} here.`, { duration: 1200 });
  token.y = next;
  tokenQueue.push({ ...token });
  tokenTrail.push(cellCenter(token));
  updateTrail();
  followTarget = cellCenter(token);
  updateTokenStatus();
  scheduleSave();
}

function removeToken() {
  if (firstPerson) exitFirstPerson();
  token = null;
  tokenQueue = [];
  tokenTrail = [];
  tokenGroup.visible = false;
  updateTrail();
  updateTokenStatus();
  scheduleSave();
}

document.getElementById("token-reset").addEventListener("click", () => {
  if (!token) return;
  token.moved = 0;
  tokenTrail = [cellCenter(token)];
  updateTrail();
  updateTokenStatus();
  scheduleSave();
});
document.getElementById("token-remove").addEventListener("click", removeToken);

// =====================================================================================
// Location notes
// =====================================================================================

const pinGroup = new THREE.Group();
const leaderGroup = new THREE.Group();
scene.add(pinGroup, leaderGroup);
let markerLift = 4;
let pinSize = 1.2;
let locations = []; // { id, x, y, z, top, title, description } in scene units
let hoveredLocationId = null;
let selectedLocationId = null;

const locationAnchor = (loc) => new THREE.Vector3(loc.x, loc.top + markerLift, loc.z);

const ringGeometry = new THREE.RingGeometry(0.34, 0.44, 32);
const glowRingGeometry = new THREE.RingGeometry(0.48, 0.66, 32);
const beaconGeometry = new THREE.OctahedronGeometry(0.22, 0);

// Unlit, so markers stay vivid even in a building's shadow.
function markerMaterials(color) {
  return {
    ring: new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
    glow: new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.3, depthWrite: false }),
    beacon: new THREE.MeshBasicMaterial({ color }),
  };
}
const markerPalette = { base: markerMaterials(markerColor), active: markerMaterials(markerActiveColor) };

function setMarkerColor(hex) {
  markerColor = hex;
  markerActiveColor = markerActiveColorFor(hex);
  for (const m of Object.values(markerPalette.base)) m.color.set(markerColor);
  for (const m of Object.values(markerPalette.active)) m.color.set(markerActiveColor);
  rebuildMarkers();
}

function buildMarkerVisual(materials) {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(ringGeometry, materials.ring);
  ring.rotation.x = -Math.PI / 2;
  const glow = new THREE.Mesh(glowRingGeometry, materials.glow);
  glow.rotation.x = -Math.PI / 2;
  const beacon = new THREE.Mesh(beaconGeometry, materials.beacon);
  beacon.position.y = 0.5;
  beacon.userData.isBeacon = true;
  group.add(ring, glow, beacon);
  return group;
}

function rebuildMarkers() {
  pinGroup.clear(); // geometries/materials are shared constants - nothing to dispose
  for (const c of [...leaderGroup.children]) {
    leaderGroup.remove(c);
    c.geometry.dispose();
    c.material.dispose();
  }
  for (const loc of locations) {
    const active = loc.id === selectedLocationId || loc.id === hoveredLocationId;
    const marker = buildMarkerVisual(active ? markerPalette.active : markerPalette.base);
    marker.scale.setScalar(pinSize);
    marker.position.set(loc.x, loc.top + 0.03, loc.z);
    marker.traverse((child) => { child.userData.locationId = loc.id; });
    pinGroup.add(marker);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(loc.x, loc.top, loc.z), locationAnchor(loc)]),
      new THREE.LineBasicMaterial({ color: active ? markerActiveColor : markerColor })
    );
    leaderGroup.add(line);
  }
}

function pickPin() {
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(pinGroup.children, true)[0];
  return hit ? hit.object.userData.locationId : null;
}

const cardEl = document.getElementById("location-card");
const viewEl = document.getElementById("loc-view");
const editEl = document.getElementById("loc-edit");
const viewTitleEl = document.getElementById("loc-view-title");
const viewDescEl = document.getElementById("loc-view-desc");
const editTitleEl = document.getElementById("loc-edit-title");
const editDescEl = document.getElementById("loc-edit-desc");

function activeLocation() {
  const id = selectedLocationId ?? hoveredLocationId;
  return id == null ? null : locations.find((l) => l.id === id) ?? null;
}

function updateCard() {
  const loc = activeLocation();
  if (!loc) return cardEl.classList.add("hidden");
  const ndc = locationAnchor(loc).project(camera);
  if (ndc.z > 1 || ndc.z < -1) return cardEl.classList.add("hidden");
  cardEl.classList.remove("hidden");
  cardEl.style.left = `${(ndc.x * 0.5 + 0.5) * window.innerWidth + 8}px`;
  cardEl.style.top = `${(-ndc.y * 0.5 + 0.5) * window.innerHeight}px`;
  const editing = tool === "notes" && loc.id === selectedLocationId;
  editEl.classList.toggle("hidden", !editing);
  viewEl.classList.toggle("hidden", editing);
  if (!editing) {
    viewTitleEl.textContent = loc.title ?? "";
    viewDescEl.textContent = loc.description ?? "";
  }
}

// Two-step delete (first click arms it) instead of confirm(), which the desktop app's
// webview doesn't reliably show.
const deleteBtn = document.getElementById("loc-delete");
function disarmDelete() {
  deleteBtn.dataset.armed = "";
  deleteBtn.textContent = "Delete";
}

function openEditor(loc) {
  disarmDelete();
  editTitleEl.value = loc.title ?? "";
  editDescEl.value = loc.description ?? "";
  if (!loc.title) setTimeout(() => editTitleEl.focus(), 0);
}

function saveEditor() {
  const loc = locations.find((l) => l.id === selectedLocationId);
  if (!loc) return;
  loc.title = editTitleEl.value.trim();
  loc.description = editDescEl.value.trim();
  selectedLocationId = null;
  scheduleSave();
  rebuildMarkers();
}
document.getElementById("loc-save").addEventListener("click", saveEditor);
editTitleEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    saveEditor();
  }
});

deleteBtn.addEventListener("click", () => {
  if (!locations.some((l) => l.id === selectedLocationId)) return;
  if (!deleteBtn.dataset.armed) {
    deleteBtn.dataset.armed = "1";
    deleteBtn.textContent = "Really delete?";
    return;
  }
  disarmDelete();
  locations = locations.filter((l) => l.id !== selectedLocationId);
  selectedLocationId = null;
  hoveredLocationId = null;
  scheduleSave();
  rebuildMarkers();
});

function notesClick() {
  const pinId = pickPin();
  if (pinId != null) {
    selectedLocationId = pinId;
    openEditor(locations.find((l) => l.id === pinId));
    return rebuildMarkers();
  }
  const hit = pickPiece();
  if (!hit) {
    selectedLocationId = null;
    return rebuildMarkers();
  }
  const r = hit.record;
  const existing = locations.find((l) => Math.hypot(l.x - r.x, l.z - r.z) < 0.6 && Math.abs(l.top - r.max.y) < 0.6);
  if (existing) {
    selectedLocationId = existing.id;
    openEditor(existing);
    return rebuildMarkers();
  }
  const loc = {
    id: `loc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    x: r.x, y: r.y, z: r.z, top: r.max.y,
    title: assetName(r.guid) ?? "",
    description: "",
  };
  locations.push(loc);
  selectedLocationId = loc.id;
  scheduleSave();
  openEditor(loc);
  rebuildMarkers();
}

// =====================================================================================
// Pointer + keyboard
// =====================================================================================

let downPos = null;

canvas.addEventListener("pointerdown", (event) => {
  if (firstPerson || event.button !== 0 || event.ctrlKey || event.altKey) return;
  downPos = { x: event.clientX, y: event.clientY };
  if (tool === "select" && board) marquee = { x0: event.clientX, y0: event.clientY, x1: event.clientX, y1: event.clientY };
});

canvas.addEventListener("pointermove", (event) => {
  setPointer(event);
  if (marquee && downPos && Math.hypot(event.clientX - downPos.x, event.clientY - downPos.y) > 5) {
    drawMarquee(event.clientX, event.clientY);
  }
  if (controls.dragging) return;
  const id = pickPin();
  if (id !== hoveredLocationId) {
    hoveredLocationId = id;
    rebuildMarkers();
  }
});

canvas.addEventListener("pointerup", (event) => {
  if (firstPerson) return;
  if (event.button !== 0 || !downPos) return;
  const moved = Math.hypot(event.clientX - downPos.x, event.clientY - downPos.y);
  downPos = null;
  if (marquee) {
    if (moved > 5) return finishMarquee(event.shiftKey);
    marquee = null;
    marqueeEl.style.display = "none";
  }
  if (moved > 5 || !board) return;
  setPointer(event);

  if (tool === "select") {
    const hit = pickPiece();
    if (!hit) {
      if (!event.shiftKey) clearSelection();
      return;
    }
    if (event.shiftKey) {
      if (selected.has(hit.index)) selected.delete(hit.index);
      else selected.add(hit.index);
    } else {
      selected.clear();
      selected.add(hit.index);
    }
    selectionChanged();
  } else if (tool === "token") {
    tokenClick(event);
  } else if (tool === "notes") {
    notesClick();
  }
});

window.addEventListener("keydown", (event) => {
  if (firstPerson && !isTyping(event) && firstPersonKey(event)) return;
  if (isTyping(event)) {
    if (event.key === "Escape" && selectedLocationId != null) {
      selectedLocationId = null;
      event.target.blur();
      rebuildMarkers();
    }
    return;
  }
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === "z") {
    event.preventDefault();
    return undo();
  }
  if (mod) return;

  switch (event.code) {
    case "Digit1": return setTool("look");
    case "Digit2": return setTool("select");
    case "Digit3": return setTool("token");
    case "Digit4": return setTool("notes");
    case "KeyG": return setStyle(STYLES[(STYLES.indexOf(style) + 1) % STYLES.length]);
    case "KeyV": return toggleFirstPerson();
    case "KeyB": return setLightFromBelow(!lightFromBelow);
    case "KeyM": return setTopDown(!topDown);
    case "Home": return resetView();
    case "BracketLeft": return nudgeCutHeight(event.shiftKey ? "ymin" : "ymax", -0.5);
    case "BracketRight": return nudgeCutHeight(event.shiftKey ? "ymin" : "ymax", 0.5);
    case "Delete":
    case "Backspace":
      event.preventDefault();
      return removeSelection();
    case "Escape":
      if (selectedLocationId != null) {
        selectedLocationId = null;
        return rebuildMarkers();
      }
      return clearSelection();
    case "ArrowUp":
    case "ArrowDown":
    case "ArrowLeft":
    case "ArrowRight":
      if (!board) return;
      event.preventDefault();
      return tokenArrow(event.code);
    case "PageUp":
    case "PageDown":
      if (!board) return;
      event.preventDefault();
      return tokenLevel(event.code === "PageUp");
  }
});

// =====================================================================================
// First-person ("jack in") view: the camera sits in the token's eyes. Movement still
// happens square by square on the grid, so it's counted like any other move.
// =====================================================================================

const EYE_HEIGHT = 1.15; // TaleSpire units (1 unit = one 5 ft square)
let fpYaw = 0;
let fpPitch = 0;
let fpDrag = null;

function toggleFirstPerson() {
  if (firstPerson) return exitFirstPerson();
  if (!token) {
    // No token yet: drop it on the floor in the middle of the view.
    pointer.set(0, 0);
    const hit = pickPiece();
    const node = hit && nodeFromHit(hit.point);
    if (!node) return showToast("Point the camera at a floor (or place the token with the Token tool) first.");
    placeToken(node);
    tokenQueue = [];
  }
  firstPerson = true;
  fpYaw = controls.yaw;
  fpPitch = -0.05;
  controls.enabled = false;
  camera = perspCamera;
  perspCamera.fov = 70;
  perspCamera.updateProjectionMatrix();
  tokenGroup.visible = false;
  document.body.classList.add("first-person");
  showToast("First person: click a floor to walk there, drag to look, WASD steps, Q/E turn. V or Esc to leave.", { duration: 5000 });
}

function exitFirstPerson() {
  firstPerson = false;
  controls.enabled = true;
  controls.yaw = fpYaw;
  perspCamera.fov = 45;
  perspCamera.updateProjectionMatrix();
  camera = topDown ? orthoCamera : perspCamera;
  tokenGroup.visible = !!token;
  document.body.classList.remove("first-person");
  if (token) followTarget = cellCenter(token);
}

// Grid direction closest to a heading (8-way).
function headingToGridDir(yaw) {
  const a = Math.round(Math.atan2(-Math.sin(yaw), -Math.cos(yaw)) / (Math.PI / 4)) * (Math.PI / 4);
  return [Math.round(Math.sin(a)), Math.round(Math.cos(a))];
}

function firstPersonKey(event) {
  const turn = { KeyQ: Math.PI / 8, KeyE: -Math.PI / 8 }[event.code];
  if (turn) {
    fpYaw += turn;
    return true;
  }
  const offset = { KeyW: 0, ArrowUp: 0, KeyS: Math.PI, ArrowDown: Math.PI, KeyA: Math.PI / 2, ArrowLeft: Math.PI / 2, KeyD: -Math.PI / 2, ArrowRight: -Math.PI / 2 }[event.code];
  if (offset !== undefined) {
    event.preventDefault();
    if (tokenQueue.length > 1) return true; // don't let key repeat outrun the walk
    const [dx, dz] = headingToGridDir(fpYaw + offset);
    const next = step(getWalkGrid(), token, dx, dz);
    if (next) walkToken([token, next]);
    return true;
  }
  if (event.code === "Escape") {
    exitFirstPerson();
    return true;
  }
  return false;
}

canvas.addEventListener("pointerdown", (event) => {
  if (!firstPerson) return;
  fpDrag = { x: event.clientX, y: event.clientY, x0: event.clientX, y0: event.clientY, id: event.pointerId };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (!firstPerson || !fpDrag) return;
  fpYaw -= (event.clientX - fpDrag.x) * 0.004;
  fpPitch = THREE.MathUtils.clamp(fpPitch - (event.clientY - fpDrag.y) * 0.004, -1.2, 1.2);
  fpDrag.x = event.clientX;
  fpDrag.y = event.clientY;
});
canvas.addEventListener("pointerup", (event) => {
  if (!fpDrag || event.pointerId !== fpDrag.id) return;
  canvas.releasePointerCapture(event.pointerId);
  const moved = Math.hypot(event.clientX - fpDrag.x0, event.clientY - fpDrag.y0);
  fpDrag = null;
  // A click (not a look-drag) walks to the clicked square, like the Token tool.
  if (moved < 5 && event.button === 0) {
    setPointer(event);
    tokenClick(event);
  }
});

const _eye = new THREE.Vector3();
const _look = new THREE.Vector3();
function updateFirstPersonCamera() {
  // A gentle idle sway, plus a small bob while walking, so the view is never dead still.
  const t = clock.elapsedTime;
  const walking = tokenQueue.length > 0 ? 1 : 0;
  _eye.copy(tokenGroup.position).y += EYE_HEIGHT + Math.sin(t * 1.3) * 0.012 + walking * Math.abs(Math.sin(t * 9)) * 0.035;
  camera.position.copy(_eye);
  const yaw = fpYaw + Math.sin(t * 0.5) * 0.006;
  const pitch = fpPitch + Math.sin(t * 0.8 + 1.0) * 0.004;
  const c = Math.cos(pitch);
  _look.set(-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c).add(_eye);
  camera.up.set(0, 1, 0);
  camera.lookAt(_look);
}

document.getElementById("token-fp").addEventListener("click", toggleFirstPerson);

// =====================================================================================
// Persistence (per board, in this browser / app) and files
// =====================================================================================

let boardKey = null;
let saveTimer = null;

function boardState() {
  return {
    locations,
    removed: [...removed],
    clip,
    token,
    tokenTrail: tokenTrail.map((p) => [p.x, p.y, p.z]),
    unit: tokenUnitEl.value,
  };
}

function scheduleSave() {
  updateNotesStatus();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!boardKey) return;
    try {
      localStorage.setItem(boardKey, JSON.stringify(boardState()));
    } catch (err) {
      console.warn("Couldn't save board state:", err);
    }
  }, 300);
}

function readStoredState(data) {
  try {
    const raw = localStorage.getItem(boardKey);
    if (raw) return JSON.parse(raw);
    // Notes saved by v0.2 of the viewer (before removals/cuts existed).
    const legacyKey = data.boardId
      ? `tsmap-locations:id:${data.boardId}`
      : `tsmap-locations:${data.boardName ?? "board"}:${data.objects.length}`;
    const legacy = localStorage.getItem(legacyKey);
    return legacy ? { locations: JSON.parse(legacy) } : null;
  } catch {
    return null;
  }
}

function applyState(state) {
  locations = Array.isArray(state?.locations) ? state.locations : [];
  removed.clear();
  for (const k of state?.removed ?? []) removed.add(k);
  undoStack.length = 0;
  clip = state?.clip ?? fullClip();
  tokenUnitEl.value = state?.unit ?? tokenUnitEl.value;
  token = state?.token ?? null;
  tokenQueue = [];
  tokenTrail = (state?.tokenTrail ?? []).map(([x, y, z]) => new THREE.Vector3(x, y, z));
  tokenGroup.visible = !!token;
  if (token) tokenGroup.position.copy(cellCenter(token));
  updateTrail();
  updateTokenStatus();
}

const safeName = (s) => String(s ?? "board").replace(/[\\/:*?"<>|]/g, "_");

function saveFile(fileName, obj) {
  const text = JSON.stringify(obj);
  if (tauri) {
    return tauri.core
      .invoke("save_map_file", { name: fileName, contents: text })
      .then((path) => showToast(`Saved ${path}`))
      .catch((err) => showToast("Couldn't save: " + err, { error: true }));
  }
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Everything, so loading the file anywhere restores notes, removals, cuts and the token.
document.getElementById("save-notes").addEventListener("click", () => {
  if (!lastExport) return;
  const { locations: locs, ...edits } = boardState();
  saveFile(`${safeName(lastExport.boardName)} - map with notes.json`, { ...lastExport, locations: locs, edits });
});

// Just the shaped part: a normal export containing only kept pieces (and creatures inside
// the cut), so it loads here - or anywhere else that reads exports - as its own map.
document.getElementById("export-shaped").addEventListener("click", () => {
  if (!lastExport) return;
  const objects = board.records.filter((r) => isKept(r)).map((r) => r.src);
  const shaped = {
    ...lastExport,
    objects,
    shapedFrom: { boardName: lastExport.boardName, exportedAt: lastExport.exportedAt, removed: removed.size, clip },
    locations: locations.filter((l) => insideClip(l.x, l.top, l.z, 0.5)),
  };
  saveFile(`${safeName(lastExport.boardName)} - shaped.json`, shaped);
});

// =====================================================================================
// Loading
// =====================================================================================

function updatePanel() {
  const info = document.getElementById("board-info");
  if (!board) return (info.innerHTML = "");
  const d = board.data;
  const pieces = board.records.filter((r) => r.category !== "creature").length;
  const creatures = board.records.length - pieces;
  info.innerHTML = `
    <div><strong>${escapeHtml(d.boardName ?? "Untitled board")}</strong></div>
    <div>${pieces} pieces${removed.size ? ` · ${removed.size} removed` : ""}${creatures ? ` · ${creatures} creatures (hidden)` : ""}</div>
    ${d.selection ? "<div>Exported from a TaleSpire selection</div>" : ""}
    ${d.shapedFrom ? "<div>Shaped map</div>" : ""}
    <div>${d.exportedAt ? new Date(d.exportedAt).toLocaleString() : ""}</div>
  `;
}

function updateNotesStatus() {
  const el = document.getElementById("notes-status");
  el.textContent = board
    ? `${locations.length} note${locations.length === 1 ? "" : "s"} · edits saved ${tauri ? "in the app" : "in this browser"}`
    : "";
}

const escapeHtml = (str) =>
  String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function loadExport(data) {
  if (firstPerson) exitFirstPerson();
  if (!Array.isArray(data.objects)) {
    showToast("This file doesn't look like a TaleSpire map export (missing an \"objects\" array).", { error: true });
    return;
  }
  const { records } = normalizeExport(data);
  const bounds = new THREE.Box3();
  for (const r of records) {
    if (r.category === "creature") continue;
    bounds.expandByPoint(new THREE.Vector3(r.min.x, r.min.y, r.min.z));
    bounds.expandByPoint(new THREE.Vector3(r.max.x, r.max.y, r.max.z));
  }
  if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 1, 5));

  const { locations: fileLocations, edits: fileEdits, ...exportOnly } = data;
  lastExport = exportOnly;
  board = { data, records, bounds, groundY: commonFloorHeight(records, bounds.min.y) };

  // Per-board key; v0.2+ exports carry TaleSpire's board id, which survives board edits.
  // Selection/shaped exports get their own key so their edits don't mix with the full board's.
  const variant = data.shapedFrom ? ":shaped" : data.selection ? ":selection" : "";
  boardKey = data.boardId
    ? `tsmap-board:id:${data.boardId}${variant}`
    : `tsmap-board:${data.boardName ?? "board"}:${data.objects.length}`;

  // A file saved with "Save map + notes" carries its own state; loading it means "use it".
  const fromFile = Array.isArray(fileLocations) || fileEdits ? { locations: fileLocations, ...(fileEdits ?? {}) } : null;
  applyState(fromFile ?? readStoredState(data));

  selectedLocationId = null;
  hoveredLocationId = null;
  walkGridDirty = true;
  buildMesh();
  buildFloorGrid();
  setupCutSliders();
  applyClip();
  positionSun();
  const extent = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z, 1);
  markerLift = THREE.MathUtils.clamp((bounds.max.y - bounds.min.y) * 0.4, 3, 14);
  pinSize = THREE.MathUtils.clamp(extent * 0.012, 0.8, 2.5);
  resetView();
  rebuildMarkers();
  selectionChanged();
  updatePanel();
  updateNotesStatus();
  document.getElementById("welcome").classList.add("hidden");
  if (fromFile) scheduleSave();
}

// Asset index: names + water/light flags. Optional - without it nothing is tinted.
const assetIndexReady = fetch("./asset-index.json")
  .then((res) => (res.ok ? res.json() : Promise.reject()))
  .then((data) => { assetIndex = data.assets ?? {}; })
  .catch(() => console.warn("asset-index.json not found; water tint + names disabled."));

function loadText(text, name) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return showToast(`Couldn't read ${name ?? "that file"} as JSON: ${err.message}`, { error: true });
  }
  assetIndexReady.then(() => loadExport(data));
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => loadText(reader.result, file.name);
  reader.readAsText(file);
}

document.getElementById("file-input").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) loadFile(file);
  event.target.value = "";
});

const dropOverlay = document.getElementById("drop-overlay");
for (const name of ["dragenter", "dragover"]) {
  window.addEventListener(name, (event) => {
    event.preventDefault();
    dropOverlay.classList.add("active");
  });
}
for (const name of ["dragleave", "drop"]) {
  window.addEventListener(name, (event) => {
    event.preventDefault();
    if (name === "drop") {
      const file = event.dataTransfer?.files?.[0];
      if (file) loadFile(file);
    }
    dropOverlay.classList.remove("active");
  });
}

document.getElementById("load-sample").addEventListener("click", () => {
  fetch("./sample-export.json")
    .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((text) => loadText(text, "the sample map"))
    .catch((err) => showToast("Couldn't load the sample map: " + err.message, { error: true }));
});

// =====================================================================================
// Toast (replaces alert(), which the app's webview doesn't reliably show)
// =====================================================================================

const toastEl = document.getElementById("toast");
let toastTimer = null;
function showToast(message, { error = false, onClick = null, duration = 5000 } = {}) {
  toastEl.textContent = message;
  toastEl.classList.toggle("error", error);
  toastEl.classList.toggle("clickable", !!onClick);
  toastEl.classList.add("visible");
  toastEl.onclick = () => {
    toastEl.classList.remove("visible");
    onClick?.();
  };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("visible"), duration);
}

// =====================================================================================
// Map style tweaks
// =====================================================================================

const tweak = (id) => document.getElementById(id);
tweak("tweak-ground").value = "#" + groundColor.getHexString();
tweak("tweak-building").value = "#" + buildingColor.getHexString();
tweak("tweak-subway").value = "#" + pathColor.getHexString();
tweak("tweak-subway-width").value = String(pathWidth);
tweak("tweak-subway-sensitivity").value = String(pathSensitivity);
tweak("tweak-marker").value = "#" + markerColor.toString(16).padStart(6, "0");

tweak("tweak-ground").addEventListener("input", (e) => { groundColor.set(e.target.value); recolor(); });
tweak("tweak-building").addEventListener("input", (e) => { buildingColor.set(e.target.value); recolor(); });
tweak("tweak-subway").addEventListener("input", (e) => {
  pathColor.set(e.target.value);
  pathNetwork?.material.color.set(pathColor);
});
tweak("tweak-subway-width").addEventListener("input", (e) => {
  pathWidth = parseFloat(e.target.value);
  if (pathNetwork) pathNetwork.material.linewidth = pathWidth;
});
tweak("tweak-marker").addEventListener("input", (e) => setMarkerColor(parseInt(e.target.value.slice(1), 16)));
let sensitivityTimer = null;
tweak("tweak-subway-sensitivity").addEventListener("input", (e) => {
  pathSensitivity = parseFloat(e.target.value);
  clearTimeout(sensitivityTimer);
  sensitivityTimer = setTimeout(() => board && buildMesh(), 120); // changes topology: rebuild
});

// =====================================================================================
// Desktop app: read exports straight from the mod's export folder (app/src-tauri/src/lib.rs)
// =====================================================================================

const recentEl = document.getElementById("recent-exports");
let newestSeen = null;

function openExport(name) {
  tauri.core
    .invoke("read_export", { name })
    .then((text) => {
      loadedExportName = name;
      recentEl.value = name;
      loadText(text, name);
    })
    .catch((err) => showToast(String(err), { error: true }));
}

function openLatestExport() {
  tauri.core.invoke("list_exports").then((exports) => {
    if (!exports.length) return showToast("No exports yet. In TaleSpire, open a board and press Ctrl+Shift+E.", { error: true });
    openExport(exports[0].name);
  });
}

// Refreshes the recent list and offers to open a new export as soon as the mod writes one.
function refreshExports({ announce }) {
  return tauri.core.invoke("list_exports").then((exports) => {
    const current = recentEl.value;
    recentEl.innerHTML = "";
    recentEl.add(new Option(exports.length ? "Recent exports…" : "No exports yet", ""));
    for (const e of exports) {
      recentEl.add(new Option(`${e.name.replace(/\.json$/i, "")} — ${new Date(e.modified_ms).toLocaleString()}`, e.name));
    }
    recentEl.value = exports.some((e) => e.name === current) ? current : "";
    const newest = exports[0]?.name ?? null;
    if (announce && newest && newest !== newestSeen && newest !== loadedExportName) {
      showToast(`New export from TaleSpire: ${newest} — click to open`, { onClick: () => openExport(newest), duration: 15000 });
    }
    newestSeen = newest;
  });
}

if (tauri) {
  document.body.classList.add("in-app");
  document.getElementById("open-latest").addEventListener("click", openLatestExport);
  document.getElementById("welcome-open-latest").addEventListener("click", openLatestExport);
  document.getElementById("open-folder").addEventListener("click", () => {
    tauri.core.invoke("open_exports_folder").catch((err) => showToast(String(err), { error: true }));
  });
  recentEl.addEventListener("change", () => recentEl.value && openExport(recentEl.value));
  refreshExports({ announce: false });
  setInterval(() => refreshExports({ announce: true }), 3000);
}

// =====================================================================================
// Frame loop
// =====================================================================================

const clock = new THREE.Clock();
const _pawnLight = new THREE.Vector3();

// Scan pulses from the pawn, deliberately irregular: random gaps (sometimes a quick
// double ping), speed, strength and ring sharpness. Each ring keeps expanding from where
// the pawn was when it fired.
let pulses = [];
let nextPulseAt = 1.5;
function updatePulses(t) {
  if (t >= nextPulseAt) {
    pulses.unshift({
      start: t,
      speed: 4 + Math.random() * 7,
      strength: 0.2 + Math.random() * 0.4,
      sharpness: 0.6 + Math.random() * 1.4,
      origin: tokenGroup.position.clone().setY(tokenGroup.position.y + 0.8),
    });
    pulses = pulses.slice(0, 2);
    nextPulseAt = t + (Math.random() < 0.2 ? 0.5 + Math.random() * 0.6 : 3 + Math.random() * 7);
  }
  return pulses;
}
const _tokenStepTarget = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);

  // Camera follows the token while it moves, until the GM moves the camera themselves.
  if (["KeyW", "KeyA", "KeyS", "KeyD"].some((k) => controls.keys.has(k)) || controls.dragging) followTarget = null;
  if (followTarget) {
    controls.target.lerp(followTarget, 1 - Math.exp(-dt * 5));
    if (controls.target.distanceTo(followTarget) < 0.01) followTarget = null;
  }
  if (!firstPerson) controls.update(dt, camera);

  // Token walks its queued path one square at a time.
  if (tokenQueue.length) {
    _tokenStepTarget.copy(cellCenter(tokenQueue[0]));
    tokenGroup.position.lerp(_tokenStepTarget, 1 - Math.exp(-dt * 22));
    if (tokenGroup.position.distanceTo(_tokenStepTarget) < 0.03) {
      tokenGroup.position.copy(_tokenStepTarget);
      tokenQueue.shift();
    }
  }

  if (firstPerson) updateFirstPersonCamera();

  updateCard();
  pinGroup.traverse((child) => {
    if (child.userData.isBeacon) child.rotation.y += 0.02;
  });
  if (style === "cyber") {
    // The scan light travels with the viewer: your eyes in first person, the camera's focus
    // point otherwise (wider and with more ambient, so the overview stays readable).
    // The pawn carries the light: a pool around it, the rest dim until you get close.
    // Without a token, the camera's focus point carries a wider light instead.
    const d = controls.distance;
    const pawnLight = token ? _pawnLight.copy(tokenGroup.position).setY(tokenGroup.position.y + 0.8) : null;
    cyber.update(clock.elapsedTime, camera, {
      light: pawnLight ?? (firstPerson ? camera.position : controls.target),
      lightRadius: pawnLight ? 7 : Math.max(8, d * 0.45),
      ambient: pawnLight ? 0.16 : 0.22,
      fogNear: firstPerson ? 6 : d * 1.1,
      fogFar: firstPerson ? 30 : d * 3,
      fadeHeight: 4,
      heightFade: lightFromBelow,
      pulses: token ? updatePulses(clock.elapsedTime) : null,
    });
    cyber.render(camera);
  } else {
    renderer.render(scene, camera);
  }
}

// =====================================================================================
// Start
// =====================================================================================

const prefs = loadPrefs();
setStyle(prefs.style ?? (prefs.netspace ? "wire" : "map"));
setLightFromBelow(prefs.lightFromBelow ?? true);
setDetail(prefs.detail ?? 0.54);
setTopDown(!!prefs.topDown);
setTool("look");
requestAnimationFrame(animate);
