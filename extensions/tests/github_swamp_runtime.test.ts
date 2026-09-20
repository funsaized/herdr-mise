import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createHash } from "node:crypto";
import { installVerifiedRuntime } from "../models/github_swamp_runtime.ts";

Deno.test("runtime provisioning verifies bytes before atomic replacement and cleans failed downloads", async () => {
  const directory = await Deno.makeTempDir();
  const bytes = new TextEncoder().encode("verified runtime fixture");
  const asset = {
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const target = `${directory}/swamp`;
  const fetcher = (body: Uint8Array, status = 200) =>
    (() =>
      Promise.resolve(
        new Response(new Uint8Array(body), { status }),
      )) as typeof fetch;
  try {
    await Deno.writeTextFile(target, "existing runtime");
    for (const body of [
      bytes.slice(1),
      new Uint8Array(bytes.length),
      new Uint8Array(bytes.length + 1),
    ]) {
      await assertRejects(() =>
        installVerifiedRuntime(
          directory,
          asset,
          "https://example.invalid",
          undefined,
          fetcher(body),
        ),
      );
      assertEquals(await Deno.readTextFile(target), "existing runtime");
      assertEquals(
        await Array.fromAsync(Deno.readDir(directory), (entry) => entry.name),
        ["swamp"],
      );
    }
    await assertRejects(
      () =>
        installVerifiedRuntime(
          directory,
          asset,
          "https://example.invalid",
          undefined,
          fetcher(bytes, 403),
        ),
      Error,
      "HTTP 403",
    );
    const aborted = new AbortController();
    aborted.abort();
    await assertRejects(() =>
      installVerifiedRuntime(
        directory,
        asset,
        "https://example.invalid",
        aborted.signal,
        ((_url, options) => {
          options?.signal?.throwIfAborted();
          return Promise.resolve(new Response(bytes));
        }) as typeof fetch,
      ),
    );
    assertEquals(await Deno.readTextFile(target), "existing runtime");
    assertEquals(
      await installVerifiedRuntime(
        directory,
        asset,
        "https://example.invalid",
        undefined,
        fetcher(bytes),
      ),
      target,
    );
    assertEquals(await Deno.readFile(target), bytes);
    assertEquals((await Deno.stat(target)).mode! & 0o777, 0o755);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
