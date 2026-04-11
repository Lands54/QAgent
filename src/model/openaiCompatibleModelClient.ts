import type {
  LlmMessage,
  ModelClient,
  ModelStreamHooks,
  ModelTurnRequest,
  ModelTurnResult,
  RuntimeConfig,
  ToolCall,
} from "../types.js";
import { createId } from "../utils/index.js";

const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 120_000;

interface OpenAIStreamToolCallBuffer {
  id?: string;
  name?: string;
  arguments: string;
}

function createModelRequestSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): {
  signal?: AbortSignal;
  cleanup(): void;
} {
  const resolvedTimeoutMs = timeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
  if (resolvedTimeoutMs <= 0) {
    return {
      signal,
      cleanup: () => {},
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`模型请求超时：${resolvedTimeoutMs}ms`));
  }, resolvedTimeoutMs);
  timeout.unref?.();

  const abortFromParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(signal?.reason);
    }
  };
  if (signal?.aborted) {
    abortFromParent();
  } else {
    signal?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromParent);
    },
  };
}

export function buildModelHeaders(
  config: RuntimeConfig["model"],
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }

  if (config.provider === "openrouter") {
    headers["X-OpenRouter-Title"] = config.appName ?? "QAgent CLI";
    if (config.appUrl) {
      headers["HTTP-Referer"] = config.appUrl;
    }
  }

  return headers;
}

function toOpenAIMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      name: message.name,
      content: message.content,
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.input),
        },
      })),
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

function finalizeToolCalls(
  buffers: Map<number, OpenAIStreamToolCallBuffer>,
): ToolCall[] {
  return Array.from(buffers.values()).map((buffer) => {
    const parsed = JSON.parse(buffer.arguments || "{}") as {
      command?: string;
      reasoning?: string;
    };
    if (!buffer.name) {
      throw new Error("模型返回了缺少名称的工具调用");
    }
    if (!parsed.command) {
      throw new Error("模型返回的工具调用缺少 command");
    }

    return {
      id: buffer.id ?? createId("toolcall"),
      name: "shell",
      createdAt: new Date().toISOString(),
      input: {
        command: parsed.command,
        reasoning: parsed.reasoning,
      },
    };
  });
}

function emitWholeText(text: string, hooks?: ModelStreamHooks): void {
  if (!text) {
    return;
  }
  hooks?.onTextStart?.();
  hooks?.onTextDelta?.(text);
  hooks?.onTextComplete?.(text);
}

function causeDetail(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("cause" in error)) {
    return undefined;
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  if (typeof cause === "string") {
    return cause;
  }
  if (cause && typeof cause === "object") {
    const fields = ["code", "syscall", "hostname", "host", "port", "address"];
    const details = fields
      .map((field) => {
        const value = (cause as Record<string, unknown>)[field];
        return value === undefined ? undefined : `${field}=${String(value)}`;
      })
      .filter(Boolean);
    return details.length > 0 ? details.join(" ") : JSON.stringify(cause);
  }
  return undefined;
}

