import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const sessionServicePath = path.resolve(
  currentDir,
  "../../src/session/sessionService.ts",
);

describe("SessionService 源码文本", () => {
  it("错误提示和用户可见文本应直接使用中文源码，而不是 Unicode 转义", async () => {
    const content = await readFile(sessionServicePath, "utf8");

    expect(content).not.toMatch(/\\u[0-9a-fA-F]{4}/u);
  });
});
