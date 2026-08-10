import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const output = process.argv[2];
if (!output) throw new Error("usage: node scripts/generate-third-party-notices.mjs <output>");

const licensePattern = /^(LICENSE|LICENCE|COPYING|NOTICE)([._-].*)?$/i;
const fallbackLicenseFiles = new Map([
  ["@pixi/colord@2.9.6", "third_party/licenses/colord-LICENSE.md"],
]);
const normalizeRepository = repository => typeof repository === "string" ? repository : repository?.url ?? "";

function licenseFiles(directory) {
  return readdirSync(directory)
    .filter(name => licensePattern.test(name))
    .filter(name => statSync(join(directory, name)).isFile())
    .sort();
}

function section(kind, dependency, directory) {
  const files = licenseFiles(directory);
  const fallback = fallbackLicenseFiles.get(`${dependency.name}@${dependency.version}`);
  const source = normalizeRepository(dependency.repository);
  const header = [
    `${dependency.name} ${dependency.version}`,
    `Declared license: ${dependency.license ?? "unspecified"}`,
    source ? `Source: ${source}` : null,
  ].filter(Boolean).join("\n");
  const texts = files.length > 0
    ? files.map(name => `--- ${name} ---\n${readFileSync(join(directory, name), "utf8").trim()}`).join("\n\n")
    : fallback
      ? `--- ${fallback} ---\n${readFileSync(fallback, "utf8").trim()}`
      : null;
  if (!texts) throw new Error(`missing license text for ${dependency.name}@${dependency.version}`);
  return `### ${kind}: ${header}\n\n${texts}`;
}

const releaseTargets = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
];
const runtimePackages = new Map();
for (const target of releaseTargets) {
  const cargo = JSON.parse(execFileSync("cargo", [
    "metadata", "--format-version", "1", "--locked", "--filter-platform", target,
  ], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  }));
  const packages = new Map(cargo.packages.map(dependency => [dependency.id, dependency]));
  const nodes = new Map(cargo.resolve.nodes.map(node => [node.id, node]));
  const visited = new Set();
  const queue = [...cargo.workspace_members];
  while (queue.length > 0) {
    const id = queue.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    const dependency = packages.get(id);
    if (dependency?.source) runtimePackages.set(id, dependency);
    const node = nodes.get(id);
    if (!node) continue;
    for (const edge of node.deps) {
      if (edge.dep_kinds.some(({ kind }) => kind === null)) queue.push(edge.pkg);
    }
  }
}
const rust = [...runtimePackages.values()]
  .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
  .map(dependency => section("Rust dependency", dependency, dirname(dependency.manifest_path)));

const clientRoot = resolve("client");
const npmPaths = execFileSync("npm", ["ls", "--prefix", "client", "--omit=dev", "--all", "--parseable"], {
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
}).trim().split("\n").filter(path => path && resolve(path) !== clientRoot);
const javascript = npmPaths.map(directory => {
  const manifest = join(directory, "package.json");
  if (!existsSync(manifest)) throw new Error(`missing package manifest: ${manifest}`);
  return { dependency: JSON.parse(readFileSync(manifest, "utf8")), directory };
}).sort((a, b) => `${a.dependency.name}@${a.dependency.version}`.localeCompare(`${b.dependency.name}@${b.dependency.version}`))
  .map(({ dependency, directory }) => section("JavaScript dependency", dependency, directory));

const fonts = [
  ["Instrument Sans", "client/public/fonts/OFL-Instrument-Sans.txt"],
  ["Silkscreen", "client/public/fonts/OFL-Silkscreen.txt"],
].map(([name, path]) => `### Font: ${name}\n\n${readFileSync(path, "utf8").trim()}`);

const notices = [
  "THIRD-PARTY NOTICES",
  "",
  "This distribution includes third-party Rust, JavaScript, and font software.",
  "The notices below were generated from the locked production dependency trees.",
  "",
  "## Rust dependencies",
  "",
  ...rust,
  "",
  "## JavaScript dependencies",
  "",
  ...javascript,
  "",
  "## Bundled fonts",
  "",
  ...fonts,
  "",
].join("\n\n");

writeFileSync(output, notices);
console.log(`wrote ${output} (${rust.length} Rust, ${javascript.length} JavaScript, ${fonts.length} font notices)`);
