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
  cleanupSignal?: () => void;
  termination?: "timeout" | "cancelled";
}

interface ShellSessionAdapter {
  readonly family: "posix" | "powershell";
  getSpawnArgs(): string[];
  wrapCommand(command: string, markerId: string): string;
}

class PosixShellAdapter implements ShellSessionAdapter {
  public readonly family = "posix" as const;

  public getSpawnArgs(): string[] {
    return ["-l"];
  }

  public wrapCommand(command: string, markerId: string): string {
    return `${command}\nprintf "\\n__QAGENT_EXIT__${markerId}__\\t%s\\t%s\\n" "$?" "$PWD"\n`;
  }
}

class PowerShellAdapter implements ShellSessionAdapter {
  public readonly family = "powershell" as const;

  public getSpawnArgs(): string[] {
    return ["-NoLogo", "-NoProfile", "-Command", "-"];
  }

  public wrapCommand(command: string, markerId: string): string {
    // 通过 ASCII 外壳和 Base64 解码执行真实命令，避免 Windows PowerShell 从 stdin 读取脚本时破坏 UTF-8 文本。
    const encodedCommand = Buffer.from(command, "utf8").toString("base64");
    return [
      "$global:LASTEXITCODE = 0",
      `$__qagentCommand = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedCommand}'))`,
      "Invoke-Expression $__qagentCommand",
      "$__qagentExitCode = if ($?) { if ($null -ne $global:LASTEXITCODE) { [int]$global:LASTEXITCODE } else { 0 } } else { if ($null -ne $global:LASTEXITCODE -and [int]$global:LASTEXITCODE -ne 0) { [int]$global:LASTEXITCODE } else { 1 } }",
      `Write-Output "__QAGENT_EXIT__${markerId}__\`t$__qagentExitCode\`t$((Get-Location).Path)"`,
      "",
    ].join("\n");
  }
}

function detectShellAdapter(executable: string): ShellSessionAdapter {
  const basename = executable.split(/[\\/]/u).pop()?.toLowerCase() ?? "";
  if (basename === "powershell" || basename === "powershell.exe" || basename === "pwsh" || basename === "pwsh.exe") {
    return new PowerShellAdapter();
  }

  return new PosixShellAdapter();
}

function parseMarkerOutput(
  stdout: string,
  markerId: string,
): {
  stdout: string;
  exitCode: number;
  cwd: string;
} | undefined {
  const marker = `__QAGENT_EXIT__${markerId}__\t`;
  const markerIndex = stdout.indexOf(marker);
  if (markerIndex === -1) {
    return undefined;
  }

  const lineEnd = stdout.indexOf("\n", markerIndex);
  if (lineEnd === -1) {
    return undefined;
  }

  const markerLine = stdout.slice(markerIndex, lineEnd).trim();
  const match = markerLine.match(/^__QAGENT_EXIT__.+__\t(?<exitCode>-?\d+)\t(?<cwd>.+)$/u);
  if (!match?.groups?.cwd) {
    return undefined;
  }

  return {
    stdout: stdout.slice(0, markerIndex).replace(/\r?\n$/u, ""),
    exitCode: Number(match.groups.exitCode ?? "1"),
    cwd: match.groups.cwd,
  };
}

export class PersistentShellSession {
  private readonly adapter: ShellSessionAdapter;
  private shell?: ChildProcessWithoutNullStreams;
  private pending?: PendingExecution;
  private currentCwd: string;
  private startingShell?: Promise<void>;

  public constructor(
    private readonly executable: string,
    cwd: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.currentCwd = cwd;
    this.adapter = detectShellAdapter(executable);
  }

  public getCurrentCwd(): string {
    return this.currentCwd;
  }

