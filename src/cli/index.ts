import { render } from "ink";
import { createElement } from "react";

import { createAppController } from "../runtime/index.js";
import type { CliOptions } from "../types.js";
import { App } from "../ui/index.js";

function printHelp(): void {
  console.log(`QAgent CLI

用法:
  qagent
  qagent "帮我查看当前目录结构"
  qagent resume [sessionId]
  qagent --cwd <path> --provider <openai|openrouter> --model <model> --config <path>

参数:
  --cwd <path>      指定项目工作目录
  --provider <id>   指定模型 provider
  --config <path>   指定额外配置文件
  --model <model>   覆盖模型名称
  -h, --help        显示帮助
`);
}

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current) {
      continue;
    }

    if (current === "-h" || current === "--help") {
      options.help = true;
      continue;
    }

    if (current === "--cwd") {
      options.cwd = argv[index + 1];
      index += 1;
      continue;
    }

    if (current === "--config") {
      options.configPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (current === "--provider") {
      const provider = argv[index + 1];
      if (provider === "openai" || provider === "openrouter") {
        options.provider = provider;
      }
      index += 1;
      continue;
    }

    if (current === "--model") {
      options.model = argv[index + 1];
      index += 1;
      continue;
    }

    if (current === "resume") {
      options.resumeSessionId = argv[index + 1] ?? "latest";
      if (argv[index + 1]) {
        index += 1;
      }
      continue;
    }

    positionals.push(current);
  }

  if (positionals.length > 0) {
    options.initialPrompt = positionals.join(" ");
  }

  return options;
}

export async function runCli(argv: string[]): Promise<void> {
  const cliOptions = parseCliArgs(argv);
  if (cliOptions.help) {
    printHelp();
    return;
  }

  const controller = await createAppController(cliOptions);
  const app = render(createElement(App, { controller }));

  try {
    if (cliOptions.initialPrompt) {
      await controller.submitInput(cliOptions.initialPrompt);
    }
    await controller.waitForExit();
  } finally {
    app.unmount();
    await controller.dispose();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
