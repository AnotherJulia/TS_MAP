import * as THREE from "three";

// "Netspace" look for the instanced box mesh: dim translucent-looking fill, glowing edges,
// and a faint 1-unit grid (TaleSpire's movement grid) on top faces. Edges are found per
// fragment from the box-local position and the instance's scale, so edge width stays
// even on non-cubic boxes; fwidth() keeps lines anti-aliased at any zoom. Supports the
// renderer's clipping planes (the cut box) like the built-in materials.
export function createNetspaceMaterial() {
  return new THREE.ShaderMaterial({
    clipping: true,
    uniforms: {
      uEdgeWidth: { value: 0.035 }, // world units
      uFill: { value: 0.1 },
      uGrid: { value: 0.35 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <clipping_planes_pars_vertex>
      varying vec3 vLocal;
      varying vec3 vSize;
      varying vec3 vTint;
      varying vec3 vWorld;
      void main() {
        vLocal = position;
        vSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        #ifdef USE_INSTANCING_COLOR
          vTint = instanceColor;
        #else
          vTint = vec3(1.0);
        #endif
        vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = worldPos.xyz;
        vec4 mvPosition = viewMatrix * worldPos;
        gl_Position = projectionMatrix * mvPosition;
        #include <clipping_planes_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <clipping_planes_pars_fragment>
      uniform float uEdgeWidth;
      uniform float uFill;
      uniform float uGrid;
      varying vec3 vLocal;
      varying vec3 vSize;
      varying vec3 vTint;
      varying vec3 vWorld;
      void main() {
        #include <clipping_planes_fragment>
        // Distance (world units) to each pair of opposite faces. On a face, one of these is
        // ~0; the fragment is on an edge when the second-smallest is also small.
        vec3 d = (0.5 - abs(vLocal)) * vSize;
        float mn = min(d.x, min(d.y, d.z));
        float mx = max(d.x, max(d.y, d.z));
        float mid = d.x + d.y + d.z - mn - mx;
        float aa = fwidth(mid) * 1.5;
        float edge = 1.0 - smoothstep(uEdgeWidth, uEdgeWidth + aa, mid);

        // Movement grid on horizontal faces.
        float isTop = step(0.4999, abs(vLocal.y));
        vec2 g = abs(fract(vWorld.xz) - 0.5);
        float toLine = 0.5 - max(g.x, g.y);
        float gaa = fwidth(toLine) * 1.5;
        float grid = isTop * (1.0 - smoothstep(0.012, 0.012 + gaa, toLine)) * uGrid;

        // Slightly brighter tops so floors read as walkable planes.
        float fill = uFill * (1.0 + isTop * 0.8);
        gl_FragColor = vec4(vTint * (fill + grid + edge * 1.8), 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}
