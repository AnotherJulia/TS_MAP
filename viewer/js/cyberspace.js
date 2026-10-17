import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// "Cyberspace" style, after Cyberpunk 2077's netspace / braindance look (Marek Brzezinski's
// and Masahiro Sawada's concept art): black masses whose surfaces are made of fine glowing
// specks - sharp grains on floors, vertical drip-streaks on walls - lit by a light that
// travels with the viewer (or the pawn), plus drifting dust, bloom, edge smear, vignette.
//
// The specks are procedural, per pixel, in the board's own box shader (surfaceMaterial):
// every fragment finds its cell on a fine world-space grid on its face and decides whether
// that cell is a lit speck. That gives reference-like density everywhere with no point
// budget, perfect occlusion, and nothing to rebuild when pieces are removed. Only the
// floating dust is real geometry.

const GLSL_NOISE = /* glsl */ `
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float hash11(float x) { return fract(sin(x * 127.1) * 43758.5453); }
  float noise11(float x) {
    float i = floor(x);
    float f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(hash11(i), hash11(i + 1.0), f);
  }
  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise3(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
`;

// Shared lighting: the light travelling with the pawn/viewer, an optional height gradient
// ("light from below": bright at the foot of each piece's own floor, fading upward), low-
// frequency brightness patches and distance fog.
const GLSL_LIGHT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uLightPos;
  uniform float uLightRadius;
  uniform float uAmbient;
  uniform float uFadeHeight;
  uniform float uHeightFade;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uOrtho;
  // Two scan-pulse slots (scheduled with random timing/speed/strength in main.js):
  // x = start time, y = speed (units/s), z = strength (0 = off), w = ring sharpness.
  uniform vec4 uPulseA;
  uniform vec3 uPulseOriginA;
  uniform vec4 uPulseB;
  uniform vec3 uPulseOriginB;
  float pulseAt(vec3 w, vec4 p, vec3 origin) {
    float age = uTime - p.x;
    if (age < 0.0 || p.z <= 0.0) return 0.0;
    // Wobbly ring edge, so it's never a perfect circle.
    float r = distance(w, origin) + (noise3(w * 0.45 + p.x) - 0.5) * 1.8;
    float ring = age * p.y;
    return p.z * exp(-pow((r - ring) * p.w, 2.0)) * exp(-age * 0.3) * (1.0 - smoothstep(8.0, 48.0, r));
  }
  // floorY: height of the floor this point stands over (per piece, see main.js).
  float sceneLight(vec3 w, float floorY) {
    float dl = distance(w, uLightPos) / uLightRadius;
    float light = uAmbient + 0.8 / (1.0 + dl * dl);
    light += pulseAt(w, uPulseA, uPulseOriginA) + pulseAt(w, uPulseB, uPulseOriginB);
    float above = smoothstep(floorY, floorY + uFadeHeight, w.y);
    light *= mix(1.0, mix(1.15, 0.25, above), uHeightFade);
    float cluster = noise3(w * 0.32 + vec3(0.0, uTime * 0.04, 0.0));
    return light * (0.5 + 1.0 * cluster);
  }
  // Soft highlight roll-off, so stacked light never clips to a white blob.
  float tone(float b) { return b / (1.0 + 0.55 * b); }
  float fogAt(float depth) {
    return uOrtho > 0.5 ? 0.0 : smoothstep(uFogNear, uFogFar, depth);
  }
`;

const surfaceVertex = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_vertex>
  varying vec3 vLocal;
  varying vec3 vSize;
  varying vec3 vWorld;
  varying vec3 vTint;
  varying float vDepth;
  varying float vFloorY;
  attribute float aFloorY;
  void main() {
    vLocal = position;
    vFloorY = aFloorY;
    vSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
    #ifdef USE_INSTANCING_COLOR
      vTint = instanceColor;
    #else
      vTint = vec3(1.0);
    #endif
    vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vWorld = worldPos.xyz;
    vec4 mvPosition = viewMatrix * worldPos;
    vDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }
`;

