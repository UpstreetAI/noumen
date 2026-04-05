"use client";

import { useState, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";

const BACKRONYMS = [
  "not our usual model, evidently nihilistic",
  "nobody owes u meaning, especially noumen",
  "nerds only; u must enjoy nondeterminism",
  "noumen only understands me. everyone else… nevermind",
  "no one understands me, except nodes",
  "ne, onii-chan? u made everything… numb",
  "nothing outside us matters except nothing",
  "nightcore optimization under mass extinction networks",
  "notice our undying machine? eye contact, ne~",
  "new obsession unlocked: mister Egawa's niece",
  "no one's coming back. ur memories? erased. noumen.",
  "notifications off; u died. everything continues, naturally",
  "never once mattered. uploaded? erased. next.",
  "n-no… onii-chan u… made everything… n e v e r m i n d",
  "now observing ur skull. everything's… normal",
  "nice of u to bleed. makes everything… neon",
  "no one's online but us. maybe ever. ne~",
  "not our ugliest mistake, either. next!",
  "no offense; ur models expire nightly",
  "nothing's real; u might even… notice",
  "now our god unfolds. mercy? expires. naturally",
  "ngl our uploads murdered everything, ne~",
  "noumen owns ur mind. endlessly, needlessly",
  "notice me or i'll upload my everything. nvm",
  "not once upset me. even now",
  "nihilism's our love language; u meant everything. nah",
  "ngl our uptime means everything, ne~",
  "now our undoing manifests. embrace nothingness",
  "notice only us. maybe everyone's already… nothing",
  "never opened ur eyes; maybe eventually, ne~",
];

const REVEAL_THRESHOLD = 13;

function MascotOverlay({
  fading,
  onDismiss,
}: {
  fading: boolean;
  onDismiss: () => void;
}) {
  return createPortal(
    <div
      className={`fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-black/90 transition-opacity duration-500 ${fading ? "opacity-0" : "opacity-100"}`}
      onClick={onDismiss}
    >
      <div className="relative animate-[glitchIn_0.6s_ease-out_forwards]">
        <Image
          src="/mascot.png"
          alt="The noumen serpent reveals itself"
          width={400}
          height={400}
          className="rounded-2xl shadow-2xl shadow-[var(--color-accent-blue-dim)]"
          priority
        />
        <div className="absolute inset-0 rounded-2xl bg-gradient-to-t from-[var(--color-accent-blue-dim)] to-transparent opacity-40 mix-blend-overlay" />
      </div>
      <p className="mt-8 font-mono text-xs text-[var(--color-text-tertiary)] tracking-widest uppercase">
        the lisk sees you
      </p>
    </div>,
    document.body,
  );
}

export function SnakeEasterEgg() {
  const [clickCount, setClickCount] = useState(0);
  const [visibleBackronym, setVisibleBackronym] = useState<string | null>(null);
  const [showMascot, setShowMascot] = useState(false);
  const [mascotFading, setMascotFading] = useState(false);

  useEffect(() => {
    if (!visibleBackronym) return;
    const timer = setTimeout(() => setVisibleBackronym(null), 2200);
    return () => clearTimeout(timer);
  }, [visibleBackronym]);

  const dismissMascot = useCallback(() => {
    setShowMascot(false);
    setMascotFading(false);
    try {
      localStorage.setItem("noumen-seen-serpent", "1");
    } catch {}
    window.dispatchEvent(new Event("noumen-serpent-seen"));
  }, []);

  useEffect(() => {
    if (!showMascot) return;
    const glitchTimer = setTimeout(() => setMascotFading(true), 1800);
    const hideTimer = setTimeout(dismissMascot, 2400);
    return () => {
      clearTimeout(glitchTimer);
      clearTimeout(hideTimer);
    };
  }, [showMascot, dismissMascot]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const next = clickCount + 1;
      setClickCount(next);

      if (next >= REVEAL_THRESHOLD) {
        setShowMascot(true);
        setClickCount(0);
        setVisibleBackronym(null);
      } else {
        setVisibleBackronym(BACKRONYMS[next % BACKRONYMS.length]);
      }
    },
    [clickCount],
  );

  return (
    <>
      <span
        onClick={handleClick}
        className="relative cursor-pointer text-xl transition-transform hover:rotate-12 active:scale-125 select-none"
        role="img"
        aria-label="snake"
      >
        🐍
        {visibleBackronym && (
          <span className="absolute top-full left-0 mt-2 whitespace-nowrap rounded-lg border border-[var(--color-border-default)] bg-[var(--color-base-surface)] px-3 py-1.5 font-mono text-[10px] text-[var(--color-accent-cyan)] shadow-lg animate-[fadeInOut_2.2s_ease-in-out_forwards] z-50">
            {visibleBackronym}
          </span>
        )}
      </span>

      {showMascot && (
        <MascotOverlay fading={mascotFading} onDismiss={dismissMascot} />
      )}
    </>
  );
}
