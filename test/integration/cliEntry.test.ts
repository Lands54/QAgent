import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "../..");
const tsxCliPath = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const sourceCliPath = path.join(projectRoot, "src", "cli", "index.ts");

describe("CLI source entry", () => {
  it("开发态入口在 --help 下会输出帮助文本", async () => {
    const result = await execFileAsync(
      process.execPath,
      [tsxCliPath, sourceCliPath, "--help"],
      {
        cwd: projectRoot,
      },
    );

    expect(result.stdout).toContain("QAgent CLI");
    expect(result.stdout).toContain("用法:");
  });
});
