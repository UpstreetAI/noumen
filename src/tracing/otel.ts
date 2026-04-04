import {
  SpanStatusCode,
  type Span,
  type SpanAttributeValue,
  type SpanOptions,
  type Tracer,
} from "./types.js";
import { NoopSpan, NoopTracer } from "./noop.js";

type OTelApi = typeof import("@opentelemetry/api");

let otelApi: OTelApi | null = null;
let otelLoadFailed = false;

async function loadOTelApi(): Promise<OTelApi | null> {
  if (otelApi) return otelApi;
  if (otelLoadFailed) return null;
  try {
    otelApi = await import("@opentelemetry/api");
    return otelApi;
  } catch {
    otelLoadFailed = true;
    return null;
  }
}

class OTelSpan implements Span {
  readonly name: string;
  private inner: import("@opentelemetry/api").Span;

  constructor(name: string, inner: import("@opentelemetry/api").Span) {
    this.name = name;
    this.inner = inner;
  }

  setAttribute(key: string, value: SpanAttributeValue): void {
    this.inner.setAttribute(key, value);
  }

  addEvent(name: string, attributes?: Record<string, SpanAttributeValue>): void {
    this.inner.addEvent(name, attributes);
  }

  setStatus(code: SpanStatusCode, message?: string): void {
    const otelCode = code === SpanStatusCode.ERROR
      ? 2 /* SpanStatusCode.ERROR in OTEL */
      : 1 /* SpanStatusCode.OK in OTEL */;
    this.inner.setStatus({ code: otelCode, message });
  }

  end(): void {
    this.inner.end();
  }

  /** Access the underlying OTEL span for advanced use cases. */
  getInnerSpan(): import("@opentelemetry/api").Span {
    return this.inner;
  }
}

/**
 * Adapter that bridges noumen's `Tracer` interface to an OpenTelemetry
 * `TracerProvider`. The `@opentelemetry/api` package is loaded lazily via
 * dynamic `import()` so it remains an optional peer dependency.
 *
 * Call `OTelTracer.create()` (async factory) to obtain an instance.
 * If `@opentelemetry/api` is not installed, the factory returns a `NoopTracer`.
 */
export class OTelTracer implements Tracer {
  private otelTracer: import("@opentelemetry/api").Tracer;
  private api: OTelApi;

  private constructor(api: OTelApi, otelTracer: import("@opentelemetry/api").Tracer) {
    this.api = api;
    this.otelTracer = otelTracer;
  }

  /**
   * Create an `OTelTracer`. Falls back to `NoopTracer` if
   * `@opentelemetry/api` is not available at runtime.
   */
  static async create(
    serviceName: string = "noumen",
    version?: string,
  ): Promise<Tracer> {
    const api = await loadOTelApi();
    if (!api) return new NoopTracer();
    const tracer = api.trace.getTracer(serviceName, version);
    return new OTelTracer(api, tracer);
  }

  startSpan(name: string, options?: SpanOptions): Span {
    const parentCtx = options?.parent instanceof OTelSpan
      ? this.api.trace.setSpan(this.api.context.active(), options.parent.getInnerSpan())
      : this.api.context.active();

    const otelSpan = this.otelTracer.startSpan(
      name,
      options?.attributes ? { attributes: options.attributes as Record<string, import("@opentelemetry/api").AttributeValue> } : undefined,
      parentCtx,
    );

    return new OTelSpan(name, otelSpan);
  }
}
