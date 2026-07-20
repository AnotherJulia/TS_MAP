import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const CATEGORY_COLORS = {
  floor: 0x6b7280,
  wall: 0xb45309,
  prop: 0x2f6fed,
  creature: 0xe5484d,
  unknown: 0x8b5cf6,
};

const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
camera.position.set(6, 6, 6);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x30323a, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(5, 10, 3);
scene.add(sun);

const grid = new THREE.GridHelper(40, 40, 0x3a3d45, 0x24262c);
scene.add(grid);

let objectGroup = new THREE.Group();
scene.add(objectGroup);

function resize() {
  const { clientWidth, clientHeight } = renderer.domElement.parentElement === document.body
    ? document.body
    : renderer.domElement;
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// TaleSpire (Unity) is left-handed Y-up; Three.js is right-handed Y-up.
// Negating Z on both position and quaternion is the standard conversion for
// this axis pair — verify against a real export once phase 3 of the mod lands.
function unityPositionToThree(p) {
  return new THREE.Vector3(p.x, p.y, -p.z);
}
function unityQuaternionToThree(q) {
  return new THREE.Quaternion(q.x, q.y, -q.z, -q.w);
}

function colorForCategory(category) {
  return CATEGORY_COLORS[category] ?? CATEGORY_COLORS.unknown;
}

function clearObjects() {
  objectGroup.parent.remove(objectGroup);
  objectGroup = new THREE.Group();
  scene.add(objectGroup);
}

function buildObject(entry) {
  const size = entry.size ?? { x: 1, y: 1, z: 1 };
  const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
  const color = colorForCategory(entry.category);

  const fill = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.35 })
  );
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color })
  );

  const holder = new THREE.Group();
  holder.add(fill, edges);

  const pos = entry.position ?? { x: 0, y: 0, z: 0 };
  const rot = entry.rotation ?? { x: 0, y: 0, z: 0, w: 1 };
  holder.position.copy(unityPositionToThree(pos));
  holder.quaternion.copy(unityQuaternionToThree(rot));
  holder.name = entry.name ?? entry.id ?? "object";

  return holder;
}

function fitCameraToObjects() {
  const box = new THREE.Box3().setFromObject(objectGroup);
  if (box.isEmpty()) return;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);

  const distance = maxDim * 1.8;
  camera.position.set(center.x + distance, center.y + distance * 0.8, center.z + distance);
  controls.target.copy(center);
  controls.update();
}

function updatePanel(data) {
  const info = document.getElementById("board-info");
  const objects = data.objects ?? [];
  info.innerHTML = `
    <div><strong>${escapeHtml(data.boardName ?? "Untitled board")}</strong></div>
    <div>${objects.length} object${objects.length === 1 ? "" : "s"}</div>
    <div>${data.exportedAt ? new Date(data.exportedAt).toLocaleString() : ""}</div>
  `;

  const counts = {};
  for (const entry of objects) {
    const category = entry.category ?? "unknown";
    counts[category] = (counts[category] ?? 0) + 1;
  }

  const legend = document.getElementById("legend");
  legend.innerHTML = "";
  for (const [category, count] of Object.entries(counts)) {
    const row = document.createElement("div");
    row.className = "legend-row";
    const color = "#" + colorForCategory(category).toString(16).padStart(6, "0");
    row.innerHTML = `
      <span class="legend-swatch" style="background:${color}"></span>
      <span>${escapeHtml(category)}</span>
      <span class="legend-count">${count}</span>
    `;
    legend.appendChild(row);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function loadExport(data) {
  if (!Array.isArray(data.objects)) {
    alert("This file doesn't look like a TaleSpire map export (missing an \"objects\" array).");
    return;
  }
  clearObjects();
  for (const entry of data.objects) {
    objectGroup.add(buildObject(entry));
  }
  fitCameraToObjects();
  updatePanel(data);
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

// Best-effort auto-load of the sample export when served over http(s); silently
// no-ops under file:// where fetch of local files is blocked — drag the sample
// file in manually in that case.
fetch("../schema/sample-export.json")
  .then((res) => (res.ok ? res.json() : Promise.reject()))
  .then(loadExport)
  .catch(() => {});
