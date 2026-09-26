import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "jsr:@std/path@1.1.2";

export function assertSubjectRootLocation(control: string, subject: string) {
  if (
    subject !== control &&
    (subject.startsWith(`${control}${SEPARATOR}`) ||
      control.startsWith(`${subject}${SEPARATOR}`))
  ) {
    throw new Error("control and subject roots must not contain each other");
  }
  if (subject !== control && dirname(subject) !== dirname(control)) {
    throw new Error(
      "subjectRoot must be the control repository or its sibling",
    );
  }
}

/** Resolve a checkout that is either the control repository or its sibling. */
export async function subjectRoot(
  controlRoot: string,
  value: string,
): Promise<string> {
  const candidate = resolve(controlRoot, value);
  const info = await Deno.lstat(candidate);
  if (!info.isDirectory || info.isSymlink) {
    throw new Error("subjectRoot must be a regular directory");
  }
  const control = await Deno.realPath(controlRoot);
  const subject = await Deno.realPath(candidate);
  assertSubjectRootLocation(control, subject);
  return subject;
}

/** Resolve a possibly absent path whose existing parent remains in the subject. */
export async function subjectPath(
  root: string,
  value: string,
): Promise<string> {
  const candidate = resolve(root, value);
  const child = relative(root, candidate);
  if (
    isAbsolute(child) ||
    child === ".." ||
    child.startsWith(`..${SEPARATOR}`)
  ) {
    throw new Error(`path escapes subjectRoot: ${value}`);
  }
  const parent = await Deno.realPath(dirname(candidate));
  const realChild = relative(root, parent);
  if (
    isAbsolute(realChild) ||
    realChild === ".." ||
    realChild.startsWith(`..${SEPARATOR}`)
  ) {
    throw new Error(`path resolves outside subjectRoot: ${value}`);
  }
  return join(parent, basename(candidate));
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

/** Read a regular, non-symlinked file that resolves inside root. */
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
