import {
  compatibilityDispatchArgs,
  extension,
  requireSubject,
  requireManagedSuccess,
} from "../models/github_delivery.ts";

const sha = "a".repeat(40);
const subject = {
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "nightshift/188",
  headRefOid: sha,
};

Deno.test("delivery accepts only the exact open non-draft main subject", () => {
  requireSubject(subject, sha);
  for (const change of [
    { state: "CLOSED" },
    { state: "MERGED" },
    { isDraft: true },
    { baseRefName: "other" },
    { headRefOid: "b".repeat(40) },
  ]) {
    let rejected = false;
    try {
      requireSubject({ ...subject, ...change }, sha);
    } catch {
      rejected = true;
    }
    if (!rejected)
      throw new Error(`Accepted unsafe subject: ${JSON.stringify(change)}`);
  }
});

Deno.test("compatibility dispatch derives only the verified PR head ref", () => {
  const methods = Object.assign({}, ...extension.methods);
  if (
    !methods.dispatch_compatibility.arguments.safeParse({
      prNumber: 188,
      headSha: sha,
    }).success
  )
    throw new Error("Exact compatibility dispatch identity was rejected");
  const args = compatibilityDispatchArgs(subject, sha);
  if (
    JSON.stringify(args) !==
    JSON.stringify([
      "workflow",
      "run",
      "herdr-compatibility-drift.yml",
      "--repo",
      "funsaized/herdr-mise",
      "--ref",
      subject.headRefName,
    ])
  )
    throw new Error(
      `Unexpected compatibility dispatch: ${JSON.stringify(args)}`,
    );
  for (const change of [
    { headRefName: "--help" },
    { headRefName: undefined },
    { headRefOid: "b".repeat(40) },
  ]) {
    let rejected = false;
    try {
      compatibilityDispatchArgs({ ...subject, ...change }, sha);
    } catch {
      rejected = true;
    }
    if (!rejected)
      throw new Error(
        `Accepted unsafe compatibility ref: ${JSON.stringify(change)}`,
      );
  }
});

Deno.test("delivery schemas reject flags and missing identities", () => {
  const methods = Object.assign({}, ...extension.methods);
  for (const input of [
    { prNumber: 1 },
    { prNumber: -1, headSha: sha },
    { prNumber: 1, headSha: "short" },
  ]) {
    if (methods.dispatch_managed.arguments.safeParse(input).success)
      throw new Error("Unsafe dispatch input accepted");
    if (methods.dispatch_compatibility.arguments.safeParse(input).success)
      throw new Error("Unsafe compatibility dispatch input accepted");
    if (methods.merge_delivery.arguments.safeParse(input).success)
      throw new Error("Unsafe merge input accepted");
  }
  if (
    methods.open_delivery_pr.arguments.safeParse({
      head: "--help",
      title: "test",
      body: "",
    }).success
  )
    throw new Error("Flag accepted as branch");
});

Deno.test("merge requires the authoritative managed status, not a similarly named check", () => {
  requireManagedSuccess([
    { context: "Swamp managed verification", state: "SUCCESS" },
  ]);
  for (const checks of [
    [],
    [{ context: "Swamp managed verification", state: "PENDING" }],
    [{ name: "Swamp managed verification", conclusion: "SUCCESS" }],
  ]) {
    let rejected = false;
    try {
      requireManagedSuccess(checks);
    } catch {
      rejected = true;
    }
    if (!rejected)
      throw new Error("Missing authoritative success was accepted");
  }
});
