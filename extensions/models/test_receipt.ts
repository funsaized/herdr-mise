/** Source-bound execution evidence; test relevance remains an independent review. */
export type TestReporter =
  | "node-tap"
  | "vitest-json"
  | "playwright-json"
  | "rust-libtest";

export function testCounts(output: string, reporter: TestReporter) {
  let passed: number;
  let failed: number;
  let skipped: number;
  if (reporter === "rust-libtest") {
    const summaries = [
      ...output.matchAll(
        /^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in .+$/gm,
      ),
    ];
    if (summaries.length !== 1 || summaries[0][1] !== "ok")
      throw new Error("Expected one successful Rust libtest summary");
    passed = Number(summaries[0][2]);
    failed = Number(summaries[0][3]);
    skipped = Number(summaries[0][4]);
    if (Number(summaries[0][5]) !== 0)
      throw new Error("Benchmarks are not test proof");
  } else if (reporter === "node-tap") {
    const count = (name: string) => {
      const matches = [
        ...output.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, "gm")),
      ];
      if (matches.length !== 1)
        throw new Error(`Expected one TAP ${name} summary`);
      return Number(matches[0][1]);
    };
    passed = count("pass");
    failed = count("fail") + count("cancelled");
    skipped = count("skipped") + count("todo");
    if (count("tests") !== passed + failed + skipped)
      throw new Error("Inconsistent TAP totals");
  } else {
    // npm may prepend its script banner; require one complete JSON suffix.
    let report: Record<string, unknown> | undefined;
    for (const match of output.matchAll(/^\{/gm)) {
      try {
        report = JSON.parse(output.slice(match.index));
        break;
      } catch {
        /* Not the reporter object. */
      }
    }
    if (!report) throw new Error("Missing complete JSON test report");
    if (reporter === "vitest-json") {
      passed = Number(report.numPassedTests);
      failed = Number(report.numFailedTests);
      skipped =
        Number(report.numPendingTests) + Number(report.numTodoTests ?? 0);
      if (
        report.success !== true ||
        Number(report.numTotalTests) !== passed + failed + skipped
      )
        throw new Error("Unsuccessful or inconsistent Vitest report");
    } else {
      const stats = report.stats as Record<string, unknown> | undefined;
      if (!stats || (Array.isArray(report.errors) && report.errors.length))
        throw new Error("Missing Playwright statistics or global errors");
      passed = Number(stats.expected);
      failed = Number(stats.unexpected) + Number(stats.flaky);
      skipped = Number(stats.skipped);
    }
  }
  if (
    ![passed, failed, skipped].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    throw new Error("Invalid test counts");
  if (passed === 0 || failed !== 0)
    throw new Error(
      "Test receipt requires at least one passed test and no failures",
    );
  return { selected: passed + failed, passed, failed, skipped };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as BufferSource),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sourceDigest(
  root: string,
  signal?: AbortSignal,
): Promise<string> {
  const output = await new Deno.Command("git", {
    args: [
      "-c",
      "core.fsmonitor=false",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    cwd: root,
    signal,
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).output();
  if (!output.success) throw new Error("Cannot enumerate test subject source");
  const paths = [
    ...new Set(
      new TextDecoder("utf-8", { fatal: true })
        .decode(output.stdout)
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  const entries: unknown[] = [];
  for (const path of paths) {
    if (path.startsWith("/") || path.split("/").includes(".."))
      throw new Error("Unsafe source path");
    // Never follow a symlink in an ancestor into another checkout or the host.
    for (const parent of path
      .split("/")
      .slice(0, -1)
      .map((_part, index, parts) => parts.slice(0, index + 1).join("/"))) {
      try {
        if ((await Deno.lstat(`${root}/${parent}`)).isSymlink)
          throw new Error("Source ancestor is a symlink");
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    try {
      const info = await Deno.lstat(`${root}/${path}`);
      if (info.isSymlink)
        entries.push([path, "symlink", await Deno.readLink(`${root}/${path}`)]);
      else if (info.isFile)
        entries.push([
          path,
          "file",
          (info.mode ?? 0) & 0o111,
          await sha256(await Deno.readFile(`${root}/${path}`)),
        ]);
      else throw new Error(`Unsupported source entry: ${path}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      entries.push([path, "deleted"]);
    }
  }
  return sha256(new TextEncoder().encode(JSON.stringify(entries)));
}
