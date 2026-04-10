import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const srcRoot = path.join(workspaceRoot, "src");
const typesFile = path.join(srcRoot, "types.ts");
const sourceExtensions = new Set([".ts", ".tsx"]);

const allowedModuleDeps = new Map<string, Set<string>>([
  ["cli", new Set(["command", "edge", "gateway", "runtime", "types", "ui"])],
  ["command", new Set(["types", "utils"])],
  ["config", new Set(["types", "utils"])],
  ["context", new Set(["types", "utils"])],
  ["edge", new Set(["config", "gateway", "types", "utils"])],
  ["memory", new Set(["types", "utils"])],
  ["model", new Set(["types", "utils"])],
  [
    "gateway",
    new Set([
      "command",
      "config",
      "context",
      "edge",
      "memory",
      "model",
      "runtime",
      "session",
      "skills",
      "tool",
      "types",
      "utils",
    ]),
  ],
  [
    "runtime",
    new Set([
      "config",
      "command",
      "context",
      "memory",
      "model",
      "session",
      "skills",
      "tool",
      "types",
      "utils",
    ]),
  ],
  ["session", new Set(["types", "utils"])],
  ["skills", new Set(["types", "utils"])],
  ["tool", new Set(["types", "utils"])],
  ["ui", new Set(["runtime", "types"])],
  ["utils", new Set()],
  ["types", new Set()],
]);

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function listSourceFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        return listSourceFiles(entryPath);
      }
      if (
        entry.isFile() &&
        sourceExtensions.has(path.extname(entry.name)) &&
        !entry.name.endsWith(".d.ts")
      ) {
        return [entryPath];
      }
      return [];
    }),
  );

  return files.flat().sort((left, right) => left.localeCompare(right));
}

function parseRelativeImports(source: string): string[] {
  const matches = source.matchAll(
    /\b(?:import|export)\b[\s\S]*?\bfrom\s+["']([^"']+)["']/gu,
  );
  const specifiers = [...matches].map((match) => match[1]).filter(Boolean);
  const bareImportMatches = source.matchAll(/^\s*import\s+["']([^"']+)["'];?$/gmu);

  for (const match of bareImportMatches) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }

  return specifiers.filter((specifier) => specifier.startsWith("."));
}

async function resolveSourceImport(
  fromFile: string,
  specifier: string,
): Promise<string | undefined> {
  const basePath = path.resolve(path.dirname(fromFile), specifier);
  const normalized = basePath.replace(/\.(?:js|jsx|mjs|cjs)$/u, "");
  const candidates = [
    `${normalized}.ts`,
    `${normalized}.tsx`,
    path.join(normalized, "index.ts"),
    path.join(normalized, "index.tsx"),
  ];

  for (const candidate of candidates) {
    if (
      candidate.startsWith(srcRoot) &&
      sourceExtensions.has(path.extname(candidate)) &&
      (await pathExists(candidate))
    ) {
      return candidate;
    }
  }

  return undefined;
}

function moduleNameForFile(filePath: string): string {
  const relativePath = path.relative(srcRoot, filePath);
  const segments = relativePath.split(path.sep);
  if (segments.length === 1) {
    return segments[0]!.replace(/\.(?:ts|tsx)$/u, "");
  }

  return segments[0]!;
}

function facadePathForModule(moduleName: string): string {
  if (moduleName === "types") {
    return typesFile;
  }

  return path.join(srcRoot, moduleName, "index.ts");
}

function internalLayerForFile(
  filePath: string,
): "root" | "application" | "domain" | "presentation" | "infrastructure" | "other" {
  const relativePath = path.relative(srcRoot, filePath);
  const segments = relativePath.split(path.sep);
  if (segments.length < 2) {
    return "root";
  }
  const layer = segments[1];
  if (
    layer === "application"
    || layer === "domain"
    || layer === "presentation"
    || layer === "infrastructure"
  ) {
    return layer;
  }
  return "root";
}

async function collectSourceGraph(): Promise<Map<string, string[]>> {
  const files = await listSourceFiles(srcRoot);
  const graph = new Map<string, string[]>();

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const specifiers = parseRelativeImports(source);
    const imports = await Promise.all(
      specifiers.map((specifier) => resolveSourceImport(file, specifier)),
    );
    graph.set(
      file,
      imports.filter((target): target is string => Boolean(target)),
    );
  }

  return graph;
}

function detectCycle(graph: Map<string, string[]>): string[] | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const walk = (node: string): string[] | undefined => {
    if (visiting.has(node)) {
      const cycleStart = stack.indexOf(node);
      return [...stack.slice(cycleStart), node];
    }
    if (visited.has(node)) {
      return undefined;
    }

    visiting.add(node);
    stack.push(node);

    for (const next of graph.get(node) ?? []) {
      const cycle = walk(next);
      if (cycle) {
        return cycle;
      }
    }

    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return undefined;
  };

  for (const node of graph.keys()) {
    const cycle = walk(node);
    if (cycle) {
      return cycle;
    }
  }

  return undefined;
}

