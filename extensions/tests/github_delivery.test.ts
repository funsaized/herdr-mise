import {
  extension,
  requireSubject,
  requireManagedSuccess,
} from "../models/github_delivery.ts";

const sha = "a".repeat(40);
const subject = {
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
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

Deno.test("delivery schemas reject flags and missing identities", () => {
  const methods = Object.assign({}, ...extension.methods);
  for (const input of [
    { prNumber: 1 },
    { prNumber: -1, headSha: sha },
    { prNumber: 1, headSha: "short" },
  ]) {
    if (methods.dispatch_managed.arguments.safeParse(input).success)
      throw new Error("Unsafe dispatch input accepted");
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
