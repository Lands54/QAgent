import { spawn } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { PersistentShellSession } from "../../src/tool/shellSession.js";
import { buildMockSkillResolvedPaths } from "../helpers/mockSkillFixture.js";
import {
  getChangeDirectoryCommand,
  getCreateDirectoryCommand,
  getPrintWorkingDirectoryCommand,
  getReadFileCommand,
  getTestShellExecutable,
  normalizeShellPath,
} from "../helpers/shellTestHarness.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("PersistentShellSession", () => {
  const sessions: PersistentShellSession[] = [];
  const itWindowsOnly = process.platform === "win32" ? it : it.skip;

  afterAll(async () => {
    await Promise.all(sessions.map((session) => session.dispose()));
  });

  it("在持久 shell 中保留 cwd 上下文", async () => {
    const root = await makeTempDir("qagent-shell-");
    const child = path.join(root, "child");
    const realRoot = await realpath(root);
    const session = new PersistentShellSession(getTestShellExecutable(), root);
    sessions.push(session);

    await session.execute(getCreateDirectoryCommand(child), { timeoutMs: 10_000 });
    const first = await session.execute(getPrintWorkingDirectoryCommand(), { timeoutMs: 10_000 });
    await session.execute(getChangeDirectoryCommand(child), { timeoutMs: 10_000 });
    const second = await session.execute(getPrintWorkingDirectoryCommand(), { timeoutMs: 10_000 });
    const firstResolved = await realpath(normalizeShellPath(first.stdout));
    const secondResolved = await realpath(normalizeShellPath(second.stdout));

    expect(firstResolved).toBe(realRoot);
    expect(secondResolved).toBe(path.join(realRoot, "child"));
  });

  it("能通过 shell 直接访问 skill 目录中的 SKILL.md 与资源文件", async () => {
    const paths = buildMockSkillResolvedPaths();
    const session = new PersistentShellSession(
      getTestShellExecutable(),
      paths.projectRoot,
    );
    sessions.push(session);

    const projectSkill = await session.execute(
      getReadFileCommand(
        path.join(
          paths.projectRoot,
          ".agent",
          "skills",
          "pdf-processing",
          "SKILL.md",
        ),
      ),
      { timeoutMs: 10_000 },
    );
    const projectReference = await session.execute(
      getReadFileCommand(
        path.join(
          paths.projectRoot,
          ".agent",
          "skills",
          "pdf-processing",
          "references",
          "REFERENCE.md",
        ),
      ),
      { timeoutMs: 10_000 },
    );
    const globalScript = await session.execute(
      getReadFileCommand(
        path.join(paths.globalSkillsDir, "api-testing", "scripts", "request.sh"),
      ),
      { timeoutMs: 10_000 },
    );

    expect(projectSkill.stdout).toContain("name: pdf-processing");
    expect(projectSkill.stdout).toContain("PROJECT BODY MARKER: pdf-processing");
    expect(projectReference.stdout).toContain("PDF Reference");
    expect(globalScript.stdout).toContain("mock api request");
  });
  itWindowsOnly("Windows 后台进程里的 PowerShell stdout 会保留 UTF-8 中文", async () => {
    const shellSessionModuleUrl = pathToFileURL(
      path.join(process.cwd(), "src", "tool", "shellSession.ts"),
    ).href;
    const expected = "中文编码验证-上海123";
    const command = "Write-Output ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('5Lit5paH57yW56CB6aqM6K+BLeS4iua1tzEyMw==')))";
    const script = [
      `import { PersistentShellSession } from ${JSON.stringify(shellSessionModuleUrl)};`,
      "const session = new PersistentShellSession('powershell.exe', process.cwd());",
      `const result = await session.execute(${JSON.stringify(command)}, { timeoutMs: 10000 });`,
      "await session.dispose();",
      "process.stdout.write(JSON.stringify({",
      "  stdout: result.stdout,",
      "  base64: Buffer.from(result.stdout, 'utf8').toString('base64'),",
      "}) + '\\n');",
    ].join("\n");

    const hiddenResult = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "-e", script], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("close", (code) => {
        resolve({
          code,
          stdout,
          stderr,
        });
      });
    });

    expect(hiddenResult.code, hiddenResult.stderr).toBe(0);
    const payload = JSON.parse(hiddenResult.stdout.trim()) as {
      stdout: string;
      base64: string;
    };
    expect(payload.stdout).toBe(expected);
    expect(payload.base64).toBe(Buffer.from(expected, "utf8").toString("base64"));
  });
});
