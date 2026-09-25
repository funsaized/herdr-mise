import {
  extension,
  reviewFingerprint,
} from "../models/nightshift_review_subject.ts";
import { LANE_SKILLS } from "../models/nightshift_review.ts";

Deno.test("review identity detects source, head, policy and skill drift and records actual routes", async () => {
  const parent = await Deno.makeTempDir({ prefix: "review-identity-" });
  const control = `${parent}/control`,
    subject = `${parent}/subject`;
  try {
    await Deno.mkdir(control);
    await Deno.mkdir(`${subject}/docs`, { recursive: true });
    const controls = [
      "AGENTS.md",
      "CONTRIBUTING.md",
      "docs/nightshift/review-calibration.md",
      "agent-constraints/review.md",
      "workflows/workflow-nightshift-review.yaml",
      "extensions/models/nightshift_review.ts",
      "extensions/models/nightshift_review_subject.ts",
      ...Object.values(LANE_SKILLS)
        .flat()
        .map((skill) => `.agents/skills/nightshift-${skill}/SKILL.md`),
    ];
    for (const path of controls) {
      await Deno.mkdir(`${control}/${path.slice(0, path.lastIndexOf("/"))}`, {
        recursive: true,
      });
      await Deno.writeTextFile(`${control}/${path}`, "trusted policy\n");
    }
    await Deno.writeTextFile(`${subject}/docs/user-guide.md`, "original\n");
    const git = async (...args: string[]) => {
      const result = await new Deno.Command("git", {
        args,
        cwd: subject,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!result.success)
        throw new Error(new TextDecoder().decode(result.stderr));
      return new TextDecoder().decode(result.stdout).trim();
    };
    await git("init");
    await git("add", ".");
    const commit = (...args: string[]) =>
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        ...args,
      );
    await commit("-m", "fixture");
    const baseCommit = await git("rev-parse", "HEAD");
    await Deno.writeTextFile(`${subject}/docs/user-guide.md`, "proposed\n");
    const args = {
      workItem: "245",
      runId: "review-fixture",
      phase: "code" as const,
      subjectRoot: subject,
      subject: { baseCommit, summary: "docs" },
      previousFindings: [],
    };
    const first = await reviewFingerprint(args, { repoDir: control });
    const same = await reviewFingerprint(
      { ...args, subject: { summary: "docs", baseCommit } },
      { repoDir: control },
    );
    if (
      first.fingerprint !== same.fingerprint ||
      first.routing.lanes.join() !== "test-coverage,security,quality"
    )
      throw new Error(
        "Identity depends on object key order or lost docs scope",
      );
    const records = new Map<string, unknown>();
    let wrongCwd = false;
    const context = {
      repoDir: control,
      modelType: "@swamp/software-factory",
      modelId: "factory",
      definitionRepository: {
        findByNameGlobal: async (name: string) => ({
          type: { normalized: "@funsaized/cli-agent" },
          definition: { id: name },
        }),
      },
      dataRepository: {
        getContent: async (_type: unknown, id: string, name: string) => {
          const value =
            id === "factory"
              ? records.get(name)
              : {
                  invocationId: name.slice("invocation-".length),
                  success: true,
                  exitCode: 0,
                  timedOut: false,
                  provider: "opencode",
                  model: "actual-provider/actual-model",
                  variant: "actual-variant",
                  cwd: wrongCwd ? control : subject,
                  invokedAt: new Date().toISOString(),
                  parsedResponse: {
                    lane: id.slice("nightshift-".length),
                    verdict: "pass",
                    summary: "Fixture clean review",
                    findings: [],
                  },
                };
          return value ? new TextEncoder().encode(JSON.stringify(value)) : null;
        },
      },
      writeResource: async (
        _spec: string,
        name: string,
        value: Record<string, unknown>,
      ) => {
        records.set(name, value);
        return { name };
      },
    };
    const capture = extension.methods[0].capture_review_subject!.execute;
    const verify = extension.methods[1].verify_review_subject!.execute;
    await capture(args, context);
    const captured = records.get("review-subject-245-review-fixture") as {
      lanePlan: Array<{ lane: string; skills: string }>;
    };
    if (
      captured.lanePlan.map((plan) => plan.lane).join() !==
        "test-coverage,security,quality" ||
      captured.lanePlan[2].skills.split(", ").length !== 3
    )
      throw new Error("Lane plan lost routing or merged-lane skills");
    await verify(args, context);
    const identity = records.get("review-identity-245-review-fixture") as {
      invocations: Array<{ model: string; variant: string }>;
    };
    if (
      identity.invocations.length !== 3 ||
      identity.invocations.some(
        (r) =>
          r.model !== "actual-provider/actual-model" ||
          r.variant !== "actual-variant",
      )
    )
      throw new Error("Configured route replaced actual execution identity");
    const rejects = async () => {
      let rejected = false;
      try {
        await verify(args, context);
      } catch {
        rejected = true;
      }
      if (!rejected)
        throw new Error("Changed subject or execution identity accepted");
    };
    wrongCwd = true;
    await rejects();
    wrongCwd = false;
    for (const path of [
      "agent-constraints/review.md",
      ".agents/skills/nightshift-security/SKILL.md",
    ]) {
      await Deno.writeTextFile(`${control}/${path}`, "changed\n");
      await rejects();
      await Deno.writeTextFile(`${control}/${path}`, "trusted policy\n");
    }
    await Deno.writeTextFile(
      `${subject}/docs/user-guide.md`,
      "changed during review\n",
    );
    await rejects();
    await Deno.writeTextFile(`${subject}/docs/user-guide.md`, "proposed\n");
    await verify(args, context);
    await commit("--allow-empty", "-m", "new head same bytes");
    await rejects();
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});
