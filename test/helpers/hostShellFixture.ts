import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type TestShellFamily = "posix" | "powershell";

export interface HostShellFixture {
  family: TestShellFamily;
  executable: string;
  printWorkingDirectoryCommand: string;
  buildChangeDirectoryCommand: (targetPath: string) => string;
  buildMakeDirectoryCommand: (targetPath: string) => string;
  buildReadFileCommand: (targetPath: string) => string;
  buildWriteFileCommand: (targetPath: string, content: string) => string;
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function buildPosixFixture(executable: string): HostShellFixture {
  return {
    family: "posix",
    executable,
    printWorkingDirectoryCommand: "pwd",
    buildChangeDirectoryCommand: (targetPath) => `cd ${quotePosix(targetPath)}`,
    buildMakeDirectoryCommand: (targetPath) => `mkdir -p ${quotePosix(targetPath)}`,
    buildReadFileCommand: (targetPath) => `cat ${quotePosix(targetPath)}`,
    buildWriteFileCommand: (targetPath, content) => {
      return [
        `mkdir -p ${quotePosix(path.dirname(targetPath))}`,
        `cat > ${quotePosix(targetPath)} <<'EOF'`,
        content,
        "EOF",
      ].join("\n");
    },
  };
}

function buildPowerShellFixture(executable: string): HostShellFixture {
  return {
    family: "powershell",
    executable,
    printWorkingDirectoryCommand: "(Get-Location).Path",
    buildChangeDirectoryCommand: (targetPath) => {
      return `Set-Location -LiteralPath ${quotePowerShell(targetPath)}`;
    },
    buildMakeDirectoryCommand: (targetPath) => {
      return `New-Item -ItemType Directory -Force -Path ${quotePowerShell(targetPath)} | Out-Null`;
    },
    buildReadFileCommand: (targetPath) => {
      return `Get-Content -Raw -LiteralPath ${quotePowerShell(targetPath)}`;
    },
    buildWriteFileCommand: (targetPath, content) => {
      const lines = content.split("\n").map((line) => quotePowerShell(line)).join(", ");
      return [
        `$target = ${quotePowerShell(targetPath)}`,
        "$directory = Split-Path -Parent $target",
        "New-Item -ItemType Directory -Force -Path $directory | Out-Null",
        `$content = @(${lines}) -join [Environment]::NewLine`,
        "[System.IO.File]::WriteAllText($target, $content, [System.Text.UTF8Encoding]::new($false))",
      ].join("\n");
    },
  };
}

function resolveWindowsPosixShell(): string | undefined {
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files\\Git\\bin\\sh.exe",
    "C:\\msys64\\usr\\bin\\bash.exe",
    "C:\\cygwin64\\bin\\bash.exe",
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export function getNativeHostShellFixture(): HostShellFixture {
  if (process.platform === "win32") {
    return buildPowerShellFixture("powershell.exe");
  }

  return buildPosixFixture(process.env.SHELL ?? "/bin/zsh");
}

export function getPosixHostShellFixture(): HostShellFixture | undefined {
  if (process.platform === "win32") {
    const executable = resolveWindowsPosixShell();
    return executable ? buildPosixFixture(executable) : undefined;
  }

  return buildPosixFixture(process.env.SHELL ?? "/bin/zsh");
}

export function normalizeShellPath(output: string): string {
  const trimmed = output.trim();
  if (process.platform !== "win32") {
    return trimmed;
  }

  if (trimmed === "/tmp") {
    return path.join(os.tmpdir());
  }
  if (trimmed.startsWith("/tmp/")) {
    return path.join(os.tmpdir(), trimmed.slice("/tmp/".length).replace(/\//gu, path.sep));
  }

  const msysPathMatch = trimmed.match(/^\/([a-zA-Z])\/(.*)$/u);
  if (!msysPathMatch) {
    return trimmed;
  }

  const [, driveLetter, rest] = msysPathMatch;
  return `${driveLetter!.toUpperCase()}:\\${rest!.replace(/\//gu, "\\")}`;
}
