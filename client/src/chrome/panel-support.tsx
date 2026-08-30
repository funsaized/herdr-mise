import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

export function FocusedPanel({
  className = "panel",
  label,
  modal = false,
  children,
}: {
  className?: string;
  label: string;
  modal?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const trapFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (!modal || event.key !== "Tab" || !ref.current) return;
    const controls = Array.from(
        ref.current.querySelectorAll<HTMLElement>(
          "button, select, input, a[href]",
        ),
      ),
      first = controls[0],
      last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === ref.current) {
      event.preventDefault();
      last.focus();
    }
  };
  return (
    <aside
      ref={ref}
      className={className}
      aria-label={label}
      aria-modal={modal || undefined}
      role={modal ? "dialog" : undefined}
      tabIndex={-1}
      onKeyDown={trapFocus}
    >
      {children}
    </aside>
  );
}
