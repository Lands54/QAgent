import path from "node:path";

export type TestShellFamily = "posix" | "powershell";

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

export function getTestShellFamily(): TestShellFamily {
  return process.platform === "win32" ? "powershell" : "posix";
}

export function getTestShellExecutable(): string {
  return getTestShellFamily() === "powershell"
    ? "powershell.exe"
    : process.env.SHELL ?? "/bin/zsh";
}

export function getCreateDirectoryCommand(targetPath: string): string {
  if (getTestShellFamily() === "powershell") {
    return `New-Item -ItemType Directory -Force -Path '${escapePowerShellSingleQuoted(targetPath)}' | Out-Null`;
  }

  return `mkdir -p "${targetPath}"`;
}

export function getChangeDirectoryCommand(targetPath: string): string {
  if (getTestShellFamily() === "powershell") {
    return `Set-Location '${escapePowerShellSingleQuoted(targetPath)}'`;
  }

  return `cd "${targetPath}"`;
}

export function getPrintWorkingDirectoryCommand(): string {
  if (getTestShellFamily() === "powershell") {
    return "(Get-Location).Path";
  }

  return "pwd";
}

export function getReadFileCommand(targetPath: string): string {
  if (getTestShellFamily() === "powershell") {
    return `Get-Content -Raw '${escapePowerShellSingleQuoted(targetPath)}'`;
  }

  return `cat "${targetPath}"`;
}

export function getPrintTextCommand(text: string): string {
  if (getTestShellFamily() === "powershell") {
    return `Write-Output '${escapePowerShellSingleQuoted(text)}'`;
  }

  return `printf '${text.replace(/'/g, "'\\''")}'`;
}

export function getWriteTextFileCommand(
  targetPath: string,
  content: string,
): string {
  if (getTestShellFamily() === "powershell") {
    const encoded = Buffer.from(content, "utf8").toString("base64");
    return [
      `$__qagentContent = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encoded}'))`,
      `[System.IO.Directory]::CreateDirectory((Split-Path -Parent '${escapePowerShellSingleQuoted(targetPath)}')) | Out-Null`,
      `[System.IO.File]::WriteAllText('${escapePowerShellSingleQuoted(targetPath)}', $__qagentContent, [System.Text.Encoding]::UTF8)`,
    ].join("\n");
  }

  return [
    `mkdir -p "${path.dirname(targetPath)}"`,
    `cat > "${targetPath}" <<'EOF'`,
    content,
    "EOF",
  ].join("\n");
}

export function normalizeShellPath(rawPath: string): string {
  return path.normalize(rawPath.trim());
}
