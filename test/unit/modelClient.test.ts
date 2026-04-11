import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OpenAICompatibleModelClient,
  buildModelHeaders,
} from "../../src/model/openaiCompatibleModelClient.js";
import type { RuntimeConfig } from "../../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildModelHeaders", () => {
  it("为 OpenRouter 构建带专用 header 的请求头", () => {
    const config: RuntimeConfig["model"] = {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "or-key",
      model: "openai/gpt-4.1-mini",
      temperature: 0.2,
      appName: "QAgent Test",
      appUrl: "https://example.com/qagent",
    };

    const headers = buildModelHeaders(config);

    expect(headers.authorization).toBe("Bearer or-key");
    expect(headers["X-OpenRouter-Title"]).toBe("QAgent Test");
    expect(headers["HTTP-Referer"]).toBe("https://example.com/qagent");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("OpenAI provider 不注入 OpenRouter 专用 header", () => {
    const config: RuntimeConfig["model"] = {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "openai-key",
      model: "gpt-4.1-mini",
      temperature: 0.2,
    };

    const headers = buildModelHeaders(config);

    expect(headers.authorization).toBe("Bearer openai-key");
    expect(headers["X-OpenRouter-Title"]).toBeUndefined();
    expect(headers["HTTP-Referer"]).toBeUndefined();
  });

  it("模型请求超过 requestTimeoutMs 会主动 abort", async () => {
    const config: RuntimeConfig["model"] = {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "openai-key",
      model: "gpt-4.1-mini",
      temperature: 0.2,
      requestTimeoutMs: 10,
    };
    vi.spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(signal.reason);
        }, { once: true });
      });
    }) as typeof fetch);

    const client = new OpenAICompatibleModelClient(config);

    await expect(client.runTurn({
      systemPrompt: "test",
      messages: [],
      tools: [],
    })).rejects.toThrow("模型请求超时");
  });

  it("模型 fetch 失败时会带上请求定位信息", async () => {
    const config: RuntimeConfig["model"] = {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "openrouter-key",
      model: "openai/gpt-4.1-mini",
      temperature: 0.2,
    };
    const cause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      address: "127.0.0.1",
      port: 443,
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed", { cause }),
    );

    const client = new OpenAICompatibleModelClient(config);

    await expect(client.runTurn({
      systemPrompt: "test",
      messages: [],
      tools: [],
    })).rejects.toThrow(
      [
        "模型请求失败：网络或传输层错误。",
        "provider=openrouter",
        "model=openai/gpt-4.1-mini",
        "endpoint=https://openrouter.ai/api/v1/chat/completions",
        "error=fetch failed",
        "cause=Error: connect ECONNREFUSED",
      ].join("\n"),
    );
  });
});
