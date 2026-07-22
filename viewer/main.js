import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

// Cyberpunk duotone: a building-mass gradient (ground color at the low end
// of the height ramp, building color at the top) against a cyan
// infrastructure network (water + light strips), matching the HUD panel's
// neon-on-dark theme. All of groundColor/buildingColor/pathColor/pathWidth/
// pathSensitivity/markerColor are live-tweakable from the panel — see the
// "tweak panel" wiring near the bottom of this file — so they're `let`, not
// `const`, and seeded here with the defaults that produced the original look.
let groundColor = new THREE.Color().setHSL(0.012, 0.58, 0.2);
let buildingColor = new THREE.Color().setHSL(0.012, 0.8, 0.5);
const JITTER_AMOUNT = 0.035; // per-instance lightness jitter so flat same-height areas don't read as one dead-flat mass
const WATER_HUE = 0.58;
const WATER_SAT = 0.55;
const WATER_LIGHT = 0.42;
// Neon cyan for standalone light fixtures (lamps, torches, wall lights) that
// don't chain into the connected path network below. Not currently exposed
// as a tweak (only water/light *classification* was requested, not its color).
const GLOW_HUE = 0.53;
const GLOW_SAT = 0.9;
const GLOW_LIGHT = 0.62;
// The connected light-path network (floor/strip lights that form subway-like
// lines), rendered as thick glowing lines instead of per-tile boxes — see
// buildLightPathNetwork(). pathSensitivity scales how far apart two path
// tiles can be and still count as "connected" (higher = more connections).
let pathColor = new THREE.Color(0x1c7f9c); // darker muted teal-blue, not neon
let pathWidth = 0.16; // world units
let pathSensitivity = 0.9;

let markerColor = 0xfcee0a; // Cyberpunk 2077-style yellow
function markerActiveColorFor(hex) {
  return new THREE.Color(hex).lerp(new THREE.Color(0xffffff), 0.45).getHex();
}
let markerActiveColor = markerActiveColorFor(markerColor);

const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);

// Orthographic (not perspective) so the default view reads as a flat map,
// not a scene in perspective. Frustum bounds are recomputed per-load in
// fitTopDown() and per-resize in updateFrustum().
const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 5000);
let viewSize = 20; // world-unit height of the visible frustum; width follows aspect

// OrbitControls.update() re-derives the camera's orientation via its own
// internal lookAt(target) call every single frame, based on the camera's
// spherical offset from the target — so the camera can never actually rest
// exactly at the pole (offset perfectly parallel to its up vector): that's
// Three.js's degenerate case for lookAt, and it silently falls back to an
// arbitrary perturbed orientation (a visibly skewed, non-top-down view) any
// time update() runs at that exact position, no matter what the camera was
// set to beforehand. A couple of degrees off the pole is indistinguishable
// from true top-down and stays clear of that threshold.
const TOP_DOWN_TILT = 0.035; // radians, ~2 degrees off vertical

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
// Keep the camera from dropping below the board (there's nothing to see from
// underneath), and don't let the user orbit back to the exact pole either.
controls.minPolarAngle = TOP_DOWN_TILT;
controls.maxPolarAngle = Math.PI / 2 - 0.02;

// Neutral-white sky (not warm-tinted): a warm light multiplied onto an
// already-warm rust material washed it out toward sepia/beige instead of
// reading as vivid rust — the material's own saturation should carry the
// color. Ground bounce stays cool cyan so shadowed undersides still trend
// toward the cyan network's color, reinforcing the duotone without
// desaturating the lit tops.
scene.add(new THREE.HemisphereLight(0xf5f7fa, 0x0b2630, 0.7));

// Deliberately raking (low elevation), not steep — from near-overhead, a
// steep light hits every rooftop at nearly the same angle regardless of
// height, which is the flat-shading problem this whole change is fixing.
// A shallow light angle makes tall objects cast long, visible shadows across
// their shorter neighbors, the classic way height reads in a top-down/map
// view. Position and shadow-camera frustum are set per-load in positionSun().
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.normalBias = 0.02; // avoids shadow acne between coplanar, edge-to-edge tiles
scene.add(sun);
scene.add(sun.target);

