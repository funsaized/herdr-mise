import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
const root = new URL("..", import.meta.url).pathname;
const source = join(root, "client", "src");
const tokenFile = join(source, "theme", "tokens.ts");
const files = [];
function visit(path) {
  for (const name of readdirSync(path)) {
    const item = join(path, name);
    if (statSync(item).isDirectory()) visit(item);
    else if (/\.(css|ts|tsx)$/.test(name)) files.push(item);
  }
}
visit(source);
const containsHex = (source) => /#[0-9a-fA-F]{3,8}\b/.test(source);
if (!["#abc", "#def"].every(containsHex))
  throw new Error(
    "Token audit self-test failed: every input must be checked independently",
  );
const failures = files
  .filter(
    (file) => file !== tokenFile && containsHex(readFileSync(file, "utf8")),
  )
  .map((file) => relative(root, file));
const tokens = readFileSync(tokenFile, "utf8");
const serviceRed = "#d8342c";
const redCount = tokens.split(serviceRed).length - 1;
if (!tokens.includes(`blocked: "${serviceRed}"`) || redCount !== 1)
  failures.push("service red must occur exactly once as semantic.blocked");
if (failures.length) {
  console.error("Token audit failed:\n" + failures.join("\n"));
  process.exit(1);
}
console.log(
  `Token audit passed (${files.length} source files; service red is blocked-only).`,
);
