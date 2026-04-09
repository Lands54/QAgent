import { describe, expect, it } from "vitest";

import type { LlmMessage, SkillManifest } from "../../src/types.js";
import {
  buildAutocompleteCandidates,
  completeInput,
  extractUserInputHistory,
  getCompletionPreview,
  navigateInputHistory,
} from "../../src/ui/inputEnhancements.js";

function createUserMessage(id: string, content: string): LlmMessage {
  return {
    id,
    role: "user",
    content,
    createdAt: new Date().toISOString(),
  };
}

function createAssistantMessage(id: string, content: string): LlmMessage {
  return {
    id,
    role: "assistant",
    content,
    createdAt: new Date().toISOString(),
  };
}

function createSkill(name: string, description: string): SkillManifest {
  return {
    id: `project:${name}`,
    name,
    description,
    scope: "project",
    directoryPath: `/tmp/project/.agent/skills/${name}`,
    filePath: `/tmp/project/.agent/skills/${name}/SKILL.md`,
    content: `# ${name}`,
  };
}

describe("inputEnhancements", () => {
  it("只提取用户历史输入并忽略空内容", () => {
    const history = extractUserInputHistory([
      createUserMessage("user-1", "  查看项目结构  "),
      createAssistantMessage("assistant-1", "好的"),
      createUserMessage("user-2", " "),
      createUserMessage("user-3", "/session status"),
    ]);

    expect(history).toEqual(["查看项目结构", "/session status"]);
  });

  it("支持上下浏览历史并恢复草稿", () => {
    const history = ["第一条", "第二条", "第三条"];

    const step1 = navigateInputHistory(
      "正在输入的新内容",
      history,
      { index: null, draft: "" },
      "up",
    );
    expect(step1.nextValue).toBe("第三条");
    expect(step1.nextState).toEqual({
      index: 2,
      draft: "正在输入的新内容",
    });

    const step2 = navigateInputHistory(
      step1.nextValue,
      history,
      step1.nextState,
      "up",
    );
    expect(step2.nextValue).toBe("第二条");
    expect(step2.nextState).toEqual({
      index: 1,
      draft: "正在输入的新内容",
    });

    const step3 = navigateInputHistory(
      step2.nextValue,
      history,
      step2.nextState,
      "down",
    );
    expect(step3.nextValue).toBe("第三条");
    expect(step3.nextState).toEqual({
      index: 2,
      draft: "正在输入的新内容",
    });

    const step4 = navigateInputHistory(
      step3.nextValue,
      history,
      step3.nextState,
      "down",
    );
    expect(step4.nextValue).toBe("正在输入的新内容");
    expect(step4.nextState).toEqual({
      index: null,
      draft: "",
    });
  });

  it("Tab 时能唯一补全 slash 命令", () => {
    const result = completeInput("/cle", []);

    expect(result.nextValue).toBe("/clear");
    expect(result.hint).toContain("/clear");
  });

  it("补全存在多个候选时会返回提示", () => {
    const result = completeInput("/tool confirm ", []);

    expect(result.nextValue).toBe("/tool confirm ");
    const preview = getCompletionPreview("/tool confirm ", []);

    expect(result.hint).toContain("Tab");
    expect(result.cycleQuery).toBe("/tool confirm ");
    expect(preview.suggestions.map((item) => item.value)).toContain("/tool confirm always");
    expect(preview.suggestions.map((item) => item.value)).toContain("/tool confirm risky");
    expect(preview.suggestions.map((item) => item.value)).toContain("/tool confirm never");
  });

  it("会包含新的 memory save 命令模板", () => {
    const candidates = buildAutocompleteCandidates([]);

    expect(candidates).toContain("/memory save --name= --description=");
  });

  it("会包含新的 work / bookmark 命令模板", () => {
    const candidates = buildAutocompleteCandidates([]);

    expect(candidates).toContain("/session commit -m ");
    expect(candidates).toContain("/work status");
    expect(candidates).toContain("/work new ");
    expect(candidates).toContain("/bookmark switch ");
    expect(candidates).toContain("/session graph log --limit=");
    expect(candidates).not.toContain("/session fork ");
    expect(candidates).not.toContain("/session checkout ");
  });

  it("bookmark 补全预览会显示明确占位，而不是依赖尾随空格区分", () => {
    const preview = getCompletionPreview("/bookmark tag", []);

    expect(preview.suggestions.map((item) => item.displayValue ?? item.value)).toContain(
      "/bookmark tag <name>",
    );
  });

  it("会包含 helper agent debug 命令模板", () => {
    const candidates = buildAutocompleteCandidates([]);

    expect(candidates).toContain("/debug helper-agent status");
    expect(candidates).toContain("/debug helper-agent autocleanup off");
    expect(candidates).toContain("/debug helper-agent clear");
    expect(candidates).toContain("/debug legacy clear");
  });

  it("会把 skill 名称加入动态补全候选", () => {
    const skills = [
      createSkill("pdf-processing", "处理 PDF"),
      createSkill("api-testing", "测试接口"),
    ];

    const candidates = buildAutocompleteCandidates(skills);
    const result = completeInput("/skills show api", skills);

    expect(candidates).toContain("/skills show api-testing");
    expect(result.nextValue).toBe("/skills show api-testing");
    expect(result.hint).toContain("/skills show api-testing");
  });

  it("空输入时会给出默认推荐命令", () => {
    const preview = getCompletionPreview("", []);

    expect(preview.mode).toBe("idle");
    expect(preview.suggestions.map((item) => item.value)).toContain("/help");
    expect(preview.suggestions.map((item) => item.value)).toContain("/work status");
    expect(preview.hint).toContain("待机态");
  });

  it("重复按 Tab 时会在多个候选之间轮换", () => {
    const step1 = completeInput("/work ", [], 0);
    const step2 = completeInput(
      "/work ",
      [],
      step1.nextSuggestionIndex,
      step1.cycleQuery,
    );
    const step3 = completeInput(
      step2.nextValue,
      [],
      step2.nextSuggestionIndex,
      step2.cycleQuery,
    );

    expect(step1.nextValue).toBe("/work ");
    expect(step1.cycleQuery).toBe("/work ");
    expect(step2.nextValue).not.toBe(step1.nextValue);
    expect(step3.nextValue).not.toBe(step2.nextValue);
    expect(step2.hint).toContain("补全:");
    expect(step3.hint).toContain("补全:");
  });
});
