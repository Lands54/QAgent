import { describe, expect, it } from "vitest";

import {
  extractSseEventData,
  takeSseEvents,
} from "../../src/utils/sse.js";

describe("SSE utils", () => {
  it("兼容 CRLF 事件分隔，并在 flush 时输出尾缓冲", () => {
    const firstPass = takeSseEvents(
      "data: {\"step\":1}\r\n\r\ndata:{\"step\":2}",
    );

    expect(firstPass.events).toEqual([
      "data: {\"step\":1}",
    ]);
    expect(firstPass.remainder).toBe("data:{\"step\":2}");

    const flushed = takeSseEvents(firstPass.remainder, true);

    expect(flushed.events).toEqual([
      "data:{\"step\":2}",
    ]);
    expect(flushed.remainder).toBe("");
  });

  it("支持 data: 和 data: 两种字段写法", () => {
    expect(
      extractSseEventData("event: message\r\ndata: {\"ok\":true}"),
    ).toBe("{\"ok\":true}");
    expect(
      extractSseEventData("id: 1\r\ndata:{\"ok\":true}"),
    ).toBe("{\"ok\":true}");
  });

  it("忽略仅包含注释的 keepalive 帧", () => {
    expect(extractSseEventData(": keepalive")).toBe("");
    expect(extractSseEventData("id: 1\r\n: keepalive")).toBe("");
  });
});
