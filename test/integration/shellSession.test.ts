import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { PersistentShellSession } from "../../src/tool/shellSession.js";
import { buildMockSkillResolvedPaths } from "../helpers/mockSkillFixture.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("PersistentShellSession", () => {
  const sessions: PersistentShellSession[] = [];

  afterAll(async () => {
    await Promise.all(sessions.map((session) => session.dispose()));
  });

  it("在持久 shell 中保留 cwd 上下文", async () => {
    const root = await makeTempDir("qagent-shell-");
    const child = path.join(root, "child");
    const realRoot = await realpath(root);
    const session = new PersistentShellSession("/bin/zsh", root);
    sessions.push(session);

    await session.execute(`mkdir -p "${child}"`, { timeoutMs: 10_000 });
    const first = await session.execute("pwd", { timeoutMs: 10_000 });
    await session.execute(`cd "${child}"`, { timeoutMs: 10_000 });
    const second = await session.execute("pwd", { timeoutMs: 10_000 });
    const firstResolved = await realpath(first.stdout.trim());
    const secondResolved = await realpath(second.stdout.trim());

    expect(firstResolved).toBe(realRoot);
    expect(secondResolved).toBe(path.join(realRoot, "child"));
  });

  it("能通过 shell 直接访问 skill 目录中的 SKILL.md 与资源文件", async () => {
    const paths = buildMockSkillResolvedPaths();
    const session = new PersistentShellSession("/bin/zsh", paths.projectRoot);
    sessions.push(session);

    const projectSkill = await session.execute(
      'cat ".agent/skills/pdf-processing/SKILL.md"',
      { timeoutMs: 10_000 },
    );
    const projectReference = await session.execute(
      'cat ".agent/skills/pdf-processing/references/REFERENCE.md"',
      { timeoutMs: 10_000 },
    );
    const globalScript = await session.execute(
      `cat "${paths.globalSkillsDir}/api-testing/scripts/request.sh"`,
      { timeoutMs: 10_000 },
    );

    expect(projectSkill.stdout).toContain("name: pdf-processing");
    expect(projectSkill.stdout).toContain("PROJECT BODY MARKER: pdf-processing");
    expect(projectReference.stdout).toContain("PDF Reference");
    expect(globalScript.stdout).toContain("mock api request");
  });
});
