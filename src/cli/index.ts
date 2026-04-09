import { render } from "ink";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";

import {
  formatCommandResultText,
  parseCliInvocation,
} from "../command/index.js";
import {
  GatewayClientController,
  getGatewayStatus,
  serveGateway,
  stopGateway,
} from "../gateway/index.js";
import { App } from "../ui/index.js";

function printHelp(): void {
  console.log(`QAgent CLI

用法:
  qagent
  qagent "帮我查看当前目录结构"
  qagent resume [sessionId]
  qagent run <prompt> [--json|--stream]
  qagent <domain> <subcommand> [--json|--stream]
  qagent --cwd <path> --provider <openai|openrouter> --model <model>

常用命令:
  qagent run "帮我总结当前项目结构"
  qagent work status
  qagent work new feature-a
  qagent bookmark list
  qagent executor list
  qagent gateway status
  qagent gateway stop
  qagent memory list
  qagent approval status
  qagent approval approve <checkpointId>

参数:
  --cwd <path>      指定项目工作目录
  --provider <id>   指定模型 provider
  --config <path>   指定额外配置文件
  --model <model>   覆盖模型名称
  --json            以 JSON 输出单次命令结果
  --stream          以 NDJSON 流式输出 runtime events
  -h, --help        显示帮助
`);
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }

  return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entryPath);
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

  const controller = await GatewayClientController.create({
    cliOptions: invocation.cliOptions,
    clientLabel: invocation.mode === "tui" ? "tui" : "cli",
  });

  if (invocation.mode === "tui") {
    const app = render(createElement(App, { controller }));

    try {
      if (invocation.cliOptions.initialPrompt) {
        await controller.submitInput(invocation.cliOptions.initialPrompt);
      }
      await controller.waitForExit();
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

if (isMainModule()) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
