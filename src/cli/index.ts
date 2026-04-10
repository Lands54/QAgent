import { render } from "ink";
import { createElement } from "react";

import {
  formatCommandResultText,
  parseCliInvocation,
} from "../command/index.js";
import {
  serveEdge,
  getEdgeStatus,
  stopEdge,
} from "../edge/index.js";
import {
  BackendClientController,
  getGatewayStatus,
  serveGateway,
  stopGateway,
} from "../gateway/index.js";
import { App } from "../ui/index.js";

function printHelp(): void {
  console.log(`QAgent CLI

用法:
  qagent                         显示帮助
  qagent "帮我查看当前目录结构"   以 CLI run 快捷方式执行 prompt
  qagent tui [prompt]            进入 TUI，可选带初始 prompt
  qagent resume [sessionId]
  qagent run <prompt> [--json|--stream]
  qagent <domain> <subcommand> [--json|--stream]
  qagent --cwd <path> --provider <openai|openrouter> --model <model>
  qagent --transport <local|remote> --workspace <id> --edge-url <url> --api-token <token>

常用命令:
  qagent run "帮我总结当前项目结构"
  qagent work status
  qagent work new feature-a
  qagent bookmark list
  qagent executor list
  qagent gateway status
  qagent gateway stop
  qagent edge serve
  qagent edge status
  qagent memory list
  qagent approval status
  qagent approval approve <checkpointId>

参数:
  --cwd <path>      指定项目工作目录
  --provider <id>   指定模型 provider
  --config <path>   指定额外配置文件
  --model <model>   覆盖模型名称
  --transport <m>   选择 local 或 remote backend
  --workspace <id>  指定远程 workspaceId
  --edge-url <url>  指定 Edge API 地址
  --api-token <t>   指定远程 API Token
  --json            以 JSON 输出单次命令结果
  --stream          以 NDJSON 流式输出 runtime events
  -h, --help        显示帮助
`);
}

export async function runCli(argv: string[]): Promise<void> {
  const invocation = parseCliInvocation(argv);
  if (invocation.error) {
    console.error(invocation.error);
    printHelp();
    process.exitCode = 2;
    return;
  }

  if (invocation.mode === "help") {
    printHelp();
    return;
  }

  if (invocation.mode === "gateway") {
    if (invocation.gatewayAction === "serve") {
      await serveGateway(invocation.cliOptions);
      return;
    }
    if (invocation.gatewayAction === "status") {
      const status = await getGatewayStatus(invocation.cliOptions);
      if (!status.manifest) {
        process.stdout.write("gateway: stopped\n");
        return;
      }
      process.stdout.write(
        [
          `gateway: ${status.health ? "running" : "stale"}`,
          `pid: ${status.manifest.pid}`,
          `url: ${status.manifest.baseUrl}`,
          `cwd: ${status.manifest.cwd}`,
          `log: ${status.health?.logPath ?? status.manifest.logPath ?? "N/A"}`,
        ].join("\n") + "\n",
      );
      process.exitCode = status.health ? 0 : 1;
      return;
    }
    if (invocation.gatewayAction === "stop") {
      const stopped = await stopGateway(invocation.cliOptions);
      process.stdout.write(`${stopped ? "gateway stopped" : "gateway not running"}\n`);
      return;
    }
  }

  if (invocation.mode === "edge") {
    if (invocation.edgeAction === "serve") {
      await serveEdge(invocation.cliOptions);
      return;
    }
    if (invocation.edgeAction === "status") {
      const status = await getEdgeStatus(invocation.cliOptions);
      if (!status.manifest) {
        process.stdout.write("edge: stopped\n");
        return;
      }
      process.stdout.write(
        [
          `edge: ${status.health ? "running" : "stale"}`,
          `pid: ${status.manifest.pid}`,
          `url: ${status.manifest.baseUrl}`,
          `version: ${status.manifest.version}`,
        ].join("\n") + "\n",
      );
      process.exitCode = status.health ? 0 : 1;
      return;
    }
    if (invocation.edgeAction === "stop") {
      const stopped = await stopEdge(invocation.cliOptions);
      process.stdout.write(`${stopped ? "edge stopped" : "edge not running"}\n`);
      return;
    }
  }

  const controller = await BackendClientController.create({
    cliOptions: invocation.cliOptions,
    clientLabel: invocation.mode === "tui" ? "tui" : "cli",
  });

  if (invocation.mode === "tui") {
    const app = render(createElement(App, { controller }));

    try {
      if (invocation.cliOptions.initialPrompt) {
        await controller.submitInput(invocation.cliOptions.initialPrompt);
      }
      await Promise.race([
        controller.waitForExit(),
        app.waitUntilExit(),
      ]);
    } finally {
      app.unmount();
      await controller.dispose();
    }
    return;
  }

  const unsubscribeRuntimeEvents = invocation.output === "stream"
    ? controller.subscribeRuntimeEvents((event) => {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      })
    : undefined;

  try {
    const result = await controller.executeCommand(invocation.request!);

    if (invocation.output === "json") {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (invocation.output === "text") {
      const formatted = formatCommandResultText(result);
      if (formatted.trim().length > 0) {
        process.stdout.write(`${formatted}\n`);
      }
    }
    process.exitCode = result.exitCode;
  } finally {
    unsubscribeRuntimeEvents?.();
    await controller.dispose();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
