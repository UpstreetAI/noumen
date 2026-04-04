"use client";

import { useEffect, useRef, useState } from "react";

const LINES: {
  prompt?: string;
  text?: string;
  delay: number;
  accent?: boolean;
}[] = [
  { prompt: '$ const thread = code.createThread()', delay: 0 },
  { prompt: '$ for await (const ev of thread.run("Add a health-check endpoint"))', delay: 800 },
  { text: '  [tool] ReadFile  server.ts', delay: 600 },
  { text: '  [tool] EditFile  server.ts', delay: 500 },
  { text: '  [tool] Bash      npm test', delay: 700 },
  { text: '  [result] All 14 tests passed', delay: 500, accent: true },
  { text: '  turn_complete  tokens: 3,241  calls: 3', delay: 400 },
];

const Cursor = () => (
  <span className="ml-1 inline-block h-4 w-2 translate-y-[2px] animate-pulse bg-[var(--color-accent-blue)]" />
);

function TerminalLine({
  line,
  visible,
  isCurrent,
}: {
  line: (typeof LINES)[number];
  visible: boolean;
  isCurrent: boolean;
}) {
  const vis = visible ? "opacity-100" : "opacity-0";

  if (line.prompt) {
    return (
      <div className={`flex gap-2 transition-opacity duration-150 ${vis}`}>
        <span className="select-none text-[var(--color-accent-blue)]">{">"}</span>
        <span className="text-[var(--color-text-primary)]">
          {line.prompt.replace("$ ", "")}
          {isCurrent && <Cursor />}
        </span>
      </div>
    );
  }

  return (
    <div
      className={`transition-opacity duration-150 ${vis} ${
        line.accent
          ? "text-[var(--color-success)]"
          : "text-[var(--color-text-secondary)]"
      }`}
    >
      {line.text}
      {isCurrent && <Cursor />}
    </div>
  );
}

export function HeroTerminal() {
  const [visibleCount, setVisibleCount] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !startedRef.current) {
          startedRef.current = true;
          let totalDelay = 0;
          LINES.forEach((line, i) => {
            totalDelay += line.delay;
            setTimeout(() => setVisibleCount(i + 1), totalDelay);
          });
        }
      },
      { threshold: 0.3 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-base-body)] p-5 font-mono text-sm leading-7 shadow-2xl"
    >
      <div className="mb-4 flex items-center gap-2">
        <div className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <div className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <div className="h-3 w-3 rounded-full bg-[#28c840]" />
        <span className="ml-2 text-xs text-[var(--color-text-tertiary)]">
          noumen
        </span>
      </div>
      <div className="relative space-y-1">
        {visibleCount === 0 && (
          <div className="absolute top-0 left-0">
            <Cursor />
          </div>
        )}
        {LINES.map((line, i) => (
          <TerminalLine
            key={i}
            line={line}
            visible={i < visibleCount}
            isCurrent={i === visibleCount - 1 && visibleCount < LINES.length}
          />
        ))}
      </div>
    </div>
  );
}
