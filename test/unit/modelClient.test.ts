import { ReadableStream } from "node:stream/web";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OpenAICompatibleModelClient,
  buildModelHeaders,
} from "../../src/model/openaiCompatibleModelClient.js";
import type { RuntimeConfig } from "../../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
    },
  });
}

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

  it("流式响应兼容 CRLF 分隔，并在 EOF 时处理最后一个 SSE 事件", async () => {
    const config: RuntimeConfig["model"] = {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "openai-key",
      model: "gpt-4.1-mini",
      temperature: 0.2,
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createSseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\r\n\r\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\r\n\r\n",
        "data: {\"choices\":[{\"finish_reason\":\"stop\",\"delta\":{}}]}\r\n\r\n",
        "data: [DONE]",
      ]),
    );

    const client = new OpenAICompatibleModelClient(config);
    const hooks = {
      onTextStart: vi.fn(),
      onTextDelta: vi.fn(),
      onTextComplete: vi.fn(),
    };

    const result = await client.runTurn({
      systemPrompt: "test",
      messages: [],
      tools: [],
    }, hooks);

    expect(result.assistantText).toBe("你好");
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe("stop");
    expect(hooks.onTextStart).toHaveBeenCalledOnce();
    expect(hooks.onTextDelta).toHaveBeenNthCalledWith(1, "你");
    expect(hooks.onTextDelta).toHaveBeenNthCalledWith(2, "好");
    expect(hooks.onTextComplete).toHaveBeenCalledWith("你好");
  });
});
