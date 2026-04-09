import type { ReactNode } from "react";

const VARIANTS = {
  info: {
    color: "#60a5fa",
    bg: "rgba(96, 165, 250, 0.05)",
    icon: "i",
    fontStyle: "italic" as const,
  },
  warn: {
    color: "#f59e0b",
    bg: "rgba(245, 158, 11, 0.05)",
    icon: "!",
    fontStyle: "normal" as const,
  },
  error: {
    color: "#ef4444",
    bg: "rgba(239, 68, 68, 0.05)",
    icon: "\u00d7",
    fontStyle: "normal" as const,
  },
  tip: {
    color: "#22d3ee",
    bg: "rgba(34, 211, 238, 0.05)",
    icon: "\u2713",
    fontStyle: "normal" as const,
  },
} as const;

type CalloutType = keyof typeof VARIANTS;

interface CalloutProps {
  type?: CalloutType;
  title?: string;
  children: ReactNode;
}

export function Callout({ type = "info", title, children }: CalloutProps) {
  const v = VARIANTS[type];

  return (
    <div
      className="not-prose relative my-6 overflow-visible rounded-lg"
      style={{ background: v.bg }}
    >
      {/* Thick left accent line — starts below the connector curve */}
      <div
        className="absolute left-0 bottom-0 rounded-b-full"
        style={{
          top: 46,
          width: 3,
          background: v.color,
          borderRadius: "0 0 1.5px 1.5px",
        }}
      />

      {/* Circle icon + S-curve connector (fixed-size SVG) */}
      <svg
        aria-hidden="true"
        className="absolute pointer-events-none"
        width="40"
        height="56"
        style={{ left: -7, top: -8 }}
      >
        {/* Connector curve from circle bottom to the vertical line */}
        <path
          d="M 20 30 C 20 44, 7 40, 7 54"
          fill="none"
          stroke={v.color}
          strokeWidth="3"
          strokeLinecap="round"
        />
        {/* Solid disc behind circle to mask the box corner */}
        <circle cx="20" cy="16" r="15" fill="var(--color-fd-background, #09090b)" />
        {/* Circle outline */}
        <circle
          cx="20"
          cy="16"
          r="13"
          fill="none"
          stroke={v.color}
          strokeWidth="2"
        />
        {/* Icon glyph */}
        <text
          x="20"
          y="16.5"
          textAnchor="middle"
          dominantBaseline="central"
          fill={v.color}
          fontSize="15"
          fontWeight="700"
          fontStyle={v.fontStyle}
          fontFamily="Georgia, 'Times New Roman', serif"
        >
          {v.icon}
        </text>
      </svg>

      {/* Content area */}
      <div className="py-5 pr-5 pl-9">
        {title && (
          <p className="mb-2 text-[0.95rem] font-semibold text-fd-foreground">
            {title}
          </p>
        )}
        <div className="callout-body text-sm leading-relaxed text-fd-muted-foreground">
          {children}
        </div>
      </div>
    </div>
  );
}
