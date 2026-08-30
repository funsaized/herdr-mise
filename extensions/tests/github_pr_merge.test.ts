import { parseMergedPullRequest } from "../models/github_pr_merge.ts";

Deno.test("accepts only an exact merged pull request identity", () => {
  const merged = parseMergedPullRequest(
    JSON.stringify({
      html_url: "https://github.com/funsaized/herdr-mise/pull/76",
      merged: true,
      merged_at: "2026-08-30T17:20:00Z",
      merge_commit_sha: "81fbd55f06bdce6d397f5fddd7b8515b541af2e3",
      number: 76,
    }),
    "70",
  );
  if (
    merged.workItem !== "70" ||
    merged.mergeCommit !== "81fbd55f06bdce6d397f5fddd7b8515b541af2e3"
  ) {
    throw new Error("merged pull request identity was not preserved");
  }
});

Deno.test("rejects pull requests without an exact merge identity", () => {
  for (const response of [
    {
      html_url: "https://github.com/funsaized/herdr-mise/pull/76",
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      number: 76,
    },
    {
      html_url: "https://github.com/other/herdr-mise/pull/76",
      merged: true,
      merged_at: "2026-08-30T17:20:00Z",
      merge_commit_sha: "81fbd55f06bdce6d397f5fddd7b8515b541af2e3",
      number: 76,
    },
  ]) {
    try {
      parseMergedPullRequest(JSON.stringify(response), "70");
    } catch {
      continue;
    }
    throw new Error("invalid merged pull request identity was accepted");
  }
});
