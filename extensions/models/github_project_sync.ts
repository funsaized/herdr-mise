/** Adds one-way Nightshift stage reconciliation to @webframp/github. */
import { z } from "npm:zod@4.4.3";

export const FACTORY_STAGES = [
  "planning",
  "plan-review",
  "building",
  "code-review",
  "ship-prep",
  "shipping",
  "await-merge",
  "deployed-verification",
  "closing",
  "done",
  "aborted",
] as const;

const Stage = z.enum(FACTORY_STAGES);
const Item = z.object({
  issueNumber: z.number().int().positive(),
  stageId: Stage,
});
const Arguments = z
  .object({
    owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
    projectNumber: z.number().int().positive(),
    items: z.array(Item).max(500),
  })
  .superRefine((value, context) => {
    const seen = new Set<number>();
    for (const item of value.items) {
      if (seen.has(item.issueNumber)) {
        context.addIssue({
          code: "custom",
          message: `duplicate issueNumber ${item.issueNumber}`,
        });
      }
      seen.add(item.issueNumber);
    }
  });
const ProjectField = z.object({
  id: z.string().min(1),
  name: z.string(),
  options: z.array(z.object({ id: z.string().min(1), name: z.string() })),
});

type SyncArguments = z.infer<typeof Arguments>;
type Context = {
  signal?: AbortSignal;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

const REPOSITORY = "funsaized/herdr-mise";

function githubEnvironment() {
  const names = [
    "GH_CONFIG_DIR",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "HOME",
    "PATH",
    "XDG_CONFIG_HOME",
  ];
  const env = Object.fromEntries(
    names.flatMap((name) => {
      const value = Deno.env.get(name);
      return value === undefined ? [] : [[name, value]];
    }),
  );
  env.GH_PROMPT_DISABLED = "1";
  return env;
}

async function gh(args: string[], signal?: AbortSignal) {
  const result = await new Deno.Command("gh", {
    args,
    clearEnv: true,
    env: githubEnvironment(),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal,
  }).output();
  if (!result.success) {
    throw new Error(
      new TextDecoder().decode(result.stderr).trim() || `gh ${args[0]} failed`,
    );
  }
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

async function graphql(
  query: string,
  variables: Record<string, string | number | null>,
  signal?: AbortSignal,
) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    if (value === null) continue;
    args.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
  }
  return await gh(args, signal);
}

export function resolveStatusField(rawFields: unknown[]) {
  const fields = rawFields.flatMap((field) => {
    const parsed = ProjectField.safeParse(field);
    return parsed.success && parsed.data.name === "Status" ? [parsed.data] : [];
  });
  if (fields.length !== 1) {
    throw new Error(
      `Project 2 must contain exactly one single-select Status field; found ${fields.length}`,
    );
  }
  const field = fields[0];
  const optionIds = Object.fromEntries(
    FACTORY_STAGES.map((stage) => {
      const matching = field.options.filter((option) => option.name === stage);
      if (matching.length !== 1) {
        throw new Error(
          `Project 2 Status option '${stage}' must exist exactly once; found ${matching.length}`,
        );
      }
      return [stage, matching[0].id];
    }),
  ) as Record<(typeof FACTORY_STAGES)[number], string>;
  return { fieldId: field.id, optionIds };
}

async function projectId(
  owner: string,
  projectNumber: number,
  signal?: AbortSignal,
) {
  const response = await graphql(
    `
      query ($owner: String!, $number: Int!) {
        repositoryOwner(login: $owner) {
          ... on Organization {
            projectV2(number: $number) {
              id
            }
          }
          ... on User {
            projectV2(number: $number) {
              id
            }
          }
        }
      }
    `,
    { owner, number: projectNumber },
    signal,
  );
  const id = response.data?.repositoryOwner?.projectV2?.id;
  if (typeof id !== "string") {
    throw new Error(`cannot resolve ${owner} Project ${projectNumber}`);
  }
  return id;
}

