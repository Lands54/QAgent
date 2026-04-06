export function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

export function tokenize(value: string): string[] {
  return normalizeWhitespace(value)
    .toLowerCase()
    .split(/[^a-z0-9_\u4e00-\u9fff-]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function firstLine(value: string, fallback = "未命名"): string {
  const line = normalizeWhitespace(value).split("\n")[0] ?? "";
  return line || fallback;
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(1)}s`;
}
