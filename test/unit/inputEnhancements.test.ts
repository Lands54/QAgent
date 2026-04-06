import { describe, expect, it } from "vitest";

import type { LlmMessage, SkillManifest } from "../../src/types.js";
import {
  buildAutocompleteCandidates,
  completeInput,
  extractUserInputHistory,
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
    const result = completeInput("/ex", []);

    expect(result).toEqual({
      nextValue: "/exit",
      hint: "补全: /exit",
    });
  });

  it("补全存在多个候选时会返回提示", () => {
    const result = completeInput("/tool confirm ", []);

    expect(result.nextValue).toBe("/tool confirm ");
    expect(result.hint).toContain("/tool confirm always");
    expect(result.hint).toContain("/tool confirm risky");
    expect(result.hint).toContain("/tool confirm never");
  });

  it("会包含新的 memory save 命令模板", () => {
    const candidates = buildAutocompleteCandidates([]);

    expect(candidates).toContain("/memory save --name= --description=");
  });

  it("会把 skill 名称加入动态补全候选", () => {
    const skills = [
      createSkill("pdf-processing", "处理 PDF"),
      createSkill("api-testing", "测试接口"),
    ];

    const candidates = buildAutocompleteCandidates(skills);
    const result = completeInput("/skills show api", skills);

    expect(candidates).toContain("/skills show api-testing");
    expect(result).toEqual({
      nextValue: "/skills show api-testing",
      hint: "补全: /skills show api-testing",
    });
  });
});
