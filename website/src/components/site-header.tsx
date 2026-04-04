import Link from "next/link";
import { SnakeEasterEgg } from "@/components/SnakeEasterEgg";

export function SiteHeader() {
  return (
    <nav className="border-b border-[var(--color-border-default)] bg-[var(--color-base-body)]/80 backdrop-blur-xl sticky top-0 z-50">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 h-14">
        <div className="flex items-center gap-2 font-[family-name:var(--font-display)] font-bold text-lg tracking-tight text-[var(--color-text-primary)]">
          <SnakeEasterEgg />
          <Link href="/" className="hover:opacity-80 transition-opacity">
            noumen
          </Link>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <Link
            href="/docs"
            className="text-sm text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
          >
            Docs
          </Link>
          <a
            href="https://github.com/UpstreetAI/noumen"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
          >
            GitHub
          </a>
          <a
            href="https://www.npmjs.com/package/noumen"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
          >
            npm
          </a>
        </div>
      </div>
    </nav>
  );
}
