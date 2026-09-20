/** Provision a checksum-pinned Mac CLI without changing the global installation. */
import { z } from "npm:zod@4.4.3";
import { createHash } from "node:crypto";
import { join } from "jsr:@std/path@1.1.2";

const Pin = z.object({
  version: z.string().regex(/^\d{8}\.\d{6}\.\d+$/),
  tag: z.string().regex(/^v\d{8}\.\d{6}\.\d+-sha\.[0-9a-f]+$/),
  assets: z.record(
    z.enum(["aarch64", "x86_64"]),
    z.object({
      name: z.string().regex(/^swamp-darwin-(aarch64|x86_64)$/),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      size: z
        .number()
        .int()
        .positive()
        .max(512 * 1024 * 1024),
    }),
  ),
});

type Context = {
  repoDir: string;
  signal?: AbortSignal;
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<unknown>;
};

async function removeTemporary(path: string) {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/** Download to a sibling temporary file; failed integrity never replaces a working runtime. */
export async function installVerifiedRuntime(
  directory: string,
  asset: { size: number; sha256: string },
  url: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const temporary = await Deno.makeTempFile({
    dir: directory,
    prefix: ".download-",
  });
  try {
    signal?.throwIfAborted();
    const response = await fetcher(url, { signal });
    if (!response.ok || !response.body)
      throw new Error(`Runtime download failed: HTTP ${response.status}`);
    const file = await Deno.open(temporary, {
      write: true,
      truncate: true,
    });
    const writer = file.writable.getWriter();
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of response.body) {
        signal?.throwIfAborted();
        size += chunk.length;
        if (size > asset.size)
          throw new Error("Runtime download exceeds pinned size");
        hash.update(chunk);
        await writer.write(chunk);
      }
    } finally {
      await writer.close();
    }
    if (size !== asset.size || hash.digest("hex") !== asset.sha256)
      throw new Error("Runtime checksum or size mismatch");
    signal?.throwIfAborted();
    await Deno.chmod(temporary, 0o755);
    const path = join(directory, "swamp");
    await Deno.rename(temporary, path);
    return path;
  } finally {
    await removeTemporary(temporary);
  }
}

export const extension = {
  type: "@webframp/github",
  resources: {
    localSwampRuntime: {
      description: "Installed repository-scoped CLI identity",
      schema: z.object({
        version: z.string(),
        path: z.string(),
        sha256: z.string(),
        installedAt: z.iso.datetime(),
      }),
      lifetime: "30d",
      garbageCollection: 10,
    },
  },
  methods: [
    {
      install_local_swamp: {
        description:
          "Install the repository-pinned macOS Swamp CLI with SHA-256 verification",
        arguments: z.object({}),
        execute: async (_args: Record<string, never>, context: Context) => {
          if (Deno.build.os !== "darwin")
            throw new Error(
              "Local pinned runtime currently supports macOS only",
            );
          const root = await Deno.realPath(context.repoDir);
          const pin = Pin.parse(
            JSON.parse(
              await Deno.readTextFile(
                join(root, "verification/swamp-local-runtime.json"),
              ),
            ),
          );
          const config = await Deno.readTextFile(join(root, ".swamp.yaml"));
          if (!config.split(/\r?\n/).includes(`swampVersion: ${pin.version}`))
            throw new Error("Local runtime pin disagrees with .swamp.yaml");
          if (!pin.tag.startsWith(`v${pin.version}-sha.`))
            throw new Error("Release tag disagrees with runtime version");
          const asset = pin.assets[Deno.build.arch];
          if (!asset || asset.name !== `swamp-darwin-${Deno.build.arch}`)
            throw new Error("Unsupported runtime architecture");
          let directory = root;
          for (const part of [
            ".tools",
            "swamp",
            pin.version,
            Deno.build.arch,
          ]) {
            directory = join(directory, part);
            try {
              await Deno.mkdir(directory);
            } catch (error) {
              if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
            }
            if (
              (await Deno.lstat(directory)).isSymlink ||
              (await Deno.realPath(directory)) !== directory
            )
              throw new Error("Runtime directory must not be a symlink");
          }
          const path = await installVerifiedRuntime(
            directory,
            asset,
            `https://github.com/swamp-club/swamp/releases/download/${pin.tag}/${asset.name}`,
            AbortSignal.any([
              AbortSignal.timeout(300_000),
              ...(context.signal ? [context.signal] : []),
            ]),
          );
          const handle = await context.writeResource(
            "localSwampRuntime",
            "local-swamp-runtime",
            {
              version: pin.version,
              path,
              sha256: asset.sha256,
              installedAt: new Date().toISOString(),
            },
          );
          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
