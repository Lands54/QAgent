import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveGatewaySpawnSpec } from "../../src/gateway/gatewayClient.js";

describe("resolveGatewaySpawnSpec", () => {
  it("源码入口会复用 src CLI 来启动后台 gateway", () => {
    const spec = resolveGatewaySpawnSpec(
      pathToFileURL(
        path.join(process.cwd(), "src", "gateway", "gatewayClient.ts"),
      ).href,
    );

    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual([
      path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(process.cwd(), "src", "cli", "index.ts"),
      "gateway",
      "serve",
    ]);
  });

  it("构建产物入口会继续使用 bin 脚本启动后台 gateway", () => {
    const spec = resolveGatewaySpawnSpec(
      pathToFileURL(
        path.join(process.cwd(), "dist", "gateway", "gatewayClient.js"),
      ).href,
    );

    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual([
      path.join(process.cwd(), "bin", "qagent.js"),
      "gateway",
      "serve",
    ]);
  });
});