let placedMesh = null;
let placedObjects = []; // parallel to placedMesh instances, for click -> asset lookup
let pathNetwork = null; // LineSegments2 for the connected light-path network
let lastPlaced = []; // full non-creature object list from the last load, kept so tweaks
                      // that change topology (e.g. path sensitivity) can rebuild without
                      // needing the file re-dropped

// LineMaterial (used by the path network) renders at a fixed pixel/world
// width that depends on viewport size — its `resolution` uniform has to be
// kept in sync on resize or the line width drifts.
const resizableLineMaterials = [];

// --- location markers ---------------------------------------------------------
// Pins point down AT their building; leader lines rise from the building top to
// an anchor point where the HTML info card is drawn.
const pinGroup = new THREE.Group(); // raycast targets for hover/select
const leaderGroup = new THREE.Group(); // visual lines only, not raycast
scene.add(pinGroup, leaderGroup);
let markerLift = 4; // world-unit height of the leader line above the building
let pinSize = 1.2;

// --- asset index (names + water flag) -----------------------------------------
let assetIndex = {}; // guidLower -> { n: name, w?: 1 }
function isWater(guid) {
  return assetIndex[String(guid).toLowerCase()]?.w === 1;
}
function isLight(guid) {
  return assetIndex[String(guid).toLowerCase()]?.l === 1;
}
// Subset of isLight() assets that are floor/strip pieces meant to chain into
// a continuous path (as opposed to standalone fixtures like lamps or wall
// lights) — see asset-index.json's "p" flag.
function isPathLight(guid) {
  return assetIndex[String(guid).toLowerCase()]?.p === 1;
}
function assetName(guid) {
  return assetIndex[String(guid).toLowerCase()]?.n ?? null;
}

// --- GM / location state ------------------------------------------------------
let gmMode = false;
let locations = []; // { id, x, y, z, top, title, description }
let boardKey = null; // localStorage key for the current board
let hoveredLocationId = null;
let selectedLocationId = null; // GM-selected (persistent, editable)

function updateFrustum() {
  const aspect = window.innerWidth / window.innerHeight;
  const halfHeight = viewSize / 2;
  const halfWidth = halfHeight * aspect;
  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.updateProjectionMatrix();
}

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateFrustum();
  for (const m of resizableLineMaterials) m.resolution.set(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", resize);
resize();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  updateCard();
  // Slow beacon spin — a small bit of life in the HUD marker, cheap since
  // there are only ever a handful of locations.
  pinGroup.traverse((child) => {
    if (child.userData.isBeacon) child.rotation.y += 0.02;
  });
  renderer.render(scene, camera);
}
// Defer the first frame to a rAF callback (not a direct call) so it runs after
// this module finishes evaluating — updateCard() references DOM consts declared
// further down, which would be in the temporal dead zone during a synchronous
// first frame.
requestAnimationFrame(animate);

// TaleSpire (Unity) is left-handed Y-up; Three.js is right-handed Y-up.
// Negating Z on both position and quaternion is the standard conversion for
// this axis pair.
function unityPositionToThree(p) {
  return new THREE.Vector3(p.x, p.y, -p.z);
}
function unityQuaternionToThree(q) {
  return new THREE.Quaternion(q.x, q.y, -q.z, -q.w);
}

function clearPlaced() {
  if (placedMesh) {
    scene.remove(placedMesh);
    placedMesh.geometry.dispose();
    placedMesh.material.dispose();
    placedMesh = null;
  }
  placedObjects = [];
  clearPathNetwork();
}

function clearPathNetwork() {
  if (!pathNetwork) return;
  scene.remove(pathNetwork);
  pathNetwork.geometry.dispose();
  const idx = resizableLineMaterials.indexOf(pathNetwork.material);
  if (idx !== -1) resizableLineMaterials.splice(idx, 1);
  pathNetwork.material.dispose();
  pathNetwork = null;
}

