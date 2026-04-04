"use client";

import { useState } from "react";

const installCmd = "pnpm add noumen";

export function SidebarInstallCTA() {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(installCmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="flex flex-col gap-2 px-2 py-3">
      <p className="text-xs font-medium text-fd-muted-foreground">
        Get started in seconds.
      </p>
      <button
        type="button"
        onClick={copy}
        className="group relative flex cursor-pointer items-center gap-2 rounded-md border border-fd-border bg-fd-background px-3 py-2 text-left text-[11px] font-mono text-fd-muted-foreground transition-colors hover:border-fd-primary/40 hover:text-fd-foreground"
      >
        <span className="truncate">
          <span className="text-fd-primary select-none">$ </span>
          {installCmd}
        </span>
        <span className="ml-auto shrink-0 text-[10px] opacity-0 transition-opacity group-hover:opacity-100">
          {copied ? "Copied!" : "Copy"}
        </span>
      </button>
    </div>
  );
}
