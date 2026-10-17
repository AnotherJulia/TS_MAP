// Compiles every /* glsl */ block in viewer/js with glslangValidator, wrapped roughly the way
// three.js wraps ShaderMaterial source for WebGL2 (GLSL ES 3.00). Catches what a browser
// would only report as a silent black screen, e.g. a variable named like a reserved word.
//   node viewer/tools/check-shaders.mjs        (needs: brew install glslang)
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const jsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "js");
const tmp = mkdtempSync(join(tmpdir(), "glsl-"));

const vertexPrefix = `#version 300 es
precision highp float;
uniform mat4 modelMatrix; uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix; uniform mat4 viewMatrix;
in vec3 position; in vec2 uv; in mat4 instanceMatrix; in vec3 instanceColor;
#define attribute in
#define varying out
#define USE_INSTANCING_COLOR
`;
const fragmentPrefix = `#version 300 es
precision highp float;
#define varying in
out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
#define texture2D texture
`;

let failures = 0;
let count = 0;
for (const file of readdirSync(jsDir).filter((f) => f.endsWith(".js"))) {
  const src = readFileSync(join(jsDir, file), "utf8");
  // Shared snippets (`const NAME = /* glsl */ \`...\``) get substituted for ${NAME}, as in the
  // real template strings; only complete shaders (with a main) are compiled.
  const snippets = new Map([...src.matchAll(/const (\w+) = \/\* glsl \*\/ `([\s\S]*?)`/g)].map((m) => [m[1], m[2]]));
  for (const m of src.matchAll(/\/\* glsl \*\/ `([\s\S]*?)`/g)) {
    if (!/void main/.test(m[1])) continue;
    const body = m[1]
      .replace(/\$\{(\w+)\}/g, (_, name) => snippets.get(name) ?? "")
      .replace(/^\s*#include <[^>]+>\s*$/gm, "");
    const isVertex = /gl_Position/.test(body);
    const path = join(tmp, `${file}-${count++}.${isVertex ? "vert" : "frag"}`);
    writeFileSync(path, (isVertex ? vertexPrefix : fragmentPrefix) + body);
    try {
      execFileSync("glslangValidator", [path], { stdio: "pipe" });
      console.log(`ok    ${file} #${count} (${isVertex ? "vertex" : "fragment"})`);
    } catch (err) {
      failures++;
      console.log(`FAIL  ${file} #${count} (${isVertex ? "vertex" : "fragment"})\n${err.stdout}`);
    }
  }
}
process.exit(failures ? 1 : 0);
