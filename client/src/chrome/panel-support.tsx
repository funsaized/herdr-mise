import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export function FocusedPanel({
  className = "panel",
  label,
  children,
}: {
  className?: string;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <aside ref={ref} className={className} aria-label={label} tabIndex={-1}>
      {children}
    </aside>
  );
}
