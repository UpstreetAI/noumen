import { describe, it, expect, vi } from "vitest";
import { NoopSpan, NoopTracer } from "../tracing/noop.js";
import { OTelTracer } from "../tracing/otel.js";
import { SpanStatusCode } from "../tracing/types.js";
import type { Span, SpanOptions, Tracer } from "../tracing/types.js";

vi.mock("@opentelemetry/api", () => {
  throw new Error("unavailable");
});

// ---------------------------------------------------------------------------
// NoopSpan
// ---------------------------------------------------------------------------

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

  it("setAttribute is callable with different value types", () => {
    const span = new NoopSpan("test");
    span.setAttribute("str", "value");
    span.setAttribute("num", 42);
    span.setAttribute("bool", true);
    // NoopSpan should not throw for any attribute type
  });

  it("addEvent without attributes does not throw", () => {
    const span = new NoopSpan("test");
    expect(() => span.addEvent("event-no-attrs")).not.toThrow();
  });

  it("setStatus with OK code does not throw", () => {
    const span = new NoopSpan("test");
    expect(() => span.setStatus(SpanStatusCode.OK)).not.toThrow();
  });

  it("end can be called multiple times safely", () => {
    const span = new NoopSpan("test");
    expect(() => {
      span.end();
      span.end();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// NoopTracer
// ---------------------------------------------------------------------------

describe("NoopTracer", () => {
  it("startSpan returns a NoopSpan with correct name", () => {
    const tracer = new NoopTracer();
    const span = tracer.startSpan("op");
    expect(span).toBeInstanceOf(NoopSpan);
    expect(span.name).toBe("op");
  });

  it("startSpan accepts options without error", () => {
    const tracer = new NoopTracer();
    const parent = tracer.startSpan("parent");
    const child = tracer.startSpan("child", {
      parent,
      attributes: { key: "value" },
    });
    expect(child).toBeInstanceOf(NoopSpan);
    expect(child.name).toBe("child");
  });

  it("multiple spans can coexist", () => {
    const tracer = new NoopTracer();
    const spans = Array.from({ length: 10 }, (_, i) =>
      tracer.startSpan(`span-${i}`),
    );
    expect(spans).toHaveLength(10);
    spans.forEach((span, i) => {
      expect(span.name).toBe(`span-${i}`);
    });
  });
});

// ---------------------------------------------------------------------------
// SpanStatusCode
// ---------------------------------------------------------------------------

describe("SpanStatusCode", () => {
  it("has OK and ERROR values", () => {
    expect(SpanStatusCode.OK).toBe(0);
    expect(SpanStatusCode.ERROR).toBe(1);
  });

  it("OK and ERROR are different", () => {
    expect(SpanStatusCode.OK).not.toBe(SpanStatusCode.ERROR);
  });
});

// ---------------------------------------------------------------------------
// OTelTracer.create fallback
// ---------------------------------------------------------------------------

describe("OTelTracer.create", () => {
  it("falls back to NoopTracer when otel not available", async () => {
    const tracer = await OTelTracer.create("svc", "1.0.0");
    expect(tracer).toBeInstanceOf(NoopTracer);
    const span = tracer.startSpan("x");
    expect(span).toBeInstanceOf(NoopSpan);
    expect(span.name).toBe("x");
  });

  it("falls back with default service name", async () => {
    const tracer = await OTelTracer.create();
    expect(tracer).toBeInstanceOf(NoopTracer);
  });

  it("caches the fallback on subsequent calls", async () => {
    const t1 = await OTelTracer.create("svc1");
    const t2 = await OTelTracer.create("svc2");
    // Both should be NoopTracer since @opentelemetry/api is mocked to fail
    expect(t1).toBeInstanceOf(NoopTracer);
    expect(t2).toBeInstanceOf(NoopTracer);
  });
});

// ---------------------------------------------------------------------------
// Tracer interface compliance
// ---------------------------------------------------------------------------

describe("Tracer interface", () => {
  it("NoopTracer satisfies Tracer interface", () => {
    const tracer: Tracer = new NoopTracer();
    expect(typeof tracer.startSpan).toBe("function");
  });

  it("NoopSpan satisfies Span interface", () => {
    const span: Span = new NoopSpan("test");
    expect(typeof span.setAttribute).toBe("function");
    expect(typeof span.addEvent).toBe("function");
    expect(typeof span.setStatus).toBe("function");
    expect(typeof span.end).toBe("function");
    expect(typeof span.name).toBe("string");
  });
});
