import { describe, expect, it } from "vitest";

import { buildModelHeaders } from "../../src/model/openaiCompatibleModelClient.js";
import type { RuntimeConfig } from "../../src/types.js";

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
});