describe("Architecture Boundaries", () => {
  it("每个顶层模块都提供 facade index.ts", async () => {
    const entries = await readdir(srcRoot, { withFileTypes: true });
    const moduleDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

    for (const moduleDir of moduleDirs) {
      const facadePath = path.join(srcRoot, moduleDir, "index.ts");
      expect(
        await pathExists(facadePath),
        `模块 ${moduleDir} 缺少 facade 文件：${path.relative(workspaceRoot, facadePath)}`,
      ).toBe(true);
    }
  });

  it("跨模块导入必须通过 facade，并且遵守模块依赖白名单", async () => {
    const graph = await collectSourceGraph();
    const violations: string[] = [];

    for (const [fromFile, imports] of graph.entries()) {
      const fromModule = moduleNameForFile(fromFile);
      const allowedDeps = allowedModuleDeps.get(fromModule);
      expect(allowedDeps, `模块 ${fromModule} 未配置依赖白名单`).toBeDefined();

      for (const targetFile of imports) {
        const targetModule = moduleNameForFile(targetFile);
        if (fromModule === targetModule) {
          continue;
        }

        const allowedFacade = facadePathForModule(targetModule);
        if (targetFile !== allowedFacade) {
          violations.push(
            [
              `${path.relative(workspaceRoot, fromFile)} -> ${path.relative(workspaceRoot, targetFile)}`,
              `应改为通过 ${path.relative(workspaceRoot, allowedFacade)} 访问模块 ${targetModule}`,
            ].join(" | "),
          );
        }

        if (!allowedDeps?.has(targetModule)) {
          violations.push(
            `${path.relative(workspaceRoot, fromFile)} 不允许依赖模块 ${targetModule}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("runtime/session/ui 的内部层级目录已经建立", async () => {
    const expectedDirs = [
      path.join(srcRoot, "runtime", "application"),
      path.join(srcRoot, "runtime", "domain"),
      path.join(srcRoot, "session", "application"),
      path.join(srcRoot, "session", "domain"),
      path.join(srcRoot, "ui", "presentation"),
    ];

    for (const dir of expectedDirs) {
      expect(
        await pathExists(dir),
        `缺少内部层级目录：${path.relative(workspaceRoot, dir)}`,
      ).toBe(true);
    }
  });

  it("模块内部层级遵守单向依赖约束", async () => {
    const graph = await collectSourceGraph();
    const violations: string[] = [];

    for (const [fromFile, imports] of graph.entries()) {
      const fromModule = moduleNameForFile(fromFile);
      if (!["runtime", "session", "ui"].includes(fromModule)) {
        continue;
      }
      const fromLayer = internalLayerForFile(fromFile);

      for (const targetFile of imports) {
        const targetModule = moduleNameForFile(targetFile);
        if (fromModule !== targetModule) {
          continue;
        }
        const targetLayer = internalLayerForFile(targetFile);
        const relativeFrom = path.relative(workspaceRoot, fromFile);
        const relativeTarget = path.relative(workspaceRoot, targetFile);

        if (fromLayer === "domain" && (targetLayer === "application" || targetLayer === "presentation")) {
          violations.push(`${relativeFrom} 不应依赖更高层：${relativeTarget}`);
        }
        if (fromLayer === "application" && targetLayer === "presentation") {
          violations.push(`${relativeFrom} 不应依赖 presentation：${relativeTarget}`);
        }
        if (fromLayer === "presentation" && targetLayer === "application") {
          violations.push(`${relativeFrom} 不应回跳到 application：${relativeTarget}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("AppController 是 runtime 唯一组合根", async () => {
    const runtimeFiles = await listSourceFiles(path.join(srcRoot, "runtime"));
    const compositionPatterns = [
      "new SessionService(",
      "new SkillRegistry(",
      "createModelClient(",
      "new AgentManager(",
    ];
    const violations: string[] = [];

    for (const file of runtimeFiles) {
      const source = await readFile(file, "utf8");
      const matchesPattern = compositionPatterns.some((pattern) => {
        return source.includes(pattern);
      });
      if (!matchesPattern) {
        continue;
      }
      if (path.relative(srcRoot, file) !== path.join("runtime", "appController.ts")) {
        violations.push(path.relative(workspaceRoot, file));
      }
    }

    expect(violations).toEqual([]);
  });

  it("源码不得直接修改 snapshot 的投影缓存或统一时间线数组", async () => {
    const files = await listSourceFiles(srcRoot);
    const violations: string[] = [];
    const forbiddenPatterns = [
      /(?:^|[^\w])[\w.]+\.(?:uiMessages|modelMessages|conversationEntries)\s*=/gu,
      /(?:^|[^\w])[\w.]+\.(?:uiMessages|modelMessages|conversationEntries)\.(?:push|pop|shift|unshift|splice)\s*\(/gu,
    ];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const matched = forbiddenPatterns.some((pattern) => pattern.test(source));
      if (!matched) {
        continue;
      }
      violations.push(path.relative(workspaceRoot, file));
    }

    expect(violations).toEqual([]);
  });

  it("源码文件之间不存在循环依赖", async () => {
    const graph = await collectSourceGraph();
    const cycle = detectCycle(graph);

    expect(
      cycle?.map((file) => path.relative(workspaceRoot, file)).join(" -> "),
    ).toBeUndefined();
  });
});
