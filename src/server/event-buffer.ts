import type { ServerResponse } from "node:http";
import type { StreamEvent } from "../session/types.js";
import type { SessionState, BufferedEvent } from "./session-state.js";

export const MAX_EVENT_BUFFER = 1000;

/**
 * Serialize a StreamEvent to a JSON-safe object. Error instances are
 * converted to `{ message, name }` since `JSON.stringify(new Error())`
 * produces `{}`.
 */
export function serializeEvent(event: StreamEvent): Record<string, unknown> {
  if (event.type === "error") {
    return { type: "error", error: { message: event.error.message, name: event.error.name } };
  }
  if (event.type === "retry_exhausted") {
    return { ...event, error: { message: event.error.message, name: event.error.name } };
  }
  if (event.type === "retry_attempt") {
    return { ...event, error: { message: event.error.message, name: event.error.name } };
  }
  return event as unknown as Record<string, unknown>;
}

/**
 * Push a stream event into the session's buffer, incrementing the sequence
 * number and writing to the live SSE response if one is attached.
 */
export function pushEvent(session: SessionState, event: StreamEvent): void {
  session.sequenceNum++;
  const seq = session.sequenceNum;

  if (session.eventBuffer.length >= MAX_EVENT_BUFFER) {
    session.eventBuffer.shift();
  }
  session.eventBuffer.push({ seq, event });

  if (session.sseResponse) {
    writeSseEventRaw(session.sseResponse, seq, serializeEvent(event));
  }
}

/**
 * Return buffered events whose sequence number is greater than `afterSeq`.
 */
export function getBufferedEventsAfter(
  buffer: BufferedEvent[],
  afterSeq: number,
): BufferedEvent[] {
  if (!afterSeq) return [...buffer];
  return buffer.filter((e) => e.seq > afterSeq);
}

export function writeSseEventRaw(
  res: ServerResponse,
  seq: number,
  data: Record<string, unknown>,
): void {
  res.write(`id: ${seq}\ndata: ${JSON.stringify(data)}\n\n`);
}
