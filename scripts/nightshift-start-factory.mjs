// Create and start the runtime factory for each GitHub issue number given,
// or explicitly restore one factory's lifecycle definition from the template:
//   node scripts/nightshift-start-factory.mjs 287 [288 ...]
//   node scripts/nightshift-start-factory.mjs --repair 287
// Runs against the local repository, or against `swamp serve` when
// SWAMP_SERVE_URL and SWAMP_SERVER_TOKEN are set (as the intake client does).
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  repairFactoryInstance,
  startFactoryInstance,
} from "./lib/factory-instance.mjs";
import { parseLastJson } from "./lib/swamp-test-process.mjs";

export function swampCli(env = process.env) {
  const remote = env.SWAMP_SERVE_URL
    ? [
        "--server",
        env.SWAMP_SERVE_URL,
        ...(env.SWAMP_SERVER_TOKEN ? ["--token", env.SWAMP_SERVER_TOKEN] : []),
      ]
    : [];
  return (args, input) => {
    const result = spawnSync(
      "swamp",
      [...args, ...remote, "--json", "--no-color"],
      {
        encoding: "utf8",
        env,
        input,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    let json;
    try {
      json = parseLastJson(
        result.status === 0 ? result.stdout : result.stderr || result.stdout,
      );
    } catch {
      json = undefined;
    }
    return {
      status: result.status,
      json,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repair = process.argv[2] === "--repair";
  const items = process.argv.slice(repair ? 3 : 2);
  if (!items.length)
    throw new Error(
      "usage: nightshift-start-factory.mjs [--repair] <workItem>...",
    );
  const swamp = swampCli();
  for (const workItem of items)
    console.log(
      JSON.stringify(
        repair
          ? repairFactoryInstance(swamp, { workItem })
          : startFactoryInstance(swamp, { workItem }),
      ),
    );
}
