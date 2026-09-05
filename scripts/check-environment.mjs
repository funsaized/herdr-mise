import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

export function dependencyDrift(
  root,
  read = (path) => JSON.parse(readFileSync(path, "utf8")),
) {
  const errors = [];
  for (const project of [".", "client"]) {
    const directory = resolve(root, project);
    const manifest = read(resolve(directory, "package.json"));
    const lock = read(resolve(directory, "package-lock.json"));
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })) {
      const expected = lock.packages?.[`node_modules/${name}`]?.version;
      let installed;
      try {
        installed = read(
          resolve(directory, "node_modules", name, "package.json"),
        ).version;
      } catch {
        /* missing installation */
      }
      if (!expected || installed !== expected)
        errors.push(
          `${project}: ${name} installed ${installed ?? "missing"}, locked ${expected ?? "missing"}; run npm ci${project === "client" ? " --prefix client" : ""}`,
        );
    }
  }
  return errors;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const errors = dependencyDrift(root);
  if (Number(process.versions.node.split(".")[0]) < 22)
    errors.push("Node 22 or newer is required; managed CI uses Node 22.");
  const rustVersion = readFileSync(
    resolve(root, "rust-toolchain.toml"),
    "utf8",
  ).match(/channel\s*=\s*"([^"]+)"/)?.[1];
  for (const [command, expected] of [
    ["rustc", rustVersion],
    [
      "swamp",
      readFileSync(resolve(root, ".swamp.yaml"), "utf8").match(
        /^swampVersion:\s*(\S+)/m,
      )?.[1],
    ],
    [
      process.env.DENO_EXEC_PATH ?? resolve(homedir(), ".swamp/deno/deno"),
      "deno 2.",
    ],
  ]) {
    const result = spawnSync(command, ["--version"], { encoding: "utf8" });
    const version = result.stdout?.trim() ?? "";
    console.log(version || `${command}: unavailable`);
    if (result.status !== 0 || !expected || !version.includes(expected))
      errors.push(
        `${command}: expected ${expected}; install the repository-pinned version.`,
      );
  }
  console.log(`node ${process.versions.node}`);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else
    console.log("Environment and direct dependencies match the repository.");
}