async function projectFields(id: string, signal?: AbortSignal) {
  const fields: unknown[] = [];
  let cursor: string | null = null;
  do {
    const response = await graphql(
      `
        query ($id: ID!, $cursor: String) {
          node(id: $id) {
            ... on ProjectV2 {
              fields(first: 100, after: $cursor) {
                nodes {
                  ... on ProjectV2SingleSelectField {
                    id
                    name
                    options {
                      id
                      name
                    }
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      `,
      { id, cursor },
      signal,
    );
    const page = response.data?.node?.fields;
    if (!page) throw new Error("cannot read Project 2 fields");
    fields.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return fields;
}

type ProjectItem = {
  id: string;
  content?: {
    id: string;
    number: number;
    repository: { nameWithOwner: string };
  };
  fieldValueByName?: { optionId?: string } | null;
};

async function projectItems(id: string, signal?: AbortSignal) {
  const items: ProjectItem[] = [];
  let cursor: string | null = null;
  do {
    const response = await graphql(
      `
        query ($id: ID!, $cursor: String) {
          node(id: $id) {
            ... on ProjectV2 {
              items(first: 100, after: $cursor) {
                nodes {
                  id
                  content {
                    ... on Issue {
                      id
                      number
                      repository {
                        nameWithOwner
                      }
                    }
                  }
                  fieldValueByName(name: "Status") {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      optionId
                    }
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      `,
      { id, cursor },
      signal,
    );
    const page = response.data?.node?.items;
    if (!page) throw new Error("cannot read Project 2 items");
    items.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return items;
}

async function issueId(issueNumber: number, signal?: AbortSignal) {
  const [owner, name] = REPOSITORY.split("/");
  const response = await graphql(
    `
      query ($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          issue(number: $number) {
            id
          }
        }
      }
    `,
    { owner, name, number: issueNumber },
    signal,
  );
  const id = response.data?.repository?.issue?.id;
  if (typeof id !== "string") {
    throw new Error(`cannot resolve ${REPOSITORY} issue ${issueNumber}`);
  }
  return id;
}

async function addItem(project: string, content: string, signal?: AbortSignal) {
  const response = await graphql(
    `
      mutation ($project: ID!, $content: ID!) {
        addProjectV2ItemById(
          input: { projectId: $project, contentId: $content }
        ) {
          item {
            id
          }
        }
      }
    `,
    { project, content },
    signal,
  );
  const id = response.data?.addProjectV2ItemById?.item?.id;
  if (typeof id !== "string") throw new Error("GitHub did not add the issue");
  return id;
}

async function updateStatus(
  project: string,
  item: string,
  field: string,
  option: string,
  signal?: AbortSignal,
) {
  await graphql(
    `
      mutation ($project: ID!, $item: ID!, $field: ID!, $option: String!) {
        updateProjectV2ItemFieldValue(
          input: {
            projectId: $project
            itemId: $item
            fieldId: $field
            value: { singleSelectOptionId: $option }
          }
        ) {
          projectV2Item {
            id
          }
        }
      }
    `,
    { project, item, field, option },
    signal,
  );
}

async function syncProjectItems(args: SyncArguments, signal?: AbortSignal) {
  const project = await projectId(args.owner, args.projectNumber, signal);
  const { fieldId, optionIds } = resolveStatusField(
    await projectFields(project, signal),
  );
  const existing = await projectItems(project, signal);
  const results = [];
  for (const requested of args.items) {
    try {
      let item = existing.find(
        (candidate) =>
          candidate.content?.number === requested.issueNumber &&
          candidate.content.repository.nameWithOwner === REPOSITORY,
      );
      let created = false;
      if (!item) {
        const id = await addItem(
          project,
          await issueId(requested.issueNumber, signal),
          signal,
        );
        item = { id, fieldValueByName: null };
        existing.push(item);
        created = true;
      }
      const optionId = optionIds[requested.stageId];
      if (item.fieldValueByName?.optionId !== optionId) {
        await updateStatus(project, item.id, fieldId, optionId, signal);
        item.fieldValueByName = { optionId };
        results.push({ ...requested, result: created ? "created" : "updated" });
      } else {
        results.push({ ...requested, result: "unchanged" });
      }
    } catch (error) {
      results.push({
        ...requested,
        result: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export const extension = {
  type: "@webframp/github",
  resources: {
    project_sync: {
      description: "Per-issue GitHub Project 2 reconciliation results",
      schema: z.object({
        owner: z.string(),
        projectNumber: z.number().int().positive(),
        repository: z.literal(REPOSITORY),
        items: z.array(
          Item.extend({
            result: z.enum(["created", "updated", "unchanged", "failed"]),
            error: z.string().optional(),
          }),
        ),
        syncedAt: z.iso.datetime(),
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: [
    {
      sync_project_items: {
        description:
          "Project authoritative factory stages into GitHub Project 2",
        arguments: Arguments,
        execute: async (args: SyncArguments, context: Context) => {
          const items = await syncProjectItems(args, context.signal);
          const handle = await context.writeResource(
            "project_sync",
            "project-sync",
            {
              owner: args.owner,
              projectNumber: args.projectNumber,
              repository: REPOSITORY,
              items,
              syncedAt: new Date().toISOString(),
            },
          );
          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
