import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "jsr:@std/path@1.1.2";

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
