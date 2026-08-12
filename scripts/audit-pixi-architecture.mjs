import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const source = join(root, "client", "src");
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory()
      ? files(join(path, item.name))
      : /\.(ts|tsx)$/.test(item.name)
        ? [join(path, item.name)]
        : [],
  );
}
const forbidden = [
  /node_modules\/pixi\.js/,
  /\bWebGL2?RenderingContext\b/,
  /\b(?:createProgram|createShader|shaderSource|compileShader|linkProgram)\s*\(/,
  /extends\s+AbstractRenderer/,
  /class\s+\w*(?:PixelRenderer|FoundationWebGLRenderer|RenderPipe)\w*/,
  /new\s+PixelRenderer/,
];
const failures = [];
for (const file of files(source)) {
  const text = readFileSync(file, "utf8");
  for (const pattern of forbidden)
    if (pattern.test(text))
      failures.push(`${relative(root, file)} matches ${pattern}`);
}
const kitchen = readFileSync(join(source, "scene", "kitchen-scene.ts"), "utf8");
for (const required of [
  /from\s+"pixi\.js"/,
  /new\s+Application\s*\(/,
  /new\s+Container\s*\(/,
  /new\s+Graphics\s*\(/,
  /new\s+Text\s*\(/,
  /skipExtensionImports:\s*true/,
])
  if (!required.test(kitchen))
    failures.push(`kitchen-scene.ts missing ${required}`);
if (failures.length) {
  console.error(`Pixi architecture audit failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(
  `Pixi architecture audit passed (${files(source).length} TypeScript source files; package imports and native scene classes only).`,
);
