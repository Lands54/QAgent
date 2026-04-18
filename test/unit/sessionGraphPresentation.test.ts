import { describe, expect, it } from "vitest";

import { buildSessionGraphRows } from "../../src/ui/presentation/sessionGraph.js";

describe("buildSessionGraphRows", () => {
  it("会把 active 节点、refs 与 merge 父节点数渲染到行文本中", () => {
    const rows = buildSessionGraphRows([
      {
        id: "node_merge",
        kind: "message",
        parentNodeIds: ["node_main", "node_feature"],
        refs: ["branch:main", "head:main"],
        summaryTitle: "合并 feature 分支结果",
        createdAt: "2026-01-01T00:03:00.000Z",
      },
      {
        id: "node_feature",
        kind: "message",
        parentNodeIds: ["node_main"],
        refs: ["branch:feature"],
        summaryTitle: "feature 方案分支",
        createdAt: "2026-01-01T00:02:00.000Z",
      },
      {
        id: "node_main",
        kind: "root",
        parentNodeIds: [],
        refs: ["tag:baseline"],
        summaryTitle: "初始化会话",
        createdAt: "2026-01-01T00:01:00.000Z",
      },
    ], {
      activeNodeId: "node_merge",
    });

    expect(rows[0]?.text).toContain("@");
    expect(rows[0]?.text).toContain("合并 feature 分支结果");
    expect(rows[0]?.text).toContain("parents:2");
    expect(rows[0]?.text).toContain("b:main");
    expect(rows[0]?.tone).toBe("active");
    expect(rows[2]?.text).toContain("初始化会话");
    expect(rows[2]?.text).toContain("t:baseline");
  });

  it("在没有节点时返回占位文案", () => {
    const rows = buildSessionGraphRows([]);

    expect(rows).toEqual([
      {
        key: "session-graph-empty",
        text: "还没有可展示的会话图节点。",
        tone: "muted",
      },
    ]);
  });
});