// Cheap deterministic 0..1 pseudo-random value per instance index, used only
// for the brightness jitter — doesn't need to be a good RNG, just stable
// across reloads and uncorrelated-looking between neighboring indices.
function hash01(i) {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// Shared by buildPlacedMesh (initial build) and recolorPlacedMesh (live tweak
// re-coloring) so the two can never drift apart. minTop/heightRange come from
// a pre-scan over the whole object list (see callers).
const _lerpColor = new THREE.Color();
const _hsl = { h: 0, s: 0, l: 0 };
function instanceColorFor(entry, i, minTop, heightRange, out) {
  if (isWater(entry.assetGuid)) {
    const jitter = (hash01(i) - 0.5) * JITTER_AMOUNT;
    out.setHSL(WATER_HUE, WATER_SAT, THREE.MathUtils.clamp(WATER_LIGHT + jitter, 0, 1));
    return out;
  }
  if (isLight(entry.assetGuid)) {
    const jitter = (hash01(i) - 0.5) * JITTER_AMOUNT;
    out.setHSL(GLOW_HUE, GLOW_SAT, THREE.MathUtils.clamp(GLOW_LIGHT + jitter, 0, 1));
    return out;
  }
  const size = entry.size ?? { x: 1, y: 1, z: 1 };
  const top = (entry.position?.y ?? 0) + size.y / 2;
  const t = heightRange > 1e-4 ? (top - minTop) / heightRange : 0.5;
  const jitter = (hash01(i) - 0.5) * JITTER_AMOUNT;
  _lerpColor.lerpColors(groundColor, buildingColor, t);
  _lerpColor.getHSL(_hsl);
  out.setHSL(_hsl.h, _hsl.s, THREE.MathUtils.clamp(_hsl.l + jitter, 0, 1));
  return out;
}

function scanHeightRange(objects) {
  let minTop = Infinity;
  let maxTop = -Infinity;
  for (const entry of objects) {
    const size = entry.size ?? { x: 1, y: 1, z: 1 };
    const top = (entry.position?.y ?? 0) + size.y / 2;
    if (top < minTop) minTop = top;
    if (top > maxTop) maxTop = top;
  }
  return { minTop, heightRange: maxTop - minTop };
}

// Renders every non-creature object as one shared unit-box geometry via
// InstancedMesh, scaled/positioned/rotated per instance. With 15k+ tiles and
// props on a real board, one draw call is what keeps this smooth — a Mesh
// per object (the old approach) does not scale to that count.
function buildPlacedMesh(objects) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  // Base color must be white: instance colors (set below) multiply against
  // it, so anything other than white would just darken every instance by a
  // flat amount on top of the height tint.
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const mesh = new THREE.InstancedMesh(geometry, material, objects.length);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const { minTop, heightRange } = scanHeightRange(objects);

  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

  objects.forEach((entry, i) => {
    const pos = unityPositionToThree(entry.position ?? { x: 0, y: 0, z: 0 });
    const rot = unityQuaternionToThree(entry.rotation ?? { x: 0, y: 0, z: 0, w: 1 });
    const size = entry.size ?? { x: 1, y: 1, z: 1 };

    matrix.compose(pos, rot, new THREE.Vector3(size.x, size.y, size.z));
    mesh.setMatrixAt(i, matrix);
    mesh.setColorAt(i, instanceColorFor(entry, i, minTop, heightRange, color));

    const half = Math.max(size.x, size.y, size.z) / 2;
    min.min(new THREE.Vector3(pos.x - half, pos.y - half, pos.z - half));
    max.max(new THREE.Vector3(pos.x + half, pos.y + half, pos.z + half));
  });

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  placedObjects = objects;
  return { mesh, bounds: new THREE.Box3(min, max) };
}

// Re-colors the existing InstancedMesh in place (no geometry/matrix rebuild)
// — used when a ground/building color tweak changes. Cheap: O(n) color math
// over placedObjects, no new GPU buffers.
function recolorPlacedMesh() {
  if (!placedMesh || placedObjects.length === 0) return;
  const { minTop, heightRange } = scanHeightRange(placedObjects);
  const color = new THREE.Color();
  placedObjects.forEach((entry, i) => {
    placedMesh.setColorAt(i, instanceColorFor(entry, i, minTop, heightRange, color));
  });
  placedMesh.instanceColor.needsUpdate = true;
}

