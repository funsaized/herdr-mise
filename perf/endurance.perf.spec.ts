import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { isAbsolute, join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { startFixtureApp } from "../e2e/fixture-app";

const durationMinutes = Number(
    process.env.HERDR_MISE_ENDURANCE_DURATION_MINUTES ?? "480",
  ),
  injectLeak = process.env.HERDR_MISE_ENDURANCE_INJECT_LEAK === "1",
  allDayEvidence =
    process.env.HERDR_MISE_ENDURANCE_DURATION_MINUTES === undefined &&
    !injectLeak,
  baselinePath = process.env.HERDR_MISE_ENDURANCE_BASELINE,
  scenarios = [
    { agents: 30, clients: 1 },
    { agents: 30, clients: 3 },
    { agents: 60, clients: 1 },
    { agents: 60, clients: 3 },
  ] as const,
  statuses = [
    "PREP",
    "FIRE",
    "AT THE PASS",
    "BLOCKED AT STATION",
    "PLATED",
    "86'D",
    "WORK RESUMED",
    "UNKNOWN · PREP",
  ];

if (!Number.isFinite(durationMinutes) || durationMinutes <= 0)
  throw new Error("HERDR_MISE_ENDURANCE_DURATION_MINUTES must be positive");
if (baselinePath && !isAbsolute(baselinePath))
  throw new Error("HERDR_MISE_ENDURANCE_BASELINE must be an absolute path");

type HerdrSnapshot = {
  version: string;
  protocol: number;
  workspaces: unknown[];
  tabs: unknown[];
  panes: unknown[];
  layouts: unknown[];
  agents: Record<string, unknown>[];
};
type Sample = {
  elapsedMs: number;
  completedSessions: number;
  reconnects: number;
  server: {
    rssKiB: number | null;
    cpuPercent: number | null;
    limitation?: "permission-denied" | "unavailable";
  };
  clients: Array<{
    visibility: string;
    heapBytes: number;
    nodes: number;
    documents: number;
    listeners: number;
    taskDuration: number;
    layoutDuration: number;
    scriptDuration: number;
    websocketBytes: number;
    scene: {
      stations: number;
      disposals: number;
      particles: number;
      drawCalls: number;
      rafCount: number;
      endedEntries: number;
    };
  }>;
};
type Trend = {
  slope: number | null;
  r2: number | null;
  proportionalGrowth: boolean;
};
type ScenarioSummary = {
  agents: number;
  clients: number;
  elapsedMs: number;
  completedSessions: number;
  reconnects: number;
  trends: {
    heapByCompleted: Trend;
    nodesByCompleted: Trend;
    documentsByCompleted: Trend;
    listenersByCompleted: Trend;
    rssByCompleted: Trend;
    heapByReconnect: Trend;
    nodesByReconnect: Trend;
    documentsByReconnect: Trend;
    listenersByReconnect: Trend;
    rssByReconnect: Trend;
  };
};

function roster(
  source: HerdrSnapshot,
  count: number,
  generation: number,
): HerdrSnapshot {
  const template = source.agents[0]!;
  return {
    ...source,
    agents: Array.from({ length: count }, (_, index) => ({
      ...template,
      terminal_id: `endurance-${generation}-${index}`,
      pane_id: `endurance-pane-${generation}-${index}`,
      display_agent: `cook-${generation}-${index}`,
      agent_status:
        index % 7 === 0 ? "blocked" : index % 3 ? "working" : "idle",
      state_change_seq: generation * count + index + 1,
      agent_session: { value: `endurance-session-${generation}-${index}` },
    })),
  };
}

function churn(snapshot: HerdrSnapshot, generation: number): HerdrSnapshot {
  const agents = [...snapshot.agents],
    replacements = Math.max(1, Math.floor(agents.length / 10)),
    start = ((generation - 1) * replacements) % agents.length;
  for (let offset = 0; offset < replacements; offset++) {
    const index = (start + offset) % agents.length,
      previous = agents[index]!;
    agents[index] = {
      ...previous,
      terminal_id: `endurance-${generation}-${index}`,
      pane_id: `endurance-pane-${generation}-${index}`,
      display_agent: `cook-${generation}-${index}`,
      state_change_seq: generation * agents.length + index + 1,
      agent_session: { value: `endurance-session-${generation}-${index}` },
    };
  }
  return { ...snapshot, agents };
}

function slope(
  samples: Sample[],
  x: (sample: Sample) => number,
  y: (sample: Sample) => number | null,
): Trend {
  const points = samples
    .map((sample) => [x(sample), y(sample)] as const)
    .filter((point): point is readonly [number, number] => point[1] !== null);
  if (points.length === 0)
    return { slope: null, r2: null, proportionalGrowth: false };
  const xMean =
      points.reduce((sum, point) => sum + point[0], 0) / points.length,
    yMean = points.reduce((sum, point) => sum + point[1], 0) / points.length,
    denominator = points.reduce(
      (sum, point) => sum + (point[0] - xMean) ** 2,
      0,
    ),
    value = denominator
      ? points.reduce(
          (sum, point) => sum + (point[0] - xMean) * (point[1] - yMean),
          0,
        ) / denominator
      : 0,
    total = points.reduce((sum, point) => sum + (point[1] - yMean) ** 2, 0),
    residual = points.reduce(
      (sum, point) =>
        sum + (point[1] - (yMean + value * (point[0] - xMean))) ** 2,
      0,
    ),
    r2 = total ? Math.max(0, 1 - residual / total) : 0;
  return { slope: value, r2, proportionalGrowth: value > 0 && r2 >= 0.8 };
}

function summarize(
  scenario: (typeof scenarios)[number],
  elapsedMs: number,
  samples: Sample[],
): ScenarioSummary {
  const heap = (sample: Sample) =>
      sample.clients.reduce((sum, client) => sum + client.heapBytes, 0) /
      sample.clients.length,
    nodes = (sample: Sample) =>
      sample.clients.reduce((sum, client) => sum + client.nodes, 0) /
      sample.clients.length,
    documents = (sample: Sample) =>
      sample.clients.reduce((sum, client) => sum + client.documents, 0) /
      sample.clients.length,
    listeners = (sample: Sample) =>
      sample.clients.reduce((sum, client) => sum + client.listeners, 0) /
      sample.clients.length,
    completed = (sample: Sample) => sample.completedSessions,
    reconnects = (sample: Sample) => sample.reconnects,
    rss = (sample: Sample) => sample.server.rssKiB,
    last = samples.at(-1)!;
  return {
    ...scenario,
    elapsedMs,
    completedSessions: last.completedSessions,
    reconnects: last.reconnects,
    trends: {
      heapByCompleted: slope(samples, completed, heap),
      nodesByCompleted: slope(samples, completed, nodes),
      documentsByCompleted: slope(samples, completed, documents),
      listenersByCompleted: slope(samples, completed, listeners),
      rssByCompleted: slope(samples, completed, rss),
      heapByReconnect: slope(samples, reconnects, heap),
      nodesByReconnect: slope(samples, reconnects, nodes),
      documentsByReconnect: slope(samples, reconnects, documents),
      listenersByReconnect: slope(samples, reconnects, listeners),
      rssByReconnect: slope(samples, reconnects, rss),
    },
  };
}

async function environment(browser: Browser, binary: Buffer) {
  const session = await browser.newBrowserCDPSession(),
    info = await session.send("SystemInfo.getInfo"),
    cpu = cpus()[0];
  await session.detach();
  return {
    gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    binarySha256: createHash("sha256").update(binary).digest("hex"),
    os: { platform: platform(), release: release(), architecture: arch() },
    cpu: { model: cpu?.model ?? "unknown", logicalCores: cpus().length },
    memoryBytes: totalmem(),
    chromium: browser.version(),
    playwright: JSON.parse(
      await readFile(
        join(process.cwd(), "node_modules/@playwright/test/package.json"),
        "utf8",
      ),
    ).version as string,
    graphics: {
      devices: info.gpu.devices.map((device) => ({
        vendorId: device.vendorId,
        deviceId: device.deviceId,
        vendor: device.vendorString,
        device: device.deviceString,
      })),
      renderer: info.gpu.auxAttributes.glRenderer,
      vendor: info.gpu.auxAttributes.glVendor,
    },
  };
}

async function processSample(pid: number): Promise<Sample["server"]> {
  try {
    const output = execFileSync("ps", ["-o", "rss=,%cpu=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim(),
      [rssKiB, cpuPercent] = output.split(/\s+/).map(Number);
    if (!Number.isFinite(rssKiB) || !Number.isFinite(cpuPercent))
      return { rssKiB: null, cpuPercent: null, limitation: "unavailable" };
    return { rssKiB: rssKiB!, cpuPercent: cpuPercent! };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    return {
      rssKiB: null,
      cpuPercent: null,
      limitation:
        code === "EPERM" || code === "EACCES"
          ? "permission-denied"
          : "unavailable",
    } as const;
  }
}

async function assertScene(page: Page, expectedIds: string[]) {
  const stationControls = page
      .getByRole("navigation", { name: "Agent stations" })
      .locator("button[data-agent-id]"),
    sortedExpectedIds = [...expectedIds].sort();
  await expect
    .poll(
      () =>
        stationControls.evaluateAll(
          (buttons, ids) =>
            ids.every((id) =>
              buttons.some(
                (button) => button.getAttribute("data-agent-id") === id,
              ),
            ),
          expectedIds,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  const metrics = await page.evaluate(() =>
    (
      window as typeof window & {
        __miseSceneMetrics(): {
          drawCalls: number;
          stationDisposals: number;
          rafCount: number;
          endedEntries: number;
          stationCells: Record<
            string,
            { x: number; y: number; width: number; height: number }
          >;
          stationNameBounds: Record<
            string,
            {
              x: number;
              y: number;
              width: number;
              height: number;
              text: string;
            }
          >;
          stationStatusBounds: Record<
            string,
            {
              x: number;
              y: number;
              width: number;
              height: number;
              text: string;
            }
          >;
          stateIndicators: Record<string, number>;
          motion: { activeParticles: number };
        };
      }
    ).__miseSceneMetrics(),
  );
  const entries = Object.entries(metrics.stationCells),
    viewport = page.viewportSize()!;
  expect(entries.every(([id]) => sortedExpectedIds.includes(id))).toBe(true);
  expect(
    Object.values(metrics.stateIndicators).reduce(
      (sum, count) => sum + count,
      0,
    ),
  ).toBe(expectedIds.length);
  for (const [id, cell] of entries) {
    const name = metrics.stationNameBounds[id]!,
      status = metrics.stationStatusBounds[id]!;
    expect(name.text.trim()).not.toBe("");
    expect(statuses.some((value) => status.text.startsWith(value))).toBe(true);
    for (const box of [cell, name, status]) {
      expect(box.x).toBeGreaterThanOrEqual(-3);
      expect(box.y).toBeGreaterThanOrEqual(-3);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 3);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 3);
    }
    for (const box of [name, status]) {
      expect(box.x).toBeGreaterThanOrEqual(cell.x - 3);
      expect(box.y).toBeGreaterThanOrEqual(cell.y - 3);
      expect(box.x + box.width).toBeLessThanOrEqual(cell.x + cell.width + 3);
      expect(box.y + box.height).toBeLessThanOrEqual(cell.y + cell.height + 3);
    }
  }
  for (let first = 0; first < entries.length; first++)
    for (let second = first + 1; second < entries.length; second++) {
      const a = entries[first]![1],
        b = entries[second]![1];
      expect(
        a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y,
      ).toBe(true);
    }
  expect(metrics.endedEntries).toBeLessThanOrEqual(50);
  return metrics;
}

test("eight-hour production-boundary endurance matrix", async ({ browser }) => {
  test.setTimeout(durationMinutes * 60_000 + 300_000);
  const binaryPath = join(process.cwd(), "target/release/herdr-mise"),
    binary = await readFile(binaryPath),
    source = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "server/tests/fixtures/snapshot-herdr-0.8.2-p20.json",
        ),
        "utf8",
      ),
    ) as HerdrSnapshot,
    identity = await environment(browser, binary),
    artifactDirectory = join(process.cwd(), "perf/artifacts"),
    runId = new Date().toISOString().replace(/[:.]/g, "-"),
    samplesFile = join(artifactDirectory, `endurance-${runId}.jsonl`),
    summaryFile = join(artifactDirectory, `endurance-${runId}-summary.json`),
    startedAt = Date.now(),
    targetScenarioMs = (durationMinutes * 60_000) / scenarios.length,
    summaries: ScenarioSummary[] = [],
    evidenceLimitations = new Set<string>();
  await mkdir(artifactDirectory, { recursive: true });
  const record = (value: unknown) =>
    appendFile(
      samplesFile,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...value })}\n`,
    );
  await record({
    type: "run-start",
    durationMinutes,
    allDayEvidence,
    requestedAllDayRun: allDayEvidence,
    injectLeak,
    environment: identity,
  });

  let stage = "scenario-matrix",
    summaryWritten = false;
  try {
    for (const scenario of scenarios) {
      stage = `scenario-${scenario.agents}-${scenario.clients}`;
      let snapshot = roster(source, scenario.agents, 0),
        generation = 0,
        completedSessions = 0,
        reconnects = 0;
      const fixture = await startFixtureApp({
          prefix: "herdr-mise-endurance-",
          snapshot,
          binary: binaryPath,
        }),
        context = await browser.newContext({
          viewport: { width: 1440, height: 1200 },
        }),
        pages: Page[] = [],
        sessions: Awaited<ReturnType<typeof context.newCDPSession>>[] = [],
        websocketBytes: number[] = [],
        scenarioSamples: Sample[] = [],
        scenarioStartedAt = Date.now(),
        sampleInterval = Math.min(60_000, targetScenarioMs / 4);
      try {
        for (let index = 0; index < scenario.clients; index++) {
          const page = await context.newPage(),
            session = await context.newCDPSession(page);
          websocketBytes.push(0);
          session.on("Network.webSocketFrameReceived", ({ response }) => {
            websocketBytes[index] += Buffer.byteLength(response.payloadData);
          });
          await session.send("Network.enable");
          await session.send("Performance.enable");
          await page.goto(`${fixture.appUrl}/?stats`);
          pages.push(page);
          sessions.push(session);
        }
        const cover = await context.newPage();
        await record({
          type: "scenario-start",
          ...scenario,
          targetElapsedMs: targetScenarioMs,
        });

        for (
          let iteration = 0;
          Date.now() - scenarioStartedAt < targetScenarioMs;
          iteration++
        ) {
          const due = scenarioStartedAt + iteration * sampleInterval,
            wait = due - Date.now();
          if (wait > 0) await pages[0]!.waitForTimeout(wait);
          generation++;
          completedSessions += Math.max(1, Math.floor(scenario.agents / 10));
          snapshot = churn(snapshot, generation);
          fixture.setSnapshot(snapshot);

          if (iteration % 2 === 1) {
            await fixture.stopSource();
            await expect(pages[0]!.getByRole("alert")).toBeVisible({
              timeout: 15_000,
            });
            await fixture.startSource();
            reconnects++;
          }

          const scenes = [];
          for (let index = 0; index < pages.length; index++) {
            const page = pages[index]!;
            await page.bringToFront();
            await expect
              .poll(() => page.evaluate(() => document.visibilityState))
              .toBe("visible");
            scenes.push(
              await assertScene(
                page,
                snapshot.agents.map((agent) => String(agent.terminal_id)),
              ),
            );
          }
          const visiblePage =
            iteration % 2 === 0 ? pages[iteration % pages.length]! : cover;
          await visiblePage.bringToFront();
          await expect
            .poll(() => visiblePage.evaluate(() => document.visibilityState))
            .toBe("visible");

          const clientSamples = [];
          for (let index = 0; index < pages.length; index++) {
            const page = pages[index]!,
              session = sessions[index]!,
              scene = scenes[index]!;
            if (injectLeak)
              await page.evaluate((value) => {
                const target = window as typeof window & {
                  __enduranceLeaks?: unknown[];
                };
                target.__enduranceLeaks ??= [];
                const detached = document.createElement("div");
                for (let node = 0; node < 200; node++)
                  detached.append(document.createElement("span"));
                target.__enduranceLeaks.push(
                  detached,
                  new Array(250_000).fill(value),
                );
              }, iteration);
            await session.send("HeapProfiler.collectGarbage");
            const [heap, dom, performance] = await Promise.all([
              session.send("Runtime.getHeapUsage"),
              session.send("Memory.getDOMCounters"),
              session.send("Performance.getMetrics"),
            ]);
            const metric = (name: string) =>
              performance.metrics.find((entry) => entry.name === name)?.value ??
              0;
            clientSamples.push({
              visibility: await page.evaluate(() => document.visibilityState),
              heapBytes: heap.usedSize,
              nodes: dom.nodes,
              documents: dom.documents,
              listeners: dom.jsEventListeners,
              taskDuration: metric("TaskDuration"),
              layoutDuration: metric("LayoutDuration"),
              scriptDuration: metric("ScriptDuration"),
              websocketBytes: websocketBytes[index]!,
              scene: {
                stations: Object.keys(scene.stationCells).length,
                disposals: scene.stationDisposals,
                particles: scene.motion.activeParticles,
                drawCalls: scene.drawCalls,
                rafCount: scene.rafCount,
                endedEntries: scene.endedEntries,
              },
            });
          }
          const sample: Sample = {
            elapsedMs: Date.now() - scenarioStartedAt,
            completedSessions,
            reconnects,
            server: await processSample(fixture.pid),
            clients: clientSamples,
          };
          if (sample.server.limitation)
            evidenceLimitations.add(
              `server-process-sampling-${sample.server.limitation}`,
            );
          scenarioSamples.push(sample);
          await record({ type: "sample", scenario, ...sample });
        }
        const elapsedMs = Date.now() - scenarioStartedAt,
          summary = summarize(scenario, elapsedMs, scenarioSamples);
        summaries.push(summary);
        await record({ type: "scenario-end", ...summary });
      } finally {
        for (const session of sessions) await session.detach();
        await context.close();
        await fixture.close();
      }
    }

    stage = "summary";
    const comparableEnvironment = {
        os: identity.os,
        cpu: identity.cpu,
        memoryBytes: identity.memoryBytes,
        chromium: identity.chromium,
        playwright: identity.playwright,
        graphics: identity.graphics,
      },
      summary = {
        schemaVersion: 1,
        status: "completed",
        allDayEvidence,
        requestedDurationMinutes: durationMinutes,
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date().toISOString(),
        actualElapsedMs: Date.now() - startedAt,
        runIdentity: {
          gitCommit: identity.gitCommit,
          binarySha256: identity.binarySha256,
        },
        environment: comparableEnvironment,
        evidenceLimitations: [...evidenceLimitations],
        scenarios: summaries,
        detectedProportionalGrowth: summaries.some((scenario) =>
          Object.values(scenario.trends).some(
            (trend) => trend.proportionalGrowth,
          ),
        ),
        comparison: null as null | { comparable: boolean; worse: boolean },
      };
    if (baselinePath) {
      stage = "baseline-comparison";
      const baseline = JSON.parse(
        await readFile(baselinePath, "utf8"),
      ) as typeof summary;
      if (
        JSON.stringify(baseline.environment) !==
        JSON.stringify(comparableEnvironment)
      )
        throw new Error(
          "endurance baseline environment does not match this run",
        );
      summary.comparison = {
        comparable: true,
        worse: summaries.some((candidate) => {
          const clean = baseline.scenarios.find(
            (scenario) =>
              scenario.agents === candidate.agents &&
              scenario.clients === candidate.clients,
          );
          return clean
            ? Object.entries(candidate.trends).some(([name, trend]) => {
                const baselineTrend =
                  clean.trends[name as keyof ScenarioSummary["trends"]];
                return (
                  trend.proportionalGrowth &&
                  trend.slope !== null &&
                  baselineTrend.slope !== null &&
                  trend.slope > baselineTrend.slope
                );
              })
            : true;
        }),
      };
    }
    stage = "trend-assertion";
    const worse =
      summary.comparison?.worse ??
      (summary.allDayEvidence && summary.detectedProportionalGrowth);
    if (worse) summary.status = "failed";
    await writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
    summaryWritten = true;
    expect(worse, "candidate retained more memory than baseline").toBe(false);
    await record({
      type: "run-end",
      status: "completed",
      actualElapsedMs: summary.actualElapsedMs,
    });
  } catch (error) {
    const failure = {
      stage,
      name: error instanceof Error ? error.name : "UnknownError",
      code:
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : null,
    };
    const actualElapsedMs = Date.now() - startedAt;
    if (!summaryWritten)
      await writeFile(
        summaryFile,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            status: "failed",
            allDayEvidence: false,
            requestedDurationMinutes: durationMinutes,
            startedAt: new Date(startedAt).toISOString(),
            endedAt: new Date().toISOString(),
            actualElapsedMs,
            failure,
            scenarios: summaries,
          },
          null,
          2,
        )}\n`,
      );
    await record({
      type: "run-end",
      status: "failed",
      actualElapsedMs,
      failure,
    });
    throw error;
  }
});
