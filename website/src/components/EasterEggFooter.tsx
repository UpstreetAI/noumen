"use client";

import { useState, useEffect } from "react";

export function EasterEggFooter() {
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    try {
      setSeen(localStorage.getItem("noumen-seen-serpent") === "1");
    } catch {}

    const handler = () => setSeen(true);
    window.addEventListener("noumen-serpent-seen", handler);
    return () => window.removeEventListener("noumen-serpent-seen", handler);
  }, []);

  return (
    <p className="text-xs text-[var(--color-text-tertiary)]">
      🐍 &copy; {new Date().getFullYear()} noumen &mdash;{" "}
      {seen ? "the serpent remembers" : "MIT License"}
    </p>
  );
}