// Floor/strip light tiles (isPathLight()) are meant to read as continuous
// lines — like a subway map's rail lines — but TaleSpire places them as
// individual, sometimes-rotated 1x1/2x2 tiles, which left visible gaps at the
// seams when each just rendered as its own separate box. This connects any
// two path-tile centers that are within reach of each other (scaled by their
// combined footprint, so bigger tiles reach further) with a single thick
// glowing line segment, and returns which of the input entries got at least
// one connection so the caller can exclude only those from the regular
// per-tile box rendering. Isolated path tiles (no neighbor in range) are
// deliberately left OUT of connectedSet — they fall through to the normal
// isLight() box treatment in buildPlacedMesh() so nothing just disappears.
function buildLightPathNetwork(pathTiles) {
  const connectedSet = new Set();
  if (pathTiles.length < 2) return { object3d: null, connectedSet };

  const nodes = pathTiles.map((entry) => {
    const pos = unityPositionToThree(entry.position ?? { x: 0, y: 0, z: 0 });
    const size = entry.size ?? { x: 1, y: 1, z: 1 };
    // Sit just above the tile's own top surface so the line reads as an
    // embedded glowing strip, not a line floating mid-air or z-fighting with
    // the tile beneath it.
    pos.y += size.y / 2 + 0.03;
    return { pos, footprint: Math.max(size.x, size.z), entry };
  });

  const positions = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const threshold = (a.footprint + b.footprint) * pathSensitivity;
      if (a.pos.distanceTo(b.pos) <= threshold) {
        positions.push(a.pos.x, a.pos.y, a.pos.z, b.pos.x, b.pos.y, b.pos.z);
        connectedSet.add(a.entry);
        connectedSet.add(b.entry);
      }
    }
  }
  if (positions.length === 0) return { object3d: null, connectedSet };

  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);
  const material = new LineMaterial({
    color: pathColor.getHex(),
    linewidth: pathWidth,
    worldUnits: true,
  });
  material.resolution.set(window.innerWidth, window.innerHeight);
  resizableLineMaterials.push(material);

  const object3d = new LineSegments2(geometry, material);
  object3d.computeLineDistances();
  return { object3d, connectedSet };
}

// Decomposes one instance's matrix into its world center and top-face height,
// used when the GM clicks a building to anchor a new location to it.
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
function instanceCenterAndTop(instanceId) {
  placedMesh.getMatrixAt(instanceId, _m);
  _m.decompose(_p, _q, _s);
  return { center: _p.clone(), top: _p.y + _s.y / 2 };
}

// Points the shadow-casting sun at the board and sizes its (orthographic)
// shadow-camera frustum to cover it. Depends on the board's actual size, so
// it's recomputed per load rather than set once at startup.
function positionSun(bounds) {
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const horizontalExtent = Math.max(size.x, size.z, 1);
  const height = Math.max(size.y, 1);

  const elevation = THREE.MathUtils.degToRad(35);
  const azimuth = THREE.MathUtils.degToRad(-40);
  const direction = new THREE.Vector3(
    Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.cos(azimuth)
  );
  const distance = horizontalExtent + height * 2;

  sun.position.copy(center).addScaledVector(direction, distance);
  sun.target.position.copy(center);
  sun.target.updateMatrixWorld();

  const frustumHalf = horizontalExtent * 1.3;
  sun.shadow.camera.left = -frustumHalf;
  sun.shadow.camera.right = frustumHalf;
  sun.shadow.camera.top = frustumHalf;
  sun.shadow.camera.bottom = -frustumHalf;
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = distance * 2 + height;
  sun.shadow.camera.updateProjectionMatrix();
}

