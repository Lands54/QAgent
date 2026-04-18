import type { SessionLogEntry } from "../../types.js";

export interface SessionGraphRow {
  key: string;
  text: string;
  tone?: "active" | "muted" | "default";
}

interface BuildSessionGraphRowsInput {
  activeNodeId?: string;
  maxItems?: number;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function firstLine(value: string, fallback = "未命名"): string {
  const line = normalizeWhitespace(value).split("\n")[0] ?? "";
  return line || fallback;
}

function dedupeIds(ids: string[]): string[] {
  const seen = new Set<string>();
  return ids.filter((id) => {
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

function formatRefs(refs: string[]): string {
  if (refs.length === 0) {
    return "";
  }

  const compactRefs = refs.map((ref) => {
    if (ref.startsWith("branch:")) {
      return `b:${ref.slice("branch:".length)}`;
    }
    if (ref.startsWith("tag:")) {
      return `t:${ref.slice("tag:".length)}`;
    }
    if (ref.startsWith("head:")) {
      return `h:${ref.slice("head:".length)}`;
    }
    return ref;
  });

  return `[${truncate(compactRefs.join(", "), 28)}]`;
}

function buildNodeLabel(node: SessionLogEntry): string {
  const fallback = `${node.kind}:${node.id}`;
  return truncate(firstLine(node.summaryTitle ?? fallback, fallback), 42);
}

function buildMarker(node: SessionLogEntry, activeNodeId?: string): string {
  if (node.id === activeNodeId) {
    return "@";
  }
  if (node.parentNodeIds.length > 1) {
    return "M";
  }
  if (node.kind === "root") {
    return "o";
  }
  return "*";
}

export function buildSessionGraphRows(
  entries: SessionLogEntry[],
  input: BuildSessionGraphRowsInput = {},
): SessionGraphRow[] {
  const maxItems = input.maxItems ?? 18;
  const visibleEntries = [...entries]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, maxItems);

  if (visibleEntries.length === 0) {
    return [
      {
        key: "session-graph-empty",
        text: "还没有可展示的会话图节点。",
        tone: "muted",
      },
    ];
  }

  const visibleIds = new Set(visibleEntries.map((entry) => entry.id));
  const columns: string[] = [];
  const rows: SessionGraphRow[] = [];

  for (const node of visibleEntries) {
    let columnIndex = columns.indexOf(node.id);
    if (columnIndex < 0) {
      columns.unshift(node.id);
      columnIndex = 0;
    }

    const marker = buildMarker(node, input.activeNodeId);
    const graphPrefix = columns
      .map((_, index) => (index === columnIndex ? marker : "|"))
      .join(" ");
    const refs = formatRefs(node.refs);
    const hiddenParents = node.parentNodeIds.filter((parentId) => {
      return !visibleIds.has(parentId);
    }).length;
    const hiddenParentSuffix = hiddenParents > 0 ? `  +upstream:${hiddenParents}` : "";
    const mergeSuffix = node.parentNodeIds.length > 1 ? `  parents:${node.parentNodeIds.length}` : "";

    rows.push({
      key: node.id,
      text: [
        graphPrefix,
        buildNodeLabel(node),
        refs,
        mergeSuffix,
        hiddenParentSuffix,
      ]
        .filter(Boolean)
        .join(" "),
      tone: node.id === input.activeNodeId ? "active" : "default",
    });

    const visibleParents = node.parentNodeIds.filter((parentId) => visibleIds.has(parentId));
    columns.splice(columnIndex, 1, ...visibleParents);
    const nextColumns = dedupeIds(columns);
    columns.length = 0;
    columns.push(...nextColumns);
  }

  return rows;
}
