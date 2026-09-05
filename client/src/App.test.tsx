// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SemanticStationControls } from "./chrome/SemanticStationControls";
import {
  humanStateWords,
  semanticAgentsEqual,
  semanticStationLabel,
  type SemanticAgent,
} from "./state/semantic-stations";
import { isGlobalEscape, isInteractiveKeyboardTarget } from "./keyboard";

describe("global keyboard routing", () => {
  it.each(["input", "select", "textarea", "button", "a"])(
    "leaves shortcuts and arrow keys to %s targets",
    (tag) => {
      const element = document.createElement(tag);
      if (tag === "a") element.setAttribute("href", "#");
      document.body.appendChild(element);
      expect(isInteractiveKeyboardTarget(element)).toBe(true);
      element.remove();
    },
  );
  it("leaves nested button targets and editable content alone", () => {
    const button = document.createElement("button"),
      span = document.createElement("span");
    button.appendChild(span);
    expect(isInteractiveKeyboardTarget(span)).toBe(true);
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isInteractiveKeyboardTarget(editable)).toBe(true);
  });
  it("allows scene shortcuts from the document body", () =>
    expect(isInteractiveKeyboardTarget(document.body)).toBe(false));
  it("routes Escape globally even when an interactive control owns focus", () => {
    const select = document.createElement("select");
    document.body.appendChild(select);
    const event = new KeyboardEvent("keydown", { key: "Escape" });
    Object.defineProperty(event, "target", { value: select });
    expect(isGlobalEscape(event)).toBe(true);
    expect(isInteractiveKeyboardTarget(event.target)).toBe(true);
    select.remove();
  });
});

describe("semantic station controls", () => {
  const agent: SemanticAgent = {
    id: "a",
    name: "Codex",
    targetState: "blocked",
    stateEnteredAt: new Date(Date.now() - 65_000).toISOString(),
    blockedPlacement: { kind: "pass", queueOrdinal: 1, queueTotal: 2 },
  };
  it("uses human state wording, stays out of Tab order, and activates details", () => {
    const onSelect = vi.fn();
    render(<SemanticStationControls agents={[agent]} onSelect={onSelect} />);
    const control = screen.getByRole("button", {
      name: /Codex, Blocked — at the pass, queue 1 of 2, 1m \d+s blocked, open details/,
    });
    expect(control.getAttribute("tabindex")).toBe("-1");
    expect(control.textContent).toMatch(/queue 1 of 2 · 1m \d+s blocked/);
    fireEvent.click(control);
    expect(onSelect).toHaveBeenCalledWith("a", control);
  });
  it("accepts the freezer landmark name without changing button tab behavior", () => {
    render(
      <SemanticStationControls
        agents={[{ ...agent, targetState: "ended" }]}
        label="Ended chefs"
        onSelect={() => {}}
      />,
    );
    const navigation = screen.getByRole("navigation", { name: "Ended chefs" });
    expect(navigation).toBeTruthy();
    expect(
      within(navigation).getByRole("button").getAttribute("tabindex"),
    ).toBe("-1");
  });
  it("deduplicates source updates that do not change the semantic slice", () => {
    const same = [agent],
      copy = [{ ...agent }];
    expect(semanticAgentsEqual(same, copy)).toBe(true);
    expect(semanticAgentsEqual(same, [{ ...agent, targetState: "done" }])).toBe(
      false,
    );
    expect(
      semanticAgentsEqual(same, [
        { ...agent, stateEnteredAt: new Date().toISOString() },
      ]),
    ).toBe(false);
  });
  it("uses station and location-neutral blocked fallbacks truthfully", () => {
    const { rerender } = render(
      <SemanticStationControls
        agents={[
          {
            ...agent,
            blockedPlacement: {
              kind: "station",
              queueOrdinal: 2,
              queueTotal: 2,
            },
          },
        ]}
        onSelect={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: /Blocked — waiting at station, queue 2 of 2, 1m 5s blocked/,
      }),
    ).toBeTruthy();
    rerender(
      <SemanticStationControls
        agents={[{ ...agent, blockedPlacement: undefined }]}
        onSelect={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Blocked — waiting, 1m 5s blocked/ }),
    ).toBeTruthy();
  });
  it("keeps the accessible label contract explicit for every human state", () => {
    for (const targetState of Object.keys(humanStateWords) as Array<
      keyof typeof humanStateWords
    >)
      expect(
        semanticStationLabel({
          ...agent,
          targetState,
          blockedPlacement: undefined,
        }),
      ).toContain(humanStateWords[targetState]);
  });
});
