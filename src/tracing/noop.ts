import type { Span, SpanAttributeValue, SpanOptions, SpanStatusCode, Tracer } from "./types.js";

export class NoopSpan implements Span {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  setAttribute(_key: string, _value: SpanAttributeValue): void {}
  addEvent(_name: string, _attributes?: Record<string, SpanAttributeValue>): void {}
  setStatus(_code: SpanStatusCode, _message?: string): void {}
  end(): void {}
}

export class NoopTracer implements Tracer {
  startSpan(name: string, _options?: SpanOptions): Span {
    return new NoopSpan(name);
  }
}