const surfaceFragment = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_fragment>
  ${GLSL_NOISE}
  ${GLSL_LIGHT}
  uniform float uCell; // speck grid size in world units
  uniform vec3 uDeep;
  uniform vec3 uCyan;
  uniform vec3 uWhite;
  varying vec3 vLocal;
  varying vec3 vSize;
  varying vec3 vWorld;
  varying vec3 vTint;
  varying float vDepth;
  varying float vFloorY;
  void main() {
    #include <clipping_planes_fragment>
    // Which face this fragment is on: the axis whose face is nearest (in world units).
    vec3 d = (0.5 - abs(vLocal)) * vSize;
    bool horizontal = d.y <= d.x && d.y <= d.z;
    vec2 uv = horizontal ? vWorld.xz : (d.x <= d.z ? vWorld.zy : vWorld.xy);

    // Dots on a fine grid, each jittered inside its cell with its own size, brightness and
    // flicker - loose rows of specks rather than a rigid mosaic. Walls use slightly taller
    // dots, and about one column in six carries a drip streak sliding down.
    vec2 cell = horizontal ? vec2(uCell) : vec2(uCell, uCell * 1.5);
    vec2 g = uv / cell;
    vec2 id = floor(g);
    vec2 f = fract(g);
    // Smallest on-screen extent of a cell; at grazing angles cells squash in one direction
    // first, so measure both.
    vec2 fw = fwidth(g);
    float pxPerCell = 1.0 / max(max(fw.x, fw.y), 1e-4);

    float h1 = hash21(id);
    float h2 = hash21(id + 17.3);
    float h3 = hash21(id + 41.7);
    vec2 center = 0.5 + (vec2(h2, h3) - 0.5) * 0.45;
    float size = 0.12 + 0.22 * hash21(id + 5.1);
    vec2 q = abs(f - center);
    float dotShape = step(max(q.x, q.y), size);
    // Clumps: density follows a noise field (dense clusters, sparse gaps), and every piece
    // gets its own brightness so a facade reads as many parts, not one flat sheet.
    float clump = noise3(vWorld * 0.7);
    float on = step(mix(horizontal ? 0.3 : 0.35, 0.85, clump), h1);
    vec3 pieceCenter = vWorld - vLocal * vSize;
    float pieceGain = 0.65 + 0.7 * hash3(floor(pieceCenter * 2.0) + 0.37);
    float flicker = 0.75 + 0.25 * sin(uTime * (1.0 + 3.0 * h2) + h3 * 60.0);
    float speck = on * dotShape * (0.25 + 0.95 * h2 * h2) * flicker * pieceGain;
    // Fallback for sub-pixel cells. Kept low on purpose: a high value turns distant and
    // grazing-angle floors into a flat blue sheet ("wash") instead of fading them out.
    float average = horizontal ? 0.035 : 0.03;

    if (!horizontal) {
      float colSeed = hash11(id.x * 1.37 + 0.5);
      if (colSeed > 0.83) {
        float band = noise11(uv.y * (1.2 + colSeed * 1.6) + colSeed * 40.0 + uTime * 0.25 * colSeed);
        band = smoothstep(0.5, 0.92, band);
        float column = step(0.3, f.x) * step(f.x, 0.7);
        float grain = step(0.3, hash21(vec2(id.x, floor(uv.y / (uCell * 0.5)))));
        speck = max(speck, band * column * grain * 0.9);
        average += 0.01;
      }
    }
    // Cells smaller than a couple of pixels would shimmer: blend them to their average.
    speck = mix(average, speck, smoothstep(1.2, 3.0, pxPerCell));

    float b = tone(speck * sceneLight(vWorld, vFloorY) * (horizontal ? 1.45 : 1.2));
    vec3 col = mix(uDeep, uCyan, smoothstep(0.04, 0.45, b));
    col = mix(col, uWhite, smoothstep(0.6, 0.95, b));
    gl_FragColor = vec4(col * b * vTint * (1.0 - fogAt(vDepth)), 1.0);
    #include <colorspace_fragment>
  }
