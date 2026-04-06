import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface ShellExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  cwd: string;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  termination?: "timeout" | "cancelled";
}

interface ExecuteOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

interface PendingExecution {
  markerId: string;
  stdout: string;
  stderr: string;
  startedAt: string;
  startedAtMs: number;
  resolve: (result: ShellExecutionResult) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
  signal?: AbortSignal;
  cleanupSignal?: () => void;
  termination?: "timeout" | "cancelled";
}

export class PersistentShellSession {
  private shell?: ChildProcessWithoutNullStreams;
  private pending?: PendingExecution;
  private currentCwd: string;

  public constructor(
    private readonly executable: string,
    cwd: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.currentCwd = cwd;
  }

  public getCurrentCwd(): string {
    return this.currentCwd;
  }

  public async execute(
    command: string,
    options: ExecuteOptions,
  ): Promise<ShellExecutionResult> {
    await this.ensureStarted();
    if (!this.shell) {
      throw new Error("shell 会话未启动");
    }
    if (this.pending) {
      throw new Error("shell 正忙，请稍后再试");
    }

    const markerId = `qagent_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const startedAt = new Date().toISOString();

    return new Promise<ShellExecutionResult>((resolve, reject) => {
      const pending: PendingExecution = {
        markerId,
        stdout: "",
        stderr: "",
        startedAt,
        startedAtMs: Date.now(),
        resolve,
        reject,
        signal: options.signal,
      };

      if (options.timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          if (!this.pending) {
            return;
          }
          this.pending.termination = "timeout";
          this.shell?.stdin.write("\u0003");
        }, options.timeoutMs);
      }

      if (options.signal) {
        const onAbort = () => {
          if (!this.pending) {
            return;
          }
          this.pending.termination = "cancelled";
          this.shell?.stdin.write("\u0003");
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.cleanupSignal = () => {
          options.signal?.removeEventListener("abort", onAbort);
        };
      }

      this.pending = pending;
      const wrapped = `${command}\nprintf "\\n__QAGENT_EXIT__${markerId}__\\t%s\\t%s\\n" "$?" "$PWD"\n`;
      this.shell?.stdin.write(wrapped);
    });
  }

  public async dispose(): Promise<void> {
    this.pending?.cleanupSignal?.();
    this.pending = undefined;

    if (!this.shell) {
      return;
    }

    const shell = this.shell;
    this.shell = undefined;
    shell.stdin.end("exit\n");
  }

  private async ensureStarted(): Promise<void> {
    if (this.shell) {
      return;
    }

    const child = spawn(this.executable, ["-l"], {
      cwd: this.currentCwd,
      env: {
        ...this.env,
        TERM: "dumb",
      },
      stdio: "pipe",
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: string) => this.handleStderr(chunk));
    child.on("exit", (code, signal) => {
      const pending = this.pending;
      if (!pending) {
        return;
      }
      const error = new Error(
        `shell 会话意外退出，code=${code ?? "null"} signal=${signal ?? "null"}`,
      );
      this.cleanupPending();
      pending.reject(error);
    });

    this.shell = child;
  }

  private handleStdout(chunk: string): void {
    if (!this.pending) {
      return;
    }

    this.pending.stdout += chunk;
    const marker = `__QAGENT_EXIT__${this.pending.markerId}__\t`;
    const markerIndex = this.pending.stdout.indexOf(marker);
    if (markerIndex === -1) {
      return;
    }

    const lineEnd = this.pending.stdout.indexOf("\n", markerIndex);
    if (lineEnd === -1) {
      return;
    }

    const markerLine = this.pending.stdout.slice(markerIndex, lineEnd).trim();
    const match = markerLine.match(
      /^__QAGENT_EXIT__.+__\t(?<exitCode>-?\d+)\t(?<cwd>.+)$/u,
    );
    if (!match?.groups) {
      return;
    }

    const stdout = this.pending.stdout.slice(0, markerIndex).replace(/\n$/, "");
    const stderr = this.pending.stderr.replace(/\n$/, "");
    const exitCode = Number(match.groups.exitCode ?? "1");
    const cwd = match.groups.cwd ?? this.currentCwd;
    const result: ShellExecutionResult = {
      stdout,
      stderr,
      exitCode,
      cwd,
      durationMs: Date.now() - this.pending.startedAtMs,
      startedAt: this.pending.startedAt,
      finishedAt: new Date().toISOString(),
      termination: this.pending.termination,
    };

    this.currentCwd = cwd;
    const resolve = this.pending.resolve;
    this.cleanupPending();
    resolve(result);
  }

  private handleStderr(chunk: string): void {
    if (!this.pending) {
      return;
    }

    this.pending.stderr += chunk;
  }

  private cleanupPending(): void {
    if (!this.pending) {
      return;
    }

    if (this.pending.timeout) {
      clearTimeout(this.pending.timeout);
    }
    this.pending.cleanupSignal?.();
    this.pending = undefined;
  }
}
