export const SpanStatusCode = {
  OK: 0,
  ERROR: 1,
} as const;

export type SpanStatusCode = (typeof SpanStatusCode)[keyof typeof SpanStatusCode];

export type SpanAttributeValue = string | number | boolean;

export interface SpanOptions {
  parent?: Span;
  attributes?: Record<string, SpanAttributeValue>;
}

export interface Span {
  readonly name: string;
  setAttribute(key: string, value: SpanAttributeValue): void;
  addEvent(name: string, attributes?: Record<string, SpanAttributeValue>): void;
  setStatus(code: SpanStatusCode, message?: string): void;
  end(): void;
}

export interface Tracer {
  startSpan(name: string, options?: SpanOptions): Span;
}

export interface TracingConfig {
  tracer: Tracer;
}
