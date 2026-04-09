import type { Key } from "ink";

export function isPreviousAgentShortcut(value: string, key: Key): boolean {
  return (
    (key.ctrl && value.toLowerCase() === "p")
    || value === "\u0010"
    || key.pageUp
    || (key.meta && key.leftArrow)
  );
}

export function isNextAgentShortcut(value: string, key: Key): boolean {
  return (
    (key.ctrl && value.toLowerCase() === "n")
    || value === "\u000e"
    || key.pageDown
    || (key.meta && key.rightArrow)
  );
}

export function buildAgentShortcutHint(agentCount?: number): string {
  return agentCount && agentCount > 1
    ? "工作线: PgUp/PgDn 或 Alt+←/→"
    : "工作线: 仅当前 1 条";
}
