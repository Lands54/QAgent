import type { Key } from "ink";
import { describe, expect, it } from "vitest";

import {
  buildAgentShortcutHint,
  isNextAgentShortcut,
  isPreviousAgentShortcut,
} from "../../src/ui/agentNavigationShortcuts.js";

function createKey(overrides?: Partial<Key>): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  };
}

describe("agentNavigationShortcuts", () => {
  it("能识别上一 agent 的多种快捷键", () => {
    expect(isPreviousAgentShortcut("p", createKey({ ctrl: true }))).toBe(true);
    expect(isPreviousAgentShortcut("\u0010", createKey())).toBe(true);
    expect(isPreviousAgentShortcut("", createKey({ pageUp: true }))).toBe(true);
    expect(isPreviousAgentShortcut("", createKey({ meta: true, leftArrow: true }))).toBe(true);
  });

  it("能识别下一 agent 的多种快捷键", () => {
    expect(isNextAgentShortcut("n", createKey({ ctrl: true }))).toBe(true);
    expect(isNextAgentShortcut("\u000e", createKey())).toBe(true);
    expect(isNextAgentShortcut("", createKey({ pageDown: true }))).toBe(true);
    expect(isNextAgentShortcut("", createKey({ meta: true, rightArrow: true }))).toBe(true);
  });

  it("会按工作线数量返回更易懂的提示文案", () => {
    expect(buildAgentShortcutHint(1)).toBe("工作线: 仅当前 1 条");
    expect(buildAgentShortcutHint(2)).toBe("工作线: PgUp/PgDn 或 Alt+←/→");
  });
});
