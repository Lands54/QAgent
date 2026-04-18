const SSE_EVENT_BOUNDARY = /\r?\n\r?\n/u;

export function takeSseEvents(
  buffer: string,
  flush = false,
): {
  events: string[];
  remainder: string;
} {
  const events: string[] = [];
  let remainder = buffer;

  while (true) {
    const match = SSE_EVENT_BOUNDARY.exec(remainder);
    if (!match || match.index === undefined) {
      break;
    }

    events.push(remainder.slice(0, match.index));
    remainder = remainder.slice(match.index + match[0].length);
  }

  if (flush && remainder.trim().length > 0) {
    events.push(remainder);
    remainder = "";
  }

  return {
    events,
    remainder,
  };
}

export function extractSseEventData(rawEvent: string): string {
  return rawEvent
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => {
      const data = line.slice("data:".length);
      return data.startsWith(" ") ? data.slice(1) : data;
    })
    .join("");
}
