"use client";

const SPARKLE_POSITIONS = [
  { top: "12%", left: "8%", delay: "0s", size: "4px" },
  { top: "20%", left: "85%", delay: "0.4s", size: "3px" },
  { top: "45%", left: "92%", delay: "1.2s", size: "5px" },
  { top: "70%", left: "5%", delay: "0.8s", size: "3px" },
  { top: "80%", left: "78%", delay: "1.6s", size: "4px" },
  { top: "35%", left: "15%", delay: "2s", size: "3px" },
  { top: "55%", left: "70%", delay: "0.6s", size: "5px" },
  { top: "15%", left: "50%", delay: "1.4s", size: "3px" },
  { top: "88%", left: "40%", delay: "1.8s", size: "4px" },
  { top: "65%", left: "25%", delay: "0.2s", size: "3px" },
  { top: "30%", left: "60%", delay: "1s", size: "4px" },
  { top: "50%", left: "35%", delay: "2.2s", size: "3px" },
];

export function Sparkles() {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[1] overflow-hidden"
      aria-hidden="true"
    >
      {SPARKLE_POSITIONS.map((s, i) => (
        <div
          key={i}
          className="absolute animate-sparkle rounded-full"
          style={{
            top: s.top,
            left: s.left,
            width: s.size,
            height: s.size,
            animationDelay: s.delay,
            animationDuration: `${2 + (i % 3)}s`,
            background:
              i % 2 === 0
                ? "var(--color-accent-blue)"
                : "var(--color-accent-cyan)",
          }}
        />
      ))}
    </div>
  );
}
