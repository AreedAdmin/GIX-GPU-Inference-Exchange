// web/src/components/RevealText.tsx
// Typewriter / streaming-reveal animation for the verifiable-result viewer.
//
// This is a PURE DISPLAY animation — the answer is already fetched, hash-verified, and
// final. We just *reveal* it progressively so a settled result feels like it's streaming
// in. Nothing here touches the fetch/verify path or the hash badges.
//
// Design notes:
//  • Word-by-word reveal (reads most naturally for prose) with a duration clamped so the
//    whole answer lands in ~2–5 s regardless of length — never feels slow.
//  • Skippable: click the text (or the "reveal all" affordance) to jump to the full output.
//  • prefers-reduced-motion → show instantly, no animation, no caret.
//  • Animates ONCE per result: keyed by `revealKey` (jobId + output). Unrelated re-renders
//    (status flips, badge updates, parent state) do NOT replay it.

import { useEffect, useMemo, useRef, useState } from "react";

/** Target window (ms) the full reveal should complete within, regardless of length. */
const MIN_DURATION_MS = 2000;
const MAX_DURATION_MS = 5000;
/** Lower bound on pace so very short answers still feel deliberate (chars/sec). */
const TARGET_CHARS_PER_SEC = 320;

/** True when the OS asks for reduced motion. Re-evaluated live (kept tiny + dependency-free). */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

/** Split into word+trailing-whitespace chunks so we reveal whole words but keep spacing. */
function toWordChunks(text: string): string[] {
  const chunks = text.match(/\S+\s*|\s+/g);
  return chunks ?? (text ? [text] : []);
}

export interface UseTypewriterResult {
  /** The currently-revealed prefix of `text`. */
  shown: string;
  /** True while the reveal is mid-flight (caret should blink, click should skip). */
  revealing: boolean;
  /** Instantly reveal the whole string and stop. Idempotent. */
  skip: () => void;
}

/**
 * Progressive word-by-word reveal of `text`, completing within ~2–5 s.
 *
 * @param text      the final, complete string to reveal.
 * @param revealKey identity of *this* result. The animation runs once per distinct key;
 *                  when the key is unchanged, re-renders never replay it. Defaults to the
 *                  text itself, but pass a jobId-derived key so identical outputs across
 *                  jobs still animate, and so badge/status re-renders never restart it.
 */
export function useTypewriter(
  text: string,
  revealKey: string = text,
): UseTypewriterResult {
  const reducedMotion = usePrefersReducedMotion();

  const chunks = useMemo(() => toWordChunks(text), [text]);

  // Per-chunk character offsets, so we can map a revealed-chunk count → a string slice.
  const offsets = useMemo(() => {
    const out: number[] = [0];
    let acc = 0;
    for (const c of chunks) {
      acc += c.length;
      out.push(acc);
    }
    return out;
  }, [chunks]);

  // How many word-chunks are currently shown.
  const [count, setCount] = useState(0);
  const rafRef = useRef<number | null>(null);
  // Guards the count-setter so a stale rAF from a previous key can't write after a reset.
  const runIdRef = useRef(0);

  useEffect(() => {
    runIdRef.current += 1;
    const runId = runIdRef.current;

    // Reduced motion or trivial content → reveal instantly, no animation.
    if (reducedMotion || chunks.length <= 1) {
      setCount(chunks.length);
      return;
    }

    setCount(0);

    const total = text.length;
    const durationMs = Math.min(
      MAX_DURATION_MS,
      Math.max(MIN_DURATION_MS, (total / TARGET_CHARS_PER_SEC) * 1000),
    );

    let start: number | null = null;
    const tick = (now: number) => {
      if (runIdRef.current !== runId) return; // superseded by a newer key
      if (start === null) start = now;
      const t = Math.min(1, (now - start) / durationMs);
      // ease-out: brisk start, gentle settle — feels alive without dragging.
      const eased = 1 - Math.pow(1 - t, 2);
      const next = Math.min(chunks.length, Math.ceil(eased * chunks.length));
      setCount(next);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // Keyed ONLY on `revealKey` (+ deterministic deps). Unrelated re-renders won't replay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey, reducedMotion]);

  const skip = () => {
    runIdRef.current += 1; // invalidate any in-flight rAF
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setCount(chunks.length);
  };

  const revealing = count < chunks.length;
  const shown = text.slice(0, offsets[count] ?? text.length);

  return { shown, revealing, skip };
}

export interface RevealTextProps {
  /** Final, complete text to reveal. */
  text: string;
  /** Stable identity for this result (e.g. jobId). Reveal runs once per key. */
  revealKey?: string;
  className?: string;
}

/**
 * Glass-consistent typewriter reveal. Renders inside the result viewer's <pre>.
 * Click anywhere on it (while revealing) to skip to the full answer.
 */
export function RevealText({ text, revealKey, className }: RevealTextProps) {
  const { shown, revealing, skip } = useTypewriter(text, revealKey ?? text);

  return (
    <pre
      className={className}
      onClick={revealing ? skip : undefined}
      role={revealing ? "button" : undefined}
      tabIndex={revealing ? 0 : undefined}
      aria-label={revealing ? "Reveal full output" : undefined}
      title={revealing ? "Click to reveal the full answer" : undefined}
      onKeyDown={
        revealing
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                skip();
              }
            }
          : undefined
      }
      style={revealing ? { cursor: "pointer" } : undefined}
    >
      {shown}
      {revealing && (
        <span
          aria-hidden="true"
          className="reveal-caret"
          style={{
            display: "inline-block",
            width: "0.5ch",
            marginLeft: "1px",
            color: "var(--accent-strong)",
          }}
        >
          ▌
        </span>
      )}
    </pre>
  );
}