function fitTopDown(bounds) {
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const horizontalExtent = Math.max(size.x, size.z, 1);
  const height = Math.max(size.y, 1);

  viewSize = horizontalExtent * 1.1;
  updateFrustum();

  // Marker scale follows board size so pins/lines are visible whatever the
  // board's extent.
  markerLift = THREE.MathUtils.clamp(height * 0.6, 3, 14);
  pinSize = THREE.MathUtils.clamp(horizontalExtent * 0.012, 0.8, 2.5);

  // Near-overhead (see TOP_DOWN_TILT above for why not exactly overhead).
  const radius = height + horizontalExtent;
  camera.position.set(
    center.x,
    center.y + radius * Math.cos(TOP_DOWN_TILT),
    center.z + radius * Math.sin(TOP_DOWN_TILT)
  );
  controls.target.copy(center);
  controls.update();
}

// --- location rendering -------------------------------------------------------

// Anchor point (world) where a location's card is drawn: straight up from the
// building top by markerLift.
function locationAnchor(loc) {
  return new THREE.Vector3(loc.x, loc.top + markerLift, loc.z);
}

// Marker visual: a flat double ring "reticle" on the ground (reads clearly
// from directly overhead, unlike a cone whose downward apex all but
// disappears in top-down view) plus a small hovering beacon that keeps it
// legible when the camera is tilted. Geometry is shared across all markers;
// only material (color) differs between normal/active state.
const ringGeometry = new THREE.RingGeometry(0.34, 0.44, 32);
const glowRingGeometry = new THREE.RingGeometry(0.48, 0.66, 32);
const beaconGeometry = new THREE.OctahedronGeometry(0.22, 0);

// Unlit (MeshBasicMaterial): markers must stay vividly visible even when the
// building underneath sits in the sun's shadow — they shouldn't dim like a
// lit surface would.
function markerMaterials(color) {
  return {
    ring: new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
    glow: new THREE.MeshBasicMaterial({
      color, side: THREE.DoubleSide, transparent: true, opacity: 0.3, depthWrite: false,
    }),
    beacon: new THREE.MeshBasicMaterial({ color }),
  };
}
const markerPalette = {
  base: markerMaterials(markerColor),
  active: markerMaterials(markerActiveColor),
};

// Mutates the shared marker materials in place (rather than recreating them)
// so the color tweak takes effect on already-visible markers instantly,
// without a rebuild/dispose cycle running on every hover-driven rebuildMarkers().
function setMarkerColor(hex) {
  markerColor = hex;
  markerActiveColor = markerActiveColorFor(hex);
  markerPalette.base.ring.color.set(markerColor);
  markerPalette.base.glow.color.set(markerColor);
  markerPalette.base.beacon.color.set(markerColor);
  markerPalette.active.ring.color.set(markerActiveColor);
  markerPalette.active.glow.color.set(markerActiveColor);
  markerPalette.active.beacon.color.set(markerActiveColor);
  rebuildMarkers(); // leader lines are plain LineBasicMaterial recreated per call — need a fresh pass to pick up the new color
}

function disposeObject3D(obj) {
  obj.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    // Geometries are shared module-level constants above; materials are the
    // shared markerPalette ones too — neither should be disposed per-marker.
  });
}

function buildMarkerVisual(materials) {
  const group = new THREE.Group();

  const ring = new THREE.Mesh(ringGeometry, materials.ring);
  ring.rotation.x = -Math.PI / 2; // lie flat, facing up
  group.add(ring);

  const glow = new THREE.Mesh(glowRingGeometry, materials.glow);
  glow.rotation.x = -Math.PI / 2;
  group.add(glow);

  const beacon = new THREE.Mesh(beaconGeometry, materials.beacon);
  beacon.position.y = 0.5;
  beacon.userData.isBeacon = true;
  group.add(beacon);

  return group;
}

function rebuildMarkers() {
  for (const c of [...pinGroup.children]) {
    pinGroup.remove(c);
    disposeObject3D(c);
  }
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

    // Leader line from the building top up to the card anchor.
    const anchor = locationAnchor(loc);
    const lineGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(loc.x, loc.top, loc.z),
      anchor,
    ]);
    const line = new THREE.Line(
      lineGeom,
      new THREE.LineBasicMaterial({ color: active ? markerActiveColor : markerColor })
    );
    leaderGroup.add(line);
  }
}

