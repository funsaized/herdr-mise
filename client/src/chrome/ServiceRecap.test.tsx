// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  AgentRecord,
  WorkspaceRecord,
} from "../../../protocol/generated/agent-state-event";
import { AgentStore } from "../state/store";
import { RECAP_LIMIT } from "../state/recap";
import * as geometry from "../scene/geometry";
import { ServiceRecap } from "./ServiceRecap";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const agent = (
  id: string,
  workspaceId: string | undefined = "one",
): AgentRecord => ({
  id,
  name: "Cook",
  workspaceId,
  workspace: workspaceId ?? "",
  state: "working",
  stateEnteredAt: "2026-01-01T00:00:00Z",
  progress: null,
  accentIndex: 0,
  model: "",
  session: { runtimeMs: 0, tickets: 0 },
});
const snapshot = (
  store: AgentStore,
  agents: AgentRecord[],
  workspaces: WorkspaceRecord[] = [],
) =>
  store.apply({
    type: "snapshot",
    version: 1,
    mode: "live",
    sourceStatus: "connected",
    agents,
    workspaces,
  });
function openRecap() {
  const details = screen.getByLabelText("Service recap")
    .parentElement as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  return details;
}
const labels = () =>
  screen.getAllByRole("rowheader").map((row) => row.textContent);
const selectScope = (name: string) =>
  fireEvent.change(screen.getByLabelText("Recap workspace"), {
    target: {
      value: (screen.getByRole("option", { name }) as HTMLOptionElement).value,
    },
  });

it("recap agent labels remain stable through join leave and paging", () => {
  const store = new AgentStore();
  const agents = Array.from({ length: 24 }, (_, i) =>
    agent(`terminal-${String(i).padStart(2, "0")}`, i % 2 ? "two" : "one"),
  );
  snapshot(store, [agents[0]]);
  const view = render(<ServiceRecap store={store} coarse={store.coarse()} />);
  const details = openRecap();
  expect(labels()).toEqual(["Cook (terminal-00)"]);
  snapshot(store, [...agents].reverse());
  view.rerender(<ServiceRecap store={store} coarse={store.coarse()} />);
  expect(labels()).toEqual(agents.slice(0, 20).map((a) => `Cook (${a.id})`));
  fireEvent.click(screen.getByText("Next"));
  expect(labels()).toEqual(agents.slice(20).map((a) => `Cook (${a.id})`));
  snapshot(store, [...agents.slice(0, 23), { ...agents[23], state: "ended" }]);
  snapshot(store, agents.slice(0, 23));
  view.rerender(<ServiceRecap store={store} coarse={store.coarse()} />);
  expect(labels()).toEqual(agents.slice(20).map((a) => `Cook (${a.id})`));
  expect(screen.getAllByRole("row").at(-1)?.textContent).toContain("1");
  selectScope("one");
  expect(labels()).toEqual(
    agents.filter((a) => a.workspaceId === "one").map((a) => `Cook (${a.id})`),
  );
  fireEvent.change(screen.getByLabelText("Recap workspace"), {
    target: { value: "0" },
  });
  details.open = false;
  fireEvent(details, new Event("toggle"));
  openRecap();
  expect(labels()[0]).toBe("Cook (terminal-00)");
  snapshot(store, [{ ...agents[0], name: "Renamed" }, ...agents.slice(1, 23)]);
  view.rerender(<ServiceRecap store={store} coarse={store.coarse()} />);
  fireEvent.click(screen.getByText("Next"));
  expect(labels()).toContain("Renamed (terminal-00)");
  // Evict old observations without evicting the live survivor's identity.
  for (let i = 0; i <= RECAP_LIMIT; i++)
    store.apply({
      type: "delta",
      version: 1,
      mode: "live",
      operation: "upsert",
      agent: { ...agent(`departed-${i}`), state: "ended" },
    });
  view.rerender(<ServiceRecap store={store} coarse={store.coarse()} />);
  selectScope("two");
  expect(labels()).toContain("Cook (terminal-01)");
  expect(labels().length).toBeLessThanOrEqual(20);
});

it("recap option labels use linear work for thousands of retained scopes", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const store = new AgentStore();
  const agents = Array.from({ length: RECAP_LIMIT }, (_, i) =>
    agent(`a${i}`, `w${i}`),
  );
  const catalog = agents.map((a, i) => ({
    id: a.workspaceId!,
    label: `/kitchen/${i}/shared`,
  }));
  snapshot(store, agents, catalog);
  snapshot(store, [], catalog);
  snapshot(
    store,
    [
      { ...agent("missing"), workspaceId: undefined },
      agent("literal", "__missing__"),
    ],
    [
      { id: "w0", label: "/renamed/unique" },
      { id: "__missing__", label: "/real/shared" },
    ],
  );
  const normalize = vi.spyOn(geometry, "workspaceDisplayName");
  const summarize = vi.spyOn(store, "recapSummary");
  const view = render(<ServiceRecap store={store} coarse={store.coarse()} />);
  openRecap();
  const options = screen.getAllByRole("option");
  expect(options).toHaveLength(RECAP_LIMIT + 3);
  expect(options[1].textContent).toBe("unique");
  expect(options[2].textContent).toBe("shared (w1)");
  expect(options.at(-2)?.textContent).toBe("Unavailable identity");
  expect(options.at(-1)?.textContent).toBe("shared (__missing__)");
  expect(normalize).toHaveBeenCalledTimes(RECAP_LIMIT + 2);
  expect(summarize.mock.calls.map(([scope]) => scope)).toEqual([null]);
  normalize.mockClear();
  summarize.mockClear();
  fireEvent.change(screen.getByLabelText("Recap workspace"), {
    target: { value: "2" },
  });
  expect(summarize.mock.calls.map(([scope]) => scope)).toEqual([null, "w1"]);
  expect(normalize).toHaveBeenCalledTimes(RECAP_LIMIT + 2);
  expect(labels()).toEqual(["Cook (a1)"]);
  normalize.mockClear();
  summarize.mockClear();
  view.rerender(<ServiceRecap store={store} coarse={store.coarse()} />);
  expect(
    (screen.getByLabelText("Recap workspace") as HTMLSelectElement).value,
  ).toBe("2");
  expect(summarize.mock.calls.map(([scope]) => scope)).toEqual([null, "w1"]);
  expect(normalize).toHaveBeenCalledTimes(RECAP_LIMIT + 2);
  fireEvent.change(screen.getByLabelText("Recap workspace"), {
    target: { value: String(RECAP_LIMIT + 1) },
  });
  expect(labels()).toEqual(["Cook (missing)"]);
  fireEvent.change(screen.getByLabelText("Recap workspace"), {
    target: { value: String(RECAP_LIMIT + 2) },
  });
  expect(labels()).toEqual(["Cook (literal)"]);
});
