"use client";

import { useState, type ReactNode } from "react";

/** A visited tab owns its DOM, local state and native scroll position for the session.
 * Keep its layout while covered; display:none would discard the scroll surface.
 * Freeze parent updates while away so reading progress cannot rearrange hidden shelves.
 */
export function RetainedTab({ active, foreground, name, children }: {
  active: boolean;
  foreground: boolean;
  name: string;
  children: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<ReactNode>(active && foreground ? children : null);
  if (active && foreground && snapshot !== children) setSnapshot(children);
  return (
    <div className="app-tab-content" data-tab={name} data-active={active}
      aria-hidden={!active} inert={!active}>
      {active && foreground ? children : snapshot}
    </div>
  );
}
