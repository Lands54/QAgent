import { appendFile } from "node:fs/promises";
import path from "node:path";

import type { CommandRequest } from "../types.js";
import { ensureDir } from "../utils/index.js";

export type GatewayLogFields = Record<string, boolean | number | string | null | undefined>;
type GatewayLogLevel = "info" | "warn" | "error";

interface GatewayLogSink {
  write(message: string): unknown;
}

export function getGatewayLogPath(projectAgentDir: string): string {
  return path.join(projectAgentDir, "logs", "gateway.log");
}

export function gatewayErrorFields(error: unknown): GatewayLogFields {
  if (error instanceof Error) {
    const cause = "cause" in error
      ? (error as Error & { cause?: unknown }).cause
      : undefined;
    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
      causeName: cause instanceof Error ? cause.name : undefined,
      causeMessage: cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : undefined,
      causeCode:
        cause && typeof cause === "object" && "code" in cause
          ? String((cause as { code?: unknown }).code ?? "")
          : undefined,
    };
  }
  return {
    errorName: "Error",
    errorMessage: String(error),
  };
}

export function commandRequestLogFields(request: CommandRequest): GatewayLogFields {
  return {
    commandDomain: request.domain,
    commandAction: "action" in request ? String(request.action) : undefined,
  };
}

export class GatewayLogger {
  private writeQueue = Promise.resolve();

  public constructor(
    private readonly logPath: string,
    private readonly mirror: GatewayLogSink = process.stderr,
  ) {}

  public getLogPath(): string {
    return this.logPath;
  }

  public info(event: string, fields: GatewayLogFields = {}): void {
    this.write("info", event, fields);
  }

  public warn(event: string, fields: GatewayLogFields = {}): void {
    this.write("warn", event, fields);
  }

  public error(event: string, fields: GatewayLogFields = {}): void {
    this.write("error", event, fields);
  }

  public async flush(): Promise<void> {
    await this.writeQueue;
  }

  private write(
    level: GatewayLogLevel,
    event: string,
    fields: GatewayLogFields,
  ): void {
    const line = `${JSON.stringify({
      createdAt: new Date().toISOString(),
      level,
      event,
      pid: process.pid,
      ...compactFields(fields),
    })}\n`;

    this.mirror.write(line);
    this.writeQueue = this.writeQueue
      .then(async () => {
        await ensureDir(path.dirname(this.logPath));
        await appendFile(this.logPath, line, "utf8");
      })
      .catch((error: unknown) => {
        this.mirror.write(`${JSON.stringify({
          createdAt: new Date().toISOString(),
          level: "error",
          event: "gateway.log.write_failed",
          pid: process.pid,
          ...gatewayErrorFields(error),
        })}\n`);
      });
  }
}

function compactFields(fields: GatewayLogFields): GatewayLogFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}
