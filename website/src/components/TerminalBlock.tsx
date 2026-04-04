"use client";

import { useState, useCallback } from "react";

export function TerminalBlock({
  command,
  className = "",
}: {
  command: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [command]);

  return (
    <div
      className={`group relative flex items-center gap-3 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-base-surface)] px-4 py-3 font-mono text-xs transition hover:border-[var(--color-accent-blue-dim)] sm:px-5 sm:py-4 sm:text-sm ${className}`}
    >
      <span className="select-none text-[var(--color-accent-blue)]">$</span>
      <code className="min-w-0 flex-1 overflow-x-hidden whitespace-nowrap text-[var(--color-text-primary)]">
        {command}
      </code>
      <button
        onClick={copy}
        className="shrink-0 cursor-pointer rounded-md p-1.5 text-[var(--color-text-tertiary)] transition hover:bg-[var(--color-base-card)] hover:text-[var(--color-text-primary)]"
        aria-label="Copy to clipboard"
      >
        {copied ? (
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="3.5 8.5 6 11 12.5 4.5" />
          </svg>
        ) : (
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="5" y="5" width="8" height="8" rx="1.5" />
            <path d="M3 11V3.5A.5.5 0 013.5 3H11" />
          </svg>
        )}
      </button>
    </div>
  );
}
