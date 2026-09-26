// Create and start one runtime Nightshift factory (`nightshift-run-<item>`)
// from the authored template definition.
//
// Swamp refuses to persist a definition whose `${{ }}` text arrived as
// evaluated workflow data, and the factory's stage bindings are exactly such
// text (the engine evaluates them at dispatch). Creating the instance through
// `swamp model create --global-arg` keeps that text command-authored.
//
// `swamp` is `(args) => ({ status, json, stdout, stderr })`, already bound to
// a repository or server, so the same code serves the CLI and the tests.

const FACTORY_TYPE = "@swamp/software-factory";

function expectOk(result, action) {
  if (result.status !== 0)
    throw new Error(
      `${action} failed: ${result.json?.error ?? result.stderr ?? result.stdout}`,
    );
  return result.json;
}

function owners(swamp, workItem) {
  return expectOk(
    swamp([
      "data",
      "query",
      `modelType == "${FACTORY_TYPE}" && name == "state-${workItem}"`,
    ]),
    "state lookup",
  ).results.filter((record) => record.isLatest !== false);
}

export function startFactoryInstance(
  swamp,
  {
    workItem,
    modelName = `nightshift-run-${workItem}`,
    template = "nightshift-template",
  },
) {
  if (!/^[1-9][0-9]{0,15}$/.test(workItem))
    throw new Error(`workItem must be a positive decimal: ${workItem}`);
  const existing = owners(swamp, workItem);
  if (existing.length) {
    if (existing.length === 1 && existing[0].modelName === modelName)
      return { modelName, created: false, started: false };
    throw new Error(
      `work item ${workItem} is already owned by ${existing.map((o) => o.modelName).join(", ")}`,
    );
  }

  const { stages, globalTransitions = [] } = expectOk(
    swamp(["model", "get", template]),
    `reading ${template}`,
  ).globalArguments;
  let current = swamp(["model", "get", modelName]);
  let created = false;
  if (current.status === 0) {
    // Reuse only a definition identical to the template (e.g. a start that failed).
    const found = current.json.globalArguments ?? {};
    if (
      JSON.stringify(found.stages) !== JSON.stringify(stages) ||
      JSON.stringify(found.globalTransitions ?? []) !==
        JSON.stringify(globalTransitions)
    )
      throw new Error(
        `${modelName} exists with a definition that differs from ${template}`,
      );
  } else {
    const made = expectOk(
      swamp([
        "model",
        "create",
        FACTORY_TYPE,
        modelName,
        "--global-arg",
        `stages=${JSON.stringify(stages)}`,
        "--global-arg",
        `globalTransitions=${JSON.stringify(globalTransitions)}`,
      ]),
      `creating ${modelName}`,
    );
    current = swamp(["model", "get", modelName]);
    // A concurrent create of the same name would replace the definition file.
    if (expectOk(current, `reading ${modelName}`).id !== made.id)
      throw new Error(
        `${modelName} was replaced concurrently; intake must be single-writer`,
      );
    created = true;
  }

  expectOk(
    swamp([
      "model",
      "method",
      "run",
      modelName,
      "start",
      "--input",
      `workItem=${workItem}`,
    ]),
    `starting ${modelName}`,
  );
  const after = owners(swamp, workItem);
  if (after.length !== 1 || after[0].modelName !== modelName)
    throw new Error(
      `work item ${workItem} must have exactly one owner, found ${after.length}`,
    );
  return { modelName, created, started: true };
}

/**
 * Restore a runtime factory's lifecycle definition from the template without
 * changing its model ID or data (the explicit operator repair path).
 */
export function repairFactoryInstance(
  swamp,
  {
    workItem,
    modelName = `nightshift-run-${workItem}`,
    template = "nightshift-template",
  },
) {
  const current = expectOk(
    swamp(["model", "get", modelName]),
    `reading ${modelName}`,
  );
  const source = expectOk(
    swamp(["model", "get", template]),
    `reading ${template}`,
  );
  const definition = {
    type: current.type,
    typeVersion: current.typeVersion,
    id: current.id,
    name: current.name,
    version: current.version,
    tags: current.tags ?? {},
    globalArguments: {
      stages: source.globalArguments.stages,
      globalTransitions: source.globalArguments.globalTransitions ?? [],
    },
    methods: {},
  };
  expectOk(
    swamp(["model", "edit", modelName], JSON.stringify(definition)),
    `repairing ${modelName}`,
  );
  expectOk(
    swamp(["model", "method", "run", modelName, "validate"]),
    `validating ${modelName}`,
  );
  const repaired = expectOk(
    swamp(["model", "get", modelName]),
    `reading ${modelName}`,
  );
  if (repaired.id !== current.id)
    throw new Error(`${modelName} changed identity during repair`);
  return { modelName, repaired: true };
}