// --- localStorage persistence -------------------------------------------------

function saveLocations() {
  if (!boardKey) return;
  try {
    localStorage.setItem(boardKey, JSON.stringify(locations));
  } catch (err) {
    console.warn("Couldn't save locations:", err);
  }
}

function loadLocations() {
  if (!boardKey) return [];
  try {
    const raw = localStorage.getItem(boardKey);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// --- card DOM -----------------------------------------------------------------

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

// Projects a world point to CSS pixel coordinates. behind=true when the point
// is outside the camera's near/far range (shouldn't happen for our anchors,
// but guards against a card flickering to a wrong spot).
function projectToScreen(v) {
  const ndc = v.clone().project(camera);
  return {
    x: (ndc.x * 0.5 + 0.5) * window.innerWidth,
    y: (-ndc.y * 0.5 + 0.5) * window.innerHeight,
    behind: ndc.z > 1 || ndc.z < -1,
  };
}

// Runs every frame: positions the card at its location's anchor and fills in
// content. Editing (GM + selected) is left alone so typing isn't clobbered.
function updateCard() {
  const loc = activeLocation();
  if (!loc) {
    cardEl.classList.add("hidden");
    return;
  }

  const anchor = locationAnchor(loc);
  const screen = projectToScreen(anchor);
  if (screen.behind) {
    cardEl.classList.add("hidden");
    return;
  }

  cardEl.classList.remove("hidden");
  cardEl.style.left = `${screen.x + 8}px`;
  cardEl.style.top = `${screen.y}px`;

  const editing = gmMode && loc.id === selectedLocationId;
  editEl.classList.toggle("hidden", !editing);
  viewEl.classList.toggle("hidden", editing);

  if (!editing) {
    viewTitleEl.textContent = loc.title ?? "";
    viewDescEl.textContent = loc.description ?? "";
  }
}

// Populates and shows the editor for a location (GM).
function openEditor(loc) {
  editTitleEl.value = loc.title ?? "";
  editDescEl.value = loc.description ?? "";
  // Focus the title for a freshly created (untitled) location.
  if (!loc.title) setTimeout(() => editTitleEl.focus(), 0);
}

document.getElementById("loc-save").addEventListener("click", () => {
  const loc = locations.find((l) => l.id === selectedLocationId);
  if (!loc) return;
  loc.title = editTitleEl.value.trim();
  loc.description = editDescEl.value.trim();
  saveLocations();
  selectedLocationId = null;
  rebuildMarkers();
});

document.getElementById("loc-delete").addEventListener("click", () => {
  locations = locations.filter((l) => l.id !== selectedLocationId);
  selectedLocationId = null;
  hoveredLocationId = null;
  saveLocations();
  rebuildMarkers();
});

// --- pointer interaction ------------------------------------------------------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downPos = null;

function setPointerFromEvent(event) {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
}

function pickPin() {
  raycaster.setFromCamera(pointer, camera);
  // Recursive: each marker is a Group (ring + glow + beacon meshes), not a
  // single raycastable mesh.
  const hit = raycaster.intersectObjects(pinGroup.children, true)[0];
  return hit ? hit.object.userData.locationId : null;
}

function pickBuilding() {
  if (!placedMesh) return null;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(placedMesh, false)[0];
  return hit && hit.instanceId != null ? hit.instanceId : null;
}

// Hover: highlight/show whichever pin is under the cursor. Cheap — only the
// handful of pins are raycast, never the 18k-instance building mesh.
canvas.addEventListener("pointermove", (event) => {
  setPointerFromEvent(event);
  const id = pickPin();
  if (id !== hoveredLocationId) {
    hoveredLocationId = id;
    rebuildMarkers();
  }
});

canvas.addEventListener("pointerdown", (event) => {
  downPos = { x: event.clientX, y: event.clientY };
});

// Treat as a click only if the pointer barely moved (otherwise it's an
// OrbitControls drag, which shouldn't create/select anything).
canvas.addEventListener("pointerup", (event) => {
  if (!downPos) return;
  const moved = Math.hypot(event.clientX - downPos.x, event.clientY - downPos.y);
  downPos = null;
  if (moved > 5) return;

  setPointerFromEvent(event);

  const pinId = pickPin();
  if (pinId != null) {
    // Clicking an existing pin: GM selects it for editing; players just keep
    // the hover preview.
    if (gmMode) {
      selectedLocationId = pinId;
      openEditor(locations.find((l) => l.id === pinId));
      rebuildMarkers();
    }
    return;
  }

  if (!gmMode) {
    selectedLocationId = null;
    return;
  }

  // GM clicked something other than a pin: if it's a building, add a location
  // there (deduping if one already sits on that building).
  const instanceId = pickBuilding();
  if (instanceId == null) {
    selectedLocationId = null; // clicked empty space -> close editor
    return;
  }

  const { center, top } = instanceCenterAndTop(instanceId);
  const existing = locations.find(
    (l) => Math.hypot(l.x - center.x, l.z - center.z) < 0.6 && Math.abs(l.top - top) < 0.6
  );
  if (existing) {
    selectedLocationId = existing.id;
    openEditor(existing);
    rebuildMarkers();
    return;
  }

  const guid = placedObjects[instanceId]?.assetGuid;
  const loc = {
    id: `loc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    x: center.x,
    y: center.y,
    z: center.z,
    top,
    title: assetName(guid) ?? "",
    description: "",
  };
  locations.push(loc);
  selectedLocationId = loc.id;
  saveLocations();
  openEditor(loc);
  rebuildMarkers();
});

// --- GM toggle ----------------------------------------------------------------

const gmHint = document.getElementById("gm-hint");
document.getElementById("gm-checkbox").addEventListener("change", (event) => {
  gmMode = event.target.checked;
  gmHint.classList.toggle("visible", gmMode);
  if (!gmMode) selectedLocationId = null; // leaving GM mode closes any editor
  rebuildMarkers();
});

// --- tweak panel ----------------------------------------------------------------

const tweakGroundEl = document.getElementById("tweak-ground");
const tweakBuildingEl = document.getElementById("tweak-building");
const tweakSubwayEl = document.getElementById("tweak-subway");
const tweakSubwayWidthEl = document.getElementById("tweak-subway-width");
const tweakSubwaySensitivityEl = document.getElementById("tweak-subway-sensitivity");
const tweakMarkerEl = document.getElementById("tweak-marker");

function hexOf(color) {
  return "#" + color.getHexString();
}

// Seed the controls from the actual current values (rather than duplicating
// the defaults here) so this can never silently drift out of sync with the
// state declared at the top of the file.
tweakGroundEl.value = hexOf(groundColor);
tweakBuildingEl.value = hexOf(buildingColor);
tweakSubwayEl.value = hexOf(pathColor);
tweakSubwayWidthEl.value = String(pathWidth);
tweakSubwaySensitivityEl.value = String(pathSensitivity);
tweakMarkerEl.value = "#" + markerColor.toString(16).padStart(6, "0");

tweakGroundEl.addEventListener("input", (e) => {
  groundColor.set(e.target.value);
  recolorPlacedMesh();
});
tweakBuildingEl.addEventListener("input", (e) => {
  buildingColor.set(e.target.value);
  recolorPlacedMesh();
});
tweakSubwayEl.addEventListener("input", (e) => {
  pathColor.set(e.target.value);
  if (pathNetwork) pathNetwork.material.color.set(pathColor);
});
tweakSubwayWidthEl.addEventListener("input", (e) => {
  pathWidth = parseFloat(e.target.value);
  if (pathNetwork) pathNetwork.material.linewidth = pathWidth;
});
tweakMarkerEl.addEventListener("input", (e) => {
  setMarkerColor(parseInt(e.target.value.slice(1), 16));
});

// Sensitivity changes the *topology* (which tiles count as connected), so it
// needs a real rebuild of the path network and building mesh — unlike the
// other tweaks above, which just mutate an existing material/instance color.
// Debounced so dragging the slider doesn't rebuild an 18k-instance mesh on
// every intermediate tick.
let sensitivityRebuildTimer = null;
tweakSubwaySensitivityEl.addEventListener("input", (e) => {
  pathSensitivity = parseFloat(e.target.value);
  clearTimeout(sensitivityRebuildTimer);
  sensitivityRebuildTimer = setTimeout(() => {
    if (lastPlaced.length > 0) rebuildSceneGeometry(lastPlaced, false);
  }, 120);
});

// --- load flow ----------------------------------------------------------------

function updatePanel(data, shownCount, hiddenCreatureCount) {
  const info = document.getElementById("board-info");
  info.innerHTML = `
    <div><strong>${escapeHtml(data.boardName ?? "Untitled board")}</strong></div>
    <div>${shownCount} object${shownCount === 1 ? "" : "s"} shown</div>
    <div>${hiddenCreatureCount} creature${hiddenCreatureCount === 1 ? "" : "s"} hidden</div>
    <div>${data.exportedAt ? new Date(data.exportedAt).toLocaleString() : ""}</div>
  `;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Builds (or rebuilds) the path network + building mesh from a placed-object
// list. Used both for a fresh load (refit=true: also reframe the camera and
// re-aim the sun) and for tweaks that change connection topology, like path
// sensitivity, where the current camera framing should be left alone.
function rebuildSceneGeometry(placed, refit) {
  clearPlaced();
  if (placed.length === 0) return;

  // Pull floor/strip light tiles that end up connected into the path network
  // out of the regular box rendering (see buildLightPathNetwork).
  const pathCandidates = placed.filter((o) => isPathLight(o.assetGuid));
  const { object3d: network, connectedSet } = buildLightPathNetwork(pathCandidates);
  if (network) {
    pathNetwork = network;
    scene.add(pathNetwork);
  }
  const regular = connectedSet.size > 0 ? placed.filter((o) => !connectedSet.has(o)) : placed;

  const { mesh, bounds } = buildPlacedMesh(regular);
  placedMesh = mesh;
  scene.add(placedMesh);
  if (refit) {
    fitTopDown(bounds);
    positionSun(bounds);
  }
}

function loadExport(data) {
  if (!Array.isArray(data.objects)) {
    alert("This file doesn't look like a TaleSpire map export (missing an \"objects\" array).");
    return;
  }

  const placed = data.objects.filter((o) => o.category !== "creature");
  const hiddenCreatureCount = data.objects.length - placed.length;
  lastPlaced = placed;

  selectedLocationId = null;
  hoveredLocationId = null;

  // Board fingerprint for per-board location persistence: name + object count
  // is enough to keep different boards' locations apart in localStorage.
  boardKey = `tsmap-locations:${data.boardName ?? "board"}:${data.objects.length}`;
  locations = loadLocations();

  rebuildSceneGeometry(placed, true);
  rebuildMarkers();
  updatePanel(data, placed.length, hiddenCreatureCount);
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      loadExport(JSON.parse(reader.result));
    } catch (err) {
      alert("Couldn't parse that file as JSON: " + err.message);
    }
  };
  reader.readAsText(file);
}

document.getElementById("file-input").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) loadFile(file);
});

const dropOverlay = document.getElementById("drop-overlay");
["dragenter", "dragover"].forEach((eventName) => {
  window.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropOverlay.classList.add("active");
  });
});
["dragleave", "drop"].forEach((eventName) => {
  window.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (eventName === "drop") {
      const file = event.dataTransfer?.files?.[0];
      if (file) loadFile(file);
    }
    dropOverlay.classList.remove("active");
  });
});

// Load the asset index (names + water flags) first, then auto-load the sample
// export. If the index is missing, the map still renders — water just won't be
// tinted blue and locations default to an empty title.
fetch("./asset-index.json")
  .then((res) => (res.ok ? res.json() : Promise.reject()))
  .then((data) => { assetIndex = data.assets ?? {}; })
  .catch(() => { console.warn("asset-index.json not found; water tint + names disabled."); })
  .finally(() => {
    fetch("./TaleSpire Board_20260722_164510.json")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then(loadExport)
      .catch(() => {});
  });
