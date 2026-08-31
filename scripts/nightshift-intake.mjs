import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const inputPath = process.argv[2];
if (!inputPath) throw new Error("usage: nightshift-intake.mjs <features.json>");
if (!process.env.SWAMP_SERVE_URL)
  throw new Error("SWAMP_SERVE_URL is required");
if (!process.env.SWAMP_SERVER_TOKEN)
  throw new Error("SWAMP_SERVER_TOKEN is required");

const features = JSON.parse(await readFile(inputPath, "utf8"));
if (!Array.isArray(features) || features.length === 0) {
  throw new Error("features file must contain a non-empty array");
}

function swamp(args, input) {
  return spawnSync(
    "swamp",
    [
      ...args,
      "--server",
      process.env.SWAMP_SERVE_URL,
      "--token",
      process.env.SWAMP_SERVER_TOKEN,
      "--json",
    ],
    {
      encoding: "utf8",
      env: process.env,
      input,
    },
  );
}

function diagnostics(workflow) {
  const report = swamp([
    "report",
    "get",
    "@swamp/workflow-summary",
    "--workflow",
    workflow,
  ]);
  return `${report.stdout}\n${report.stderr}`.trim();
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const backoff = [250, 500, 1000, 2000];

for (const feature of features) {
  let completed = false;
  for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
    const result = swamp(
      ["workflow", "run", "nightshift-create-intake", "--stdin"],
      JSON.stringify(feature),
    );
    if (result.status === 0) {
      process.stdout.write(result.stdout);
      completed = true;
      break;
    }

    const report = diagnostics("nightshift-create-intake");
    const failure = `${result.stdout}\n${result.stderr}\n${report}`;
    const lockTimeout =
      /lock.{0,80}(?:timed out|timeout)|(?:timed out|timeout).{0,80}lock/is.test(
        failure,
      );
    if (!lockTimeout || attempt === backoff.length) {
      throw new Error(failure.trim());
    }

    await delay(backoff[attempt]);
  }
  if (!completed)
    throw new Error(`intake failed for ${feature.idempotencyKey}`);
}