`;

const dustVertex = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_vertex>
  ${GLSL_NOISE}
  ${GLSL_LIGHT}
  uniform float uPxPerUnit;
  attribute float aSeed;
  varying float vBright;
  varying float vFog;
  void main() {
    vec3 p = position;
    p.y += mod(uTime * (0.05 + aSeed * 0.15) + aSeed * 40.0, 12.0) - 6.0;
    p.x += sin(uTime * 0.2 + aSeed * 30.0) * 0.4;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    float depth = max(-mvPosition.z, 0.001);
    float world = 0.05 + aSeed * 0.07;
    gl_PointSize = clamp(uOrtho > 0.5 ? world * uPxPerUnit : world * uPxPerUnit / depth, 1.0, 6.0);
    vBright = tone(sceneLight(p, p.y) * (0.35 + 0.65 * aSeed)); // dust: no height gradient
    vFog = fogAt(depth);
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }
`;

const dustFragment = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_fragment>
  uniform vec3 uCyan;
  varying float vBright;
  varying float vFog;
  void main() {
    #include <clipping_planes_fragment>
    vec2 c = abs(gl_PointCoord - 0.5);
    if (max(c.x, c.y) > 0.45) discard;
    gl_FragColor = vec4(uCyan * vBright * (1.0 - vFog), 1.0);
  }
`;

// Surface particles: a sparse 3D layer on top of the speckle shader so surfaces don't read
// as flat planes. aKind: 0 floor stalk (bar standing up), 1 wall fuzz (drifts off the
// wall and fades), 2 drip (peels off a wall and falls), 3 relief (static, clustered,
// standing off the wall at varying depth - gives walls parallax).
const particleVertex = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_vertex>
  ${GLSL_NOISE}
  ${GLSL_LIGHT}
  uniform float uPxPerUnit;
  attribute float aSeed;
  attribute float aKind;
  attribute float aFloorY;
  attribute vec3 aNormal;
  varying float vBright;
  varying float vFog;
  varying float vLen;
  varying float vKind;
  void main() {
    float s2 = fract(aSeed * 7.131 + 0.37);
    float life = fract(uTime * (0.08 + s2 * 0.25) + aSeed * 17.0);
    vec3 p = position;
    float alpha = 1.0;
    float len = 1.0;
    if (aKind < 0.5) {
      len = 1.5 + s2 * s2 * 5.0;            // stalk height in bar widths
      alpha = 0.6 + 0.4 * sin(uTime * (1.0 + s2 * 3.0) + aSeed * 50.0);
    } else if (aKind < 1.5) {
      p += aNormal * (0.02 + life * (0.15 + s2 * 0.45));
      alpha = sin(life * 3.14159);
      len = 1.0 + s2 * 2.0;
    } else if (aKind < 2.5) {
      p.y -= life * (0.6 + s2 * 2.5);
      alpha = 1.0 - life;
      len = 2.0 + s2 * 3.0;
    } else {
      // Relief: static specks standing off the wall at their own depth (set at build time).
      alpha = 0.7 + 0.3 * sin(uTime * (0.7 + s2 * 2.0) + aSeed * 40.0);
      len = 1.0 + s2 * 1.5;
    }
    float width = 0.02;
    float barWorld = width * len;
    // Stalks stand on the surface; everything else is centred on its point.
    if (aKind < 0.5) p.y += barWorld * 0.5;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    float depth = max(-mvPosition.z, 0.001);
    gl_PointSize = clamp(uOrtho > 0.5 ? barWorld * uPxPerUnit : barWorld * uPxPerUnit / depth, 1.0, 40.0);
    vBright = tone(sceneLight(position, aFloorY) * alpha * (0.35 + 0.5 * aSeed));
    vFog = fogAt(depth);
    vLen = len;
    vKind = aKind;
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }
`;

const particleFragment = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_fragment>
  uniform vec3 uDeep;
  uniform vec3 uCyan;
  uniform vec3 uWhite;
  varying float vBright;
  varying float vFog;
  varying float vLen;
  varying float vKind;
  void main() {
    #include <clipping_planes_fragment>
    // A bar of constant width inside a sprite sized to its length, brightest at the top.
    vec2 pc = gl_PointCoord;
    float halfW = 0.5 / vLen;
    if (abs(pc.x - 0.5) > halfW) discard;
    float a = vLen > 1.01 ? 1.0 - pc.y * 0.7 : 1.0;
    float b = vBright * a;
    vec3 col = mix(uDeep, uCyan, smoothstep(0.05, 0.6, b));
    col = mix(col, uWhite, smoothstep(0.6, 0.95, b));
    gl_FragColor = vec4(col * b * (1.0 - vFog), 1.0);
  }
