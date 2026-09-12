import { previewSandboxArgs } from "../models/herdr_mise_rust.ts";

Deno.test("preview canary requires isolated namespaces and read-only inputs", async () => {
  const cargo = await Deno.makeTempDir();
  await Deno.mkdir(`${cargo}/registry`);
  const args = previewSandboxArgs("/source", cargo, "/rust", "/scratch");
  for (const required of [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-net",
    "--cap-drop",
    "--proc",
    "--ro-bind",
  ]) {
    if (!args.includes(required)) throw new Error(`missing ${required}`);
  }
  if (args.includes("/repo") || args.includes(Deno.env.get("HOME") ?? "~"))
    throw new Error("sandbox exposes the repository or host home");
  const registry = args.indexOf(`${cargo}/registry`);
  if (registry < 1 || args[registry - 1] !== "--ro-bind")
    throw new Error("sandbox dependency cache is not read-only");
  await Deno.remove(cargo, { recursive: true });
});
