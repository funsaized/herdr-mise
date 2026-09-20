import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyLocalRuntime } from "./lib/swamp-local-runtime.mjs";

test("local launcher rejects missing, replaced, and symlinked runtimes", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "swamp-pin-")));
  const binary = join(directory, "swamp");
  const body = "verified fixture";
  const asset = {
    size: Buffer.byteLength(body),
    sha256: createHash("sha256").update(body).digest("hex"),
  };
  try {
    await assert.rejects(verifyLocalRuntime(binary, asset));
    await writeFile(binary, body);
    await verifyLocalRuntime(binary, asset);
    await writeFile(binary, "modified fixture");
    await assert.rejects(verifyLocalRuntime(binary, asset), /checksum/);
    await writeFile(binary, body);
    const link = join(directory, "alias");
    await symlink(binary, link);
    await assert.rejects(verifyLocalRuntime(link, asset), /regular file/);
    const ancestor = join(directory, "linked-directory");
    await symlink(directory, ancestor);
    await assert.rejects(
      verifyLocalRuntime(join(ancestor, "swamp"), asset),
      /symlink/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
