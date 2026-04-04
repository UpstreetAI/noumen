import { describe, it, expect, vi } from "vitest";
import { NoopSpan, NoopTracer } from "../tracing/noop.js";
import { OTelTracer } from "../tracing/otel.js";
import { SpanStatusCode } from "../tracing/types.js";

vi.mock("@opentelemetry/api", () => {
  throw new Error("unavailable");
});

describe("NoopSpan", () => {
  it("constructor sets name, methods don't throw", () => {
    const span = new NoopSpan("test-span");
    expect(span.name).toBe("test-span");
    expect(() => {
      span.setAttribute("k", "v");
      span.addEvent("e", { a: 1 });
      span.setStatus(SpanStatusCode.ERROR, "msg");
      span.end();
    }).not.toThrow();
  });
});

describe("NoopTracer", () => {
  it("startSpan returns a NoopSpan with correct name", () => {
    const tracer = new NoopTracer();
    const span = tracer.startSpan("op");
    expect(span).toBeInstanceOf(NoopSpan);
    expect(span.name).toBe("op");
  });
});

describe("OTelTracer.create", () => {
  it("falls back to NoopTracer when otel not available", async () => {
    const tracer = await OTelTracer.create("svc", "1.0.0");
    expect(tracer).toBeInstanceOf(NoopTracer);
    const span = tracer.startSpan("x");
    expect(span).toBeInstanceOf(NoopSpan);
    expect(span.name).toBe("x");
  });
});
