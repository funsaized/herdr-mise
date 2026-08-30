import { subjectPath, subjectRoot } from "../models/subject_root.ts";

async function rejects(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error("expected operation to reject");
}

Deno.test("subject roots are canonical peers and paths cannot follow sibling symlinks", async () => {
  const parent = await Deno.makeTempDir({ prefix: "subject-root-test-" });
  const control = `${parent}/control`;
  const subject = `${parent}/subject`;
  const nested = `${control}/nested`;
  try {
    await Deno.mkdir(control);
    await Deno.mkdir(subject);
    await Deno.mkdir(nested);
    await Deno.mkdir(`${subject}/nested`);
    if ((await subjectRoot(control, ".")) !== (await Deno.realPath(control))) {
      throw new Error("local subject root was not preserved");
    }
    if (
      (await subjectRoot(control, "../subject")) !==
      (await Deno.realPath(subject))
    ) {
      throw new Error("sibling subject root was not resolved");
    }
    await rejects(() => subjectRoot(control, "nested"));
    await rejects(() => subjectRoot(control, "../subject/nested"));
    await Deno.symlink(subject, `${control}/linked-subject`);
    await rejects(() => subjectRoot(control, "linked-subject"));
    await rejects(() => subjectPath(control, "linked-subject/file"));
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});
