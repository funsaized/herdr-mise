import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

export interface PanelAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PanelAnchorSource = PanelAnchor | null | (() => PanelAnchor | null);

const panelMargin = 8;
const anchorGap = 8;
const defaultPanelWidth = 320;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function computePanelPlacement(
  anchor: PanelAnchor,
  panel: { width: number; height: number },
  viewport: { width: number; height: number; top: number; bottom: number },
): { placement: "above" | "below"; style: CSSProperties } {
  const panelWidth = Math.min(
      panel.width || defaultPanelWidth,
      viewport.width - 2 * panelMargin,
    ),
    spaceAbove = Math.max(
      0,
      Math.min(anchor.y - anchorGap, viewport.bottom) - viewport.top,
    ),
    spaceBelow = Math.max(
      0,
      viewport.bottom -
        Math.max(viewport.top, anchor.y + anchor.height + anchorGap),
    ),
    maxHeight = Math.max(44, Math.max(spaceAbove, spaceBelow)),
    panelHeight = Math.min(panel.height, maxHeight),
    belowTop = anchor.y + anchor.height + anchorGap,
    aboveTop = anchor.y - panelHeight - anchorGap,
    placement =
      spaceBelow >= panelHeight || spaceBelow >= spaceAbove ? "below" : "above",
    top = clamp(
      placement === "below" ? belowTop : aboveTop,
      viewport.top,
      Math.max(viewport.top, viewport.bottom - panelHeight),
    ),
    left = clamp(
      anchor.x + anchor.width / 2 - panelWidth / 2,
      panelMargin,
      Math.max(panelMargin, viewport.width - panelWidth - panelMargin),
    );
  return {
    placement,
    // CSS re-clamps to the live viewport so a resize never leaves the panel
    // outside it before the next measurement runs.
    style: {
      left: `clamp(${panelMargin}px, ${left}px, calc(100vw - ${panelMargin}px - var(--panelWidth)))`,
      top: `min(${top}px, calc(100dvh - ${panelMargin + 44}px))`,
      right: "auto",
      bottom: "auto",
      // --panelMaxHeight lets CSS shrink the panel the moment a sibling
      // surface (such as an opened Recap) claims space, before remeasuring.
      maxHeight: `min(${maxHeight}px, calc(100dvh - ${top + panelMargin}px), var(--panelMaxHeight, 100dvh))`,
      overflowY: "auto",
    },
  };
}

export function FocusedPanel({
  className = "panel",
  label,
  anchor,
  avoid,
  children,
}: {
  className?: string;
  label: string;
  anchor?: PanelAnchorSource;
  avoid?: PanelAnchorSource;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [placement, setPlacement] = useState<"above" | "below" | null>(null);
  const [style, setStyle] = useState<CSSProperties>();
  useEffect(() => ref.current?.focus(), []);
  useLayoutEffect(() => {
    const resolve = () => (typeof anchor === "function" ? anchor() : anchor);
    const update = () => {
      const node = ref.current;
      if (!node) return;
      // Without an opener on screen (for example the renderer-fallback
      // list), anchor to the top-right corner so obstacles still apply.
      const target = resolve() ?? {
        x: innerWidth - panelMargin,
        y: 0,
        width: 0,
        height: 0,
      };
      const rect = node.getBoundingClientRect(),
        // Only surfaces in the panel's own column constrain it: a placard or
        // tools pill at the far edge must not cost a centred panel its room.
        columnWidth = Math.min(
          rect.width || defaultPanelWidth,
          innerWidth - 2 * panelMargin,
        ),
        columnLeft = clamp(
          target.x + target.width / 2 - columnWidth / 2,
          panelMargin,
          innerWidth - columnWidth - panelMargin,
        ),
        inColumn = (box: PanelAnchor) =>
          box.width > 0 &&
          box.height > 0 &&
          box.x < columnLeft + columnWidth + panelMargin &&
          box.x + box.width > columnLeft - panelMargin,
        top = panelMargin,
        bottom = innerHeight - panelMargin,
        obstacles = [
          typeof avoid === "function" ? avoid() : avoid,
          ...[
            ".serviceStrip",
            ".chromeFooter",
            ".kitchenPager",
            ".freezerInspector",
            ".demoPlacard",
            ".emptyPill",
            // The renderer-fallback list paints above chrome, so panels
            // opened from its rows must sit beside it, not under it.
            ".rendererFallback",
            ".serviceRecap[open] > div",
          ].map((selector) =>
            document.querySelector(selector)?.getBoundingClientRect(),
          ),
        ].filter(
          (item): item is PanelAnchor => Boolean(item) && inColumn(item!),
        ),
        bands = obstacles.reduce<{ top: number; bottom: number }[]>(
          (areas, obstacle) =>
            areas.flatMap((area) => {
              if (
                obstacle.y >= area.bottom ||
                obstacle.y + obstacle.height <= area.top
              )
                return [area];
              return [
                { top: area.top, bottom: obstacle.y - panelMargin },
                {
                  top: obstacle.y + obstacle.height + panelMargin,
                  bottom: area.bottom,
                },
              ].filter((area) => area.bottom - area.top >= 44);
            }),
          [{ top, bottom }],
        ),
        area = bands.sort(
          (a, b) => b.bottom - b.top - (a.bottom - a.top),
        )[0] ?? { top, bottom },
        next = computePanelPlacement(
          target,
          // Place by the panel's natural height, not its current box: a
          // panel squeezed into a small band would otherwise keep fitting
          // there and never move to the roomier side of its opener.
          {
            width: rect.width,
            height: Math.max(
              rect.height,
              node.scrollHeight + (node.offsetHeight - node.clientHeight),
            ),
          },
          { width: innerWidth, height: innerHeight, ...area },
        );
      setPlacement(next.placement);
      setStyle(next.style);
    };
    update();
    window.addEventListener("resize", update);
    // An opened or closed Recap changes the space this panel may use; its
    // body renders after the toggle event, so measure on the next frame.
    let frame = 0;
    const afterToggle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    document.addEventListener("toggle", afterToggle, true);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined" && ref.current) {
      observer = new ResizeObserver(update);
      observer.observe(ref.current);
    }
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("toggle", afterToggle, true);
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [anchor, avoid]);
  return (
    <aside
      ref={ref}
      className={className}
      aria-label={label}
      tabIndex={-1}
      style={style}
      data-placement={placement ?? undefined}
    >
      {children}
    </aside>
  );
}
