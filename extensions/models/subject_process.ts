/** Bounded streamed execution shared by npm and Rust test receipts. */
export type FileWriter = {
  writeLine(line: string): Promise<void>;
  finalize(): Promise<{ name: string }>;
};

export async function runLogged(
  executable: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  log: FileWriter,
  signal?: AbortSignal,
  reportOutput?: (text: string) => void,
): Promise<number> {
  await log.writeLine(`[command] ${executable} ${args.join(" ")}`);
  const timeout = AbortSignal.timeout(timeoutMs);
  const cancellation = new AbortController();
  const child = new Deno.Command(executable, {
    args,
    cwd,
    env,
    clearEnv: true,
    signal: AbortSignal.any([
      cancellation.signal,
      timeout,
      ...(signal ? [signal] : []),
    ]),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let written = 0;
  let truncated = false;
  let queue = Promise.resolve();
  let failure: unknown;
  const write = async (line: string) => {
    queue = queue
      .then(() => log.writeLine(line))
      .catch((error) => {
        failure ??= error;
        cancellation.abort();
      });
    await queue;
    if (failure) throw failure;
  };
  const pump = async (name: string, stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (written >= 8 * 1024 * 1024) {
          truncated = true;
          continue;
        }
        written += value.length;
        const decoded = decoder.decode(value, { stream: true });
        if (name === "stdout") reportOutput?.(decoded);
        pending += decoded;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          await write(`[${name}] ${line}`);
        }
      }
      const tail = decoder.decode();
      if (name === "stdout") reportOutput?.(tail);
      pending += tail;
      if (pending) await write(`[${name}] ${pending}`);
    } catch (error) {
      failure ??= error;
      cancellation.abort();
      throw error;
    } finally {
      reader.releaseLock();
    }
  };
  const results = await Promise.allSettled([
    pump("stdout", child.stdout),
    pump("stderr", child.stderr),
    child.status,
  ]);
  await queue;
  if (failure) throw failure;
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
  if (truncated) {
    await log.writeLine("[error] output exceeded 8 MiB");
    if (reportOutput)
      throw new Error("Truncated test output cannot prove test counts");
  }
  const status = results[2];
  if (status.status !== "fulfilled") throw status.reason;
  return status.value.code;
}