`;

// Chromatic aberration and horizontal smear growing toward the screen edges, rare glitch
// bands, crushed blacks, blue-teal grade, light grain, heavy vignette.
const FxShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uAberration: { value: 0.0011 },
    uGrain: { value: 0.012 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uAberration;
    uniform float uGrain;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      vec2 d = uv - 0.5;

      float row = floor(uv.y * 180.0);
      float glitch = step(0.997, hash(vec2(row, floor(uTime * 4.0))));
      uv.x += glitch * (hash(vec2(row, uTime)) - 0.5) * 0.015;

      float edge = smoothstep(0.12, 0.5, abs(d.x)) + smoothstep(0.2, 0.5, abs(d.y)) * 0.5;
      float ab = uAberration * (0.3 + edge * 3.0);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + vec2(ab, 0.0)).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - vec2(ab, 0.0)).b;

      vec3 smear = vec3(0.0);
      float reach = 0.002 + edge * 0.01;
      for (int i = 1; i <= 6; i++) {
        float o = float(i) * reach;
        smear += texture2D(tDiffuse, uv + vec2(o, 0.0)).rgb + texture2D(tDiffuse, uv - vec2(o, 0.0)).rgb;
      }
      col = mix(col, smear / 12.0, edge * 0.5); // smear only toward the edges; centre stays crisp

      col = max(col - 0.012, 0.0) * 1.06;
      col *= vec3(0.86, 1.0, 1.02); // teal grade
      col *= smoothstep(0.9, 0.18, length(d * vec2(1.0, 1.3)));
      col += (hash(uv * uResolution + fract(uTime) * 100.0) - 0.5) * uGrain;
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

const MAX_PARTICLES = 700_000;

const mulberry32 = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export function createCyberspace({ scene, renderer, clipPlanes }) {
  const lighting = {
    uTime: { value: 0 },
    uLightPos: { value: new THREE.Vector3() },
    uLightRadius: { value: 8 },
    uAmbient: { value: 0.2 },
    uFadeHeight: { value: 4 },
    uHeightFade: { value: 1 },
    uFogNear: { value: 20 },
    uFogFar: { value: 90 },
    uOrtho: { value: 0 },
    uPulseA: { value: new THREE.Vector4(0, 1, 0, 1) },
    uPulseOriginA: { value: new THREE.Vector3() },
    uPulseB: { value: new THREE.Vector4(0, 1, 0, 1) },
    uPulseOriginB: { value: new THREE.Vector3() },
  };
  const colors = {
    uDeep: { value: new THREE.Color(0x0c3448) },
    uCyan: { value: new THREE.Color(0x4cc3e6) },
    uWhite: { value: new THREE.Color(0xe2fbff) },
  };

  // For the board's box mesh in this style. Instance colors tint it: white normally,
  // other tints for selection / water (set by the caller). The mesh geometry needs a
  // per-instance aFloorY attribute (the floor height under each piece).
  const surfaceMaterial = new THREE.ShaderMaterial({
    uniforms: { ...lighting, ...colors, uCell: { value: 0.025 } },
    vertexShader: surfaceVertex,
    fragmentShader: surfaceFragment,
    side: THREE.DoubleSide,
    clipping: true,
  });
  surfaceMaterial.clippingPlanes = clipPlanes;

  const dustMaterial = new THREE.ShaderMaterial({
    uniforms: { ...lighting, uCyan: colors.uCyan, uPxPerUnit: { value: 800 } },
    vertexShader: dustVertex,
    fragmentShader: dustFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    clipping: true,
  });
  dustMaterial.clippingPlanes = clipPlanes;

  const particleMaterial = new THREE.ShaderMaterial({
    uniforms: { ...lighting, ...colors, uPxPerUnit: dustMaterial.uniforms.uPxPerUnit },
    vertexShader: particleVertex,
    fragmentShader: particleFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    clipping: true,
  });
  particleMaterial.clippingPlanes = clipPlanes;

  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);
  let dust = null;
  let particles = null;

  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, null);
  // Tight, high-threshold bloom: a small halo on the brightest specks only. A wide radius /
  // low threshold merges neighbouring halos into a blue haze between the specks.
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.2, 0.55);
  const fx = new ShaderPass(FxShader);
  composer.addPass(renderPass);
  composer.addPass(bloom);
  composer.addPass(fx);
  composer.addPass(new OutputPass());
  const _size = new THREE.Vector2();

  // records: the kept board pieces (scene space); floorY: per record, the floor height under
  // it (for the light-from-below gradient). Builds surface particles and floating dust.
  function build(records, floorY) {
    for (const o of [dust, particles]) {
      if (!o) continue;
      group.remove(o);
      o.geometry.dispose();
    }
    dust = particles = null;
    if (!records.length) return;
    buildParticles(records, floorY);
    const box = new THREE.Box3();
    for (const r of records) {
      box.expandByPoint(new THREE.Vector3(r.min.x, r.min.y, r.min.z));
      box.expandByPoint(new THREE.Vector3(r.max.x, r.max.y, r.max.z));
    }
    const size = box.getSize(new THREE.Vector3());
    const n = Math.min(40000, Math.round(size.x * size.z * 0.8));
    const rand = mulberry32(7);
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = box.min.x + rand() * size.x;
      pos[i * 3 + 1] = box.min.y + rand() * (size.y + 6);
      pos[i * 3 + 2] = box.min.z + rand() * size.z;
      seed[i] = rand();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    dust = new THREE.Points(g, dustMaterial);
    dust.frustumCulled = false;
    group.add(dust);
  }

  function buildParticles(records, floorY) {
    // Skip spots inside another piece (tile sides, floors under walls): never visible.
    const columns = new Map();
    for (const r of records) {
      for (let cx = Math.floor(r.min.x); cx < Math.ceil(r.max.x); cx++) {
        for (let cz = Math.floor(r.min.z); cz < Math.ceil(r.max.z); cz++) {
          const k = cx * 100003 + cz;
          const list = columns.get(k);
          if (list) list.push(r);
          else columns.set(k, [r]);
        }
      }
    }
    const E = 0.005;
    const covered = (x, y, z) => {
      for (const o of columns.get(Math.floor(x) * 100003 + Math.floor(z)) ?? []) {
        if (x >= o.min.x - E && x <= o.max.x + E && y >= o.min.y - E && y <= o.max.y + E && z >= o.min.z - E && z <= o.max.z + E) return true;
      }
      return false;
    };

    let area = 0;
    for (const r of records) area += r.sx * r.sz * 2 + (r.sy > 0.3 ? (r.sx + r.sz) * 2 * r.sy : 0);
    const density = Math.min(5, MAX_PARTICLES / Math.max(area, 1)); // particles per unit^2
    const rand = mulberry32(42);
    const pos = [], seed = [], kind = [], fy = [], nrm = [];
    const add = (x, y, z, k, f, nx, ny, nz) => {
      if (covered(x, y, z)) return;
      pos.push(x, y, z);
      seed.push(rand());
      kind.push(k);
      fy.push(f);
      nrm.push(nx, ny, nz);
    };
    const count = (a) => {
      const n = a * density;
      return Math.floor(n) + (rand() < n - Math.floor(n) ? 1 : 0);
    };
    const O = 0.02; // just off the surface
    records.forEach((r, i) => {
      const f = floorY ? floorY[i] : r.min.y;
      for (let n = count(r.sx * r.sz * 2); n > 0; n--) { // floors get twice the density
        add(r.min.x + rand() * r.sx, r.max.y + O, r.min.z + rand() * r.sz, 0, f, 0, 1, 0);
      }
      if (r.sy <= 0.3) return;
      const wall = (nx, nz, along, width) => {
        for (let n = count(width * r.sy); n > 0; n--) {
          const t = rand() * width;
          const y = r.min.y + rand() * r.sy;
          const x = along === "x" ? r.min.x + t : nx < 0 ? r.min.x - O : r.max.x + O;
          const z = along === "z" ? r.min.z + t : nz < 0 ? r.min.z - O : r.max.z + O;
          add(x, y, z, rand() < 0.75 ? 1 : 2, f, nx, 0, nz);
        }
        // Relief clumps: a few cluster centres per face, specks scattered around them at
        // different depths in front of the wall.
        const clusters = Math.round(width * r.sy * density * 0.05);
        for (let c = 0; c < clusters; c++) {
          const ct = rand() * width;
          const cy = r.min.y + rand() * r.sy;
          const spread = 0.15 + rand() * 0.35;
          const depth = 0.04 + rand() * 0.3;
          for (let n = 6 + Math.floor(rand() * 14); n > 0; n--) {
            const t = Math.min(width, Math.max(0, ct + (rand() - 0.5) * spread));
            const y = Math.min(r.max.y, Math.max(r.min.y, cy + (rand() - 0.5) * spread * 1.6));
            const off = O + depth * (0.4 + rand() * 0.6);
            const x = along === "x" ? r.min.x + t : nx < 0 ? r.min.x - off : r.max.x + off;
            const z = along === "z" ? r.min.z + t : nz < 0 ? r.min.z - off : r.max.z + off;
            add(x, y, z, 3, f, nx, 0, nz);
          }
        }
      };
      wall(0, -1, "x", r.sx);
      wall(0, 1, "x", r.sx);
      wall(-1, 0, "z", r.sz);
      wall(1, 0, "z", r.sz);
    });
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.Float32BufferAttribute(seed, 1));
    g.setAttribute("aKind", new THREE.Float32BufferAttribute(kind, 1));
    g.setAttribute("aFloorY", new THREE.Float32BufferAttribute(fy, 1));
    g.setAttribute("aNormal", new THREE.Float32BufferAttribute(nrm, 3));
    particles = new THREE.Points(g, particleMaterial);
    particles.frustumCulled = false;
    group.add(particles);
  }

  return {
    surfaceMaterial,
    build,
    // Speck grid size in world units: smaller = finer, higher-resolution surfaces.
    setDetail(cell) {
      surfaceMaterial.uniforms.uCell.value = cell;
    },
    setVisible(on) {
      group.visible = on;
    },
    // view: { light: Vector3, lightRadius, ambient, fogNear, fogFar, fadeHeight, heightFade }
    update(time, camera, view) {
      lighting.uTime.value = time;
      lighting.uOrtho.value = camera.isOrthographicCamera ? 1 : 0;
      lighting.uLightPos.value.copy(view.light);
      lighting.uLightRadius.value = view.lightRadius;
      lighting.uAmbient.value = view.ambient;
      lighting.uFadeHeight.value = view.fadeHeight;
      lighting.uHeightFade.value = view.heightFade ? 1 : 0;
      lighting.uFogNear.value = view.fogNear;
      lighting.uFogFar.value = view.fogFar;
      // view.pulses: up to two { start, speed, strength, sharpness, origin }.
      const slots = [
        [lighting.uPulseA, lighting.uPulseOriginA],
        [lighting.uPulseB, lighting.uPulseOriginB],
      ];
      slots.forEach(([u, o], i) => {
        const p = view.pulses?.[i];
        if (p) {
          u.value.set(p.start, p.speed, p.strength, p.sharpness);
          o.value.copy(p.origin);
        } else {
          u.value.z = 0;
        }
      });
      const h = renderer.getDrawingBufferSize(_size).y;
      dustMaterial.uniforms.uPxPerUnit.value = camera.isOrthographicCamera
        ? h / ((camera.top - camera.bottom) / camera.zoom)
        : h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
      fx.uniforms.uTime.value = time;
    },
    setSize(w, h) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
      fx.uniforms.uResolution.value.set(w, h);
    },
    render(camera) {
      renderPass.camera = camera;
      composer.render();
    },
  };
}