  public async execute(
    command: string,
    options: Partial<ExecuteOptions> = {},
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
    const normalizedOptions: ExecuteOptions = {
      timeoutMs: options.timeoutMs ?? 0,
      signal: options.signal,
    };

    return new Promise<ShellExecutionResult>((resolve, reject) => {
      const pending: PendingExecution = {
        markerId,
        stdout: "",
        stderr: "",
        startedAt,
        startedAtMs: Date.now(),
        resolve,
        reject,
      };

      if (normalizedOptions.timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          void this.terminatePending("timeout");
        }, normalizedOptions.timeoutMs);
      }

      if (normalizedOptions.signal) {
        const onAbort = () => {
          void this.terminatePending("cancelled");
        };
        normalizedOptions.signal.addEventListener("abort", onAbort, { once: true });
        pending.cleanupSignal = () => {
          normalizedOptions.signal?.removeEventListener("abort", onAbort);
        };
      }

      this.pending = pending;
      this.shell?.stdin.write(this.adapter.wrapCommand(command, markerId));
    });
  }

  public async dispose(): Promise<void> {
    if (this.pending) {
      await this.terminatePending(this.pending.termination ?? "cancelled");
    }

    if (!this.shell) {
      return;
    }

    const shell = this.shell;
    this.shell = undefined;
    await new Promise<void>((resolve) => {
      shell.once("close", () => resolve());
      shell.stdin.end("exit\n");
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.shell) {
      return;
    }
    if (this.startingShell) {
      await this.startingShell;
      return;
    }

    this.startingShell = new Promise<void>((resolve, reject) => {
      const child = spawn(this.executable, this.adapter.getSpawnArgs(), {
        cwd: this.currentCwd,
        env: {
          ...this.env,
          TERM: "dumb",
        },
        stdio: "pipe",
        detached: process.platform !== "win32" && this.adapter.family === "posix",
      });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      let settled = false;
      const finishResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        this.shell = child;
        child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
        child.stderr.on("data", (chunk: string) => this.handleStderr(chunk));
        child.on("exit", (code, signal) => {
          this.handleShellExit(code, signal);
        });
        child.on("error", (error) => {
          this.handleShellError(error);
        });
        resolve();
      };
      const finishReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      child.once("spawn", finishResolve);
      child.once("error", (error) => {
        finishReject(new Error(`shell 启动失败：${error.message}`));
      });
      child.once("exit", (code, signal) => {
        finishReject(
          new Error(`shell 启动失败，code=${code ?? "null"} signal=${signal ?? "null"}`),
        );
      });
    });

    try {
      await this.startingShell;
    } finally {
      this.startingShell = undefined;
    }
  }

  private handleStdout(chunk: string): void {
    if (!this.pending) {
      return;
    }

    this.pending.stdout += chunk;
    const parsed = parseMarkerOutput(this.pending.stdout, this.pending.markerId);
    if (!parsed) {
      return;
    }

    const result: ShellExecutionResult = {
      stdout: parsed.stdout,
      stderr: this.pending.stderr.replace(/\r?\n$/u, ""),
      exitCode: parsed.exitCode,
      cwd: parsed.cwd,
      durationMs: Date.now() - this.pending.startedAtMs,
      startedAt: this.pending.startedAt,
      finishedAt: new Date().toISOString(),
      termination: this.pending.termination,
    };

    this.currentCwd = parsed.cwd;
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

  private handleShellExit(code: number | null, signal: NodeJS.Signals | null): void {
    const pending = this.pending;
    this.shell = undefined;
    if (!pending) {
      return;
    }

    const error = new Error(
      `shell 会话意外退出，code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
    this.cleanupPending();
    pending.reject(error);
  }

  private handleShellError(error: Error): void {
    const pending = this.pending;
    this.shell = undefined;
    if (!pending) {
      return;
    }

    this.cleanupPending();
    pending.reject(new Error(`shell 启动失败：${error.message}`));
  }

  private async terminatePending(
    termination: "timeout" | "cancelled",
  ): Promise<void> {
    const pending = this.pending;
    if (!pending) {
      return;
    }

    pending.termination = termination;
    const shell = this.shell;
    this.shell = undefined;
    this.cleanupPending();
    if (shell) {
      await this.killShell(shell);
    }

    pending.resolve({
      stdout: pending.stdout.replace(/\r?\n$/u, ""),
      stderr: pending.stderr.replace(/\r?\n$/u, ""),
      exitCode: null,
      cwd: this.currentCwd,
      durationMs: Date.now() - pending.startedAtMs,
      startedAt: pending.startedAt,
      finishedAt: new Date().toISOString(),
      termination,
    });
  }

  private async killShell(shell: ChildProcessWithoutNullStreams): Promise<void> {
    const pid = shell.pid;
    if (!pid) {
      shell.kill("SIGKILL");
      return;
    }

    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.once("error", () => resolve());
        killer.once("close", () => resolve());
      });
      return;
    }

    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        shell.kill("SIGKILL");
      }
    }

    await new Promise<void>((resolve) => {
      shell.once("close", () => resolve());
    });
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
