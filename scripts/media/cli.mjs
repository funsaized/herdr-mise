import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCommittedSource } from "./capture-media.mjs";

export const USAGE = `Usage: npm run media -- capture web|tui|hero|product|tui-states [--force] [--connect-herdr]
       npm run media -- check tui|product|all

Capture requires clean committed source and the tools documented in docs/product-demo.md.
Checks validate existing media without changing it. Run npm run test:media for all media tests.`;

export async function runMedia(args, root = resolve(".")) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log(USAGE);
    return;
  }
  const [action, profile, ...options] = args;
  if (
    action === "capture" &&
    profile === "tui-states" &&
    options.every((value) => ["--force", "--connect-herdr"].includes(value))
  ) {
    verifyCommittedSource(root);
    const child = spawn(
      "bash",
      [
        fileURLToPath(new URL("./capture-tui-states.sh", import.meta.url)),
        ...options,
      ],
      { cwd: root, stdio: "inherit" },
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => child.kill(signal));
    await new Promise((ok, fail) => {
      child.on("error", fail);
      child.on("exit", (code, signal) =>
        code === 0
          ? ok()
          : fail(new Error(`TUI state capture exited ${code ?? signal}`)),
      );
    });
    return;
  }
  if (options.length) throw new Error(USAGE);
  if (action === "capture") {
    const captures = {
      web: ["./capture-readme-media.mjs", "captureWeb"],
      tui: ["./capture-tui-media.mjs", "captureTui"],
      hero: ["./capture-hero-media.mjs", "captureHero"],
      product: ["./capture-product-media.mjs", "captureProduct"],
    };
    if (!Object.hasOwn(captures, profile)) throw new Error(USAGE);
    const commit = verifyCommittedSource(root);
    const [module, method] = captures[profile];
    const capture = (await import(module))[method];
    if (profile === "product") await capture(root, commit);
    else await capture(root);
    console.log(`Captured ${profile} media`);
  } else if (
    action === "check" &&
    ["tui", "product", "all"].includes(profile)
  ) {
    for (const selected of profile === "all" ? ["tui", "product"] : [profile]) {
      const { validateTuiMedia } = await import("./check-tui-media.mjs");
      const { validateProductMedia } =
        await import("./check-product-media.mjs");
      const metadata = JSON.parse(
        await readFile(
          resolve(root, `scripts/media/${selected}-demo.capture.json`),
          "utf8",
        ),
      );
      await (selected === "tui" ? validateTuiMedia : validateProductMedia)(
        root,
        metadata,
      );
      console.log(`Validated ${selected} media`);
    }
  } else throw new Error(USAGE);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await runMedia(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.message === USAGE ? 64 : 1;
  }
}
