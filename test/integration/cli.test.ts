import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function runProcess(command: string, args: string[]): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "pipe",
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stdout,
        stderr,
      });
    });
  });
}

describe("CLI 入口", () => {
  it("通过 tsx 执行时会输出帮助信息", async () => {
    const result = await runProcess(process.execPath, [
      path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(repoRoot, "src", "cli", "index.ts"),
      "--help",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("QAgent CLI");
  });

  it("`resume --help` 会输出帮助，而不是被当成 sessionId", async () => {
    const result = await runProcess(process.execPath, [
      path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(repoRoot, "src", "cli", "index.ts"),
      "resume",
      "--help",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("QAgent CLI");
    expect(result.stderr).not.toContain("sessionId");
  });
});
