import chalk from "chalk";

const CHARACTERS =
  process.env.TERM === "xterm-ghostty"
    ? ["·", "✢", "✳", "✶", "✻", "*"]
    : process.platform === "darwin"
      ? ["·", "✢", "✳", "✶", "✻", "✽"]
      : ["·", "✢", "*", "✶", "✻", "✽"];

const FRAMES = [...CHARACTERS, ...CHARACTERS.slice().reverse()];
const FRAME_MS = 120;

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export interface Spinner {
  stop(): void;
}

export function startSpinner(label = "Thinking"): Spinner {
  const start = Date.now();
  let frameIdx = 0;
  let lastFrameTime = start;

  const write = () => {
    const now = Date.now();
    if (now - lastFrameTime >= FRAME_MS) {
      frameIdx = (frameIdx + 1) % FRAMES.length;
      lastFrameTime = now;
    }
    const glyph = chalk.cyan(FRAMES[frameIdx]);
    const elapsed = chalk.dim(formatElapsed(now - start));
    process.stderr.write(`  ${glyph} ${chalk.dim(label)}  ${elapsed}\r`);
  };

  write();
  const interval = setInterval(write, 50);

  return {
    stop() {
      clearInterval(interval);
      process.stderr.write("\x1b[2K\r");
    },
  };
}
