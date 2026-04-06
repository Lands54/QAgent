import type { ModelClient, RuntimeConfig } from "../types.js";
import { OpenAICompatibleModelClient } from "./openaiCompatibleModelClient.js";

export function createModelClient(config: RuntimeConfig["model"]): ModelClient {
  switch (config.provider) {
    case "openrouter":
    case "openai":
    default:
      return new OpenAICompatibleModelClient(config);
  }
}
