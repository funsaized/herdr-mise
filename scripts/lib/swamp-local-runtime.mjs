import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";

export async function verifyLocalRuntime(binary, asset) {
  if (!(await lstat(binary)).isFile() || (await realpath(binary)) !== binary)
    throw new Error("Runtime must be a regular file without symlink ancestors");
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(binary)) {
    size += chunk.length;
    hash.update(chunk);
  }
  if (size !== asset.size || hash.digest("hex") !== asset.sha256)
    throw new Error("Runtime checksum or size mismatch");
}
