/** Shared schema and helpers for managed verification evidence. */
import { z } from "npm:zod@4.4.3";
import { isAbsolute, join, relative, resolve } from "jsr:@std/path@1.1.2";

const GlobalArguments = z.object({
  managedPolicyPath: z.string().default("verification/managed-policy.json"),
  managedOutputPath: z
    .string()
    .default(".swamp/verification-output/manifest.json"),
});

const Summary = z.object({
  commit: z.string(),
  runId: z.string(),
  evidenceRootSha256: z.string(),
  relativePath: z.string(),
  steps: z.number().int().positive(),
  records: z.number().int().positive(),
  artifacts: z.number().int().positive(),
});

export type StoredData = {
  id?: string;
  dataId?: string;
  name: string;
  version: number;
  size?: number;
  contentType?: string;
  specName?: string;
  workflowRunId?: string;
  stepName?: string;
  tags?: Record<string, string>;
  metadata?: {
    contentType?: string;
    tags?: Record<string, string>;
  };
};

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256(bytes: Uint8Array | string): Promise<string> {
  const content =
    typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", content as BufferSource),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function inside(root: string, path: string): string {
  const absolute = resolve(root, path);
  const child = relative(root, absolute);
  if (
    isAbsolute(child) ||
    child === ".." ||
    child.startsWith("../") ||
    child.startsWith("..\\")
  ) {
    throw new Error(`path escapes repository: ${path}`);
  }
  return absolute;
}

export async function readRegularFile(
  root: string,
  path: string,
): Promise<Uint8Array> {
  const absolute = inside(root, path);
  const info = await Deno.lstat(absolute);
  if (!info.isFile || info.isSymlink)
    throw new Error(`${path} is not a regular file`);
  const realRoot = await Deno.realPath(root);
  const realPath = await Deno.realPath(absolute);
  inside(realRoot, realPath);
  return await Deno.readFile(realPath);
}

export async function artifactFiles(root: string, path: string) {
  const absolute = inside(root, path);
  const stat = await Deno.lstat(absolute);
  const paths: string[] = [];
  if (stat.isFile) paths.push(absolute);
  else if (stat.isDirectory) {
    for await (const entry of Deno.readDir(absolute)) {
      const pending = [join(absolute, entry.name)];
      while (pending.length) {
        const current = pending.pop()!;
        const currentStat = await Deno.lstat(current);
        if (currentStat.isSymlink)
          throw new Error(`artifact symlink is forbidden: ${current}`);
        if (currentStat.isFile) paths.push(current);
        else if (currentStat.isDirectory) {
          for await (const child of Deno.readDir(current))
            pending.push(join(current, child.name));
        }
      }
    }
  } else
    throw new Error(`artifact is not a regular file or directory: ${path}`);

  const files = [];
  for (const file of paths.sort()) {
    const content = await Deno.readFile(file);
    const fileStat = await Deno.stat(file);
    files.push({
      path: relative(root, file),
      size: content.length,
      executable: (fileStat.mode ?? 0) & 0o111 ? true : false,
      sha256: await sha256(content),
    });
  }
  if (!files.length) throw new Error(`artifact has no files: ${path}`);
  return { path, files };
}

export function tags(data: StoredData): Record<string, string> {
  return data.metadata?.tags ?? data.tags ?? {};
}

export const model = {
  type: "@funsaized/verification-evidence",
  version: "2026.08.28.3",
  globalArguments: GlobalArguments,
  resources: {
    evidence: {
      description: "Managed verification evidence summary",
      schema: Summary,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
  },
  methods: {},
};
