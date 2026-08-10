import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";

const dist = new URL("../client/dist", import.meta.url).pathname;
const manifestPath = join(dist, ".vite", "manifest.json");
const webglLimit = 400 * 1024;
const transferLimit = 1.5 * 1024 * 1024;
if (!existsSync(manifestPath)) throw new Error("Vite manifest missing; run the production build first.");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const entries = Object.entries(manifest);
const entry = entries.find(([, item]) => item.isEntry);
if (!entry) throw new Error("No Vite entry chunk found.");
const loaded = new Set();
function include(item) { if (!item || loaded.has(item.file)) return; loaded.add(item.file); for (const dependency of item.imports ?? []) include(manifest[dependency]); }
include(entry[1]);
const webgl = entries.find(([key, item]) => /WebGLRenderer/i.test(`${key} ${item.name ?? ""} ${item.file}`));
if (!webgl) throw new Error("WebGL renderer chunk missing from the production graph.");
include(webgl[1]);
const runtime = [...loaded].filter(file => file.endsWith(".js")).map(file => ({ file, raw: statSync(join(dist, file)).size, gzip: gzipSync(readFileSync(join(dist, file))).length }));
const runtimeRaw = runtime.reduce((sum, item) => sum + item.raw, 0);
const runtimeGzip = runtime.reduce((sum, item) => sum + item.gzip, 0);
function files(path) { return readdirSync(path, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(join(path, item.name)) : [join(path, item.name)]); }
const emitted = files(dist).filter(file => !file.endsWith("manifest.json"));
const totalRaw = emitted.reduce((sum, file) => sum + statSync(file).size, 0);
const totalTransfer = emitted.reduce((sum, file) => sum + gzipSync(readFileSync(file)).length, 0);
console.log(`Loaded WebGL JS: ${runtimeRaw} bytes raw / ${runtimeGzip} bytes gzip (${runtime.map(item => basename(item.file)).join(", ")})`);
console.log(`Total emitted client: ${totalRaw} bytes raw / ${totalTransfer} bytes gzip transfer`);
console.log(`Limits: WebGL path ${webglLimit} bytes gzip; total transfer ${transferLimit} bytes gzip`);
if (runtimeGzip > webglLimit || totalTransfer > transferLimit) process.exit(1);