function formatModelTransportError(
  config: RuntimeConfig["model"],
  endpoint: string,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = causeDetail(error);
  return [
    "模型请求失败：网络或传输层错误。",
    `provider=${config.provider}`,
    `model=${config.model}`,
    `endpoint=${endpoint}`,
    `error=${message}`,
    cause ? `cause=${cause}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export class OpenAICompatibleModelClient implements ModelClient {
  public constructor(private readonly config: RuntimeConfig["model"]) {}

  public async runTurn(
    request: ModelTurnRequest,
    hooks?: ModelStreamHooks,
    signal?: AbortSignal,
  ): Promise<ModelTurnResult> {
    const requestSignal = createModelRequestSignal(signal, this.config.requestTimeoutMs);
    const endpoint = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    try {
      const response = await fetch(
        endpoint,
        {
          method: "POST",
          headers: buildModelHeaders(this.config),
          body: JSON.stringify({
            model: this.config.model,
            temperature: this.config.temperature,
            max_tokens: this.config.maxTokens,
            stream: true,
            messages: [
              {
                role: "system",
                content: request.systemPrompt,
              },
              ...request.messages.map(toOpenAIMessage),
            ],
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }),
          signal: requestSignal.signal,
        },
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `模型请求失败：HTTP ${response.status} ${response.statusText}\n${errorBody}`,
        );
      }

      if (!response.body) {
        const data = (await response.json()) as Record<string, unknown>;
        return this.parseJsonResponse(data, hooks);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        const data = (await response.json()) as Record<string, unknown>;
        return this.parseJsonResponse(data, hooks);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf8");
      const toolBuffers = new Map<number, OpenAIStreamToolCallBuffer>();
      let buffer = "";
      let finished = false;
      let assistantText = "";
      let finishReason = "stop";
      let textStarted = false;

    const handleData = (raw: string) => {
      if (!raw) {
        return;
      }
      if (raw === "[DONE]") {
        finished = true;
        return;
      }

      const payload = JSON.parse(raw) as {
        choices?: Array<{
          finish_reason?: string | null;
          delta?: {
            content?: string;
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: {
                name?: string;
                arguments?: string;
              };
            }>;
          };
        }>;
      };

      const choice = payload.choices?.[0];
      if (!choice?.delta) {
        return;
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      if (choice.delta.content) {
        if (!textStarted) {
          hooks?.onTextStart?.();
          textStarted = true;
        }
        assistantText += choice.delta.content;
        hooks?.onTextDelta?.(choice.delta.content);
      }

      for (const toolCall of choice.delta.tool_calls ?? []) {
        const existing = toolBuffers.get(toolCall.index) ?? {
          arguments: "",
        };
        if (toolCall.id) {
          existing.id = toolCall.id;
        }
        if (toolCall.function?.name) {
          existing.name = toolCall.function.name;
        }
        if (toolCall.function?.arguments) {
          existing.arguments += toolCall.function.arguments;
        }
        toolBuffers.set(toolCall.index, existing);
      }
    };

    while (!finished) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        handleData(data);
        boundary = buffer.indexOf("\n\n");
      }
    }

    if (assistantText) {
      hooks?.onTextComplete?.(assistantText);
    }

      return {
        assistantText,
        toolCalls: finalizeToolCalls(toolBuffers),
        finishReason,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      if (
        error instanceof Error
        && (
          error.message.startsWith("模型请求失败：HTTP")
          || error.message.startsWith("模型返回")
        )
      ) {
        throw error;
      }
      throw new Error(formatModelTransportError(this.config, endpoint, error));
    } finally {
      requestSignal.cleanup();
    }
  }

  private parseJsonResponse(
    data: Record<string, unknown>,
    hooks?: ModelStreamHooks,
  ): ModelTurnResult {
    const choice = (data.choices as Array<Record<string, unknown>> | undefined)?.[0];
    const message = choice?.message as
      | {
          content?: string | null;
          tool_calls?: Array<{
            id?: string;
            function?: {
              name?: string;
              arguments?: string;
            };
          }>;
        }
      | undefined;

    const assistantText = message?.content ?? "";
    emitWholeText(assistantText, hooks);

    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((toolCall) => {
      const parsed = JSON.parse(toolCall.function?.arguments ?? "{}") as {
        command?: string;
        reasoning?: string;
      };

      if (!parsed.command) {
        throw new Error("模型返回的工具调用缺少 command");
      }

      return {
        id: toolCall.id ?? createId("toolcall"),
        name: "shell",
        createdAt: new Date().toISOString(),
        input: {
          command: parsed.command,
          reasoning: parsed.reasoning,
        },
      };
    });

    return {
      assistantText,
      toolCalls,
      finishReason: String(choice?.finish_reason ?? "stop"),
    };
  }
}
