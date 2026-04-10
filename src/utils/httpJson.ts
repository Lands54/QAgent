import type { IncomingMessage } from "node:http";

export const DEFAULT_JSON_BODY_LIMIT_BYTES = 1_048_576;

export class HttpJsonBodyError extends Error {
  public constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpJsonBodyError";
  }
}

function getContentLength(request: IncomingMessage): number | undefined {
  const raw = request.headers["content-length"];
  if (!raw || Array.isArray(raw)) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function readJsonBody(
  request: IncomingMessage,
  limitBytes = DEFAULT_JSON_BODY_LIMIT_BYTES,
): Promise<unknown> {
  const contentLength = getContentLength(request);
  if (contentLength !== undefined && contentLength > limitBytes) {
    throw new HttpJsonBodyError(413, "请求 body 过大。");
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.byteLength;
    if (receivedBytes > limitBytes) {
      throw new HttpJsonBodyError(413, "请求 body 过大。");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpJsonBodyError(400, "请求 body 不是合法 JSON。");
  }
}
