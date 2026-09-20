import { verifyLocalRuntime } from "./lib/swamp-local-runtime.mjs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pin = JSON.parse(
  await readFile(join(root, "verification/swamp-local-runtime.json"), "utf8"),
);
if (process.platform !== "darwin")
  throw new Error(
    "Local pinned Swamp launcher supports macOS only; managed CI uses its own bootstrap",
  );
const arch = { arm64: "aarch64", x64: "x86_64" }[process.arch];
const asset = pin.assets[arch];
if (!asset) throw new Error("Unsupported local runtime architecture");
const config = await readFile(join(root, ".swamp.yaml"), "utf8");
if (!config.split(/\r?\n/).includes(`swampVersion: ${pin.version}`))
  throw new Error("Local runtime pin disagrees with .swamp.yaml");
const binary = join(
  await realpath(root),
  ".tools/swamp",
  pin.version,
  arch,
  "swamp",
);
try {
  await verifyLocalRuntime(binary, asset);
} catch (error) {
  throw new Error(
    "Pinned runtime is missing or invalid. Run: swamp model method run nightshift-github install_local_swamp",
    { cause: error },
  );
}
const [command = "swamp", ...args] = process.argv.slice(2);
const child = spawn(command, args, {
  stdio: "inherit",
  detached: true,
  env: {
    ...process.env,
    PATH: `${dirname(binary)}${delimiter}${process.env.PATH ?? ""}`,
  },
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode =
    code ??
    (signal ? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal] ?? 1) : 1);
});
