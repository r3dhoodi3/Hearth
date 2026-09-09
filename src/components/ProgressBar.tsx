"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// One shared progress bar for every long, user-triggered operation in the app.
// Flat track, a single accent fill (bark, the same brown .btn-primary uses), no
// gradient, no glass, no shimmer. The width animates so a rising value reads as
// steady forward motion rather than a jump.
//
// Two ways to drive it:
//   - determinate: pass `value` (0-100) on its own.
//   - staged: also pass `stages` (the honest step labels) and `stageIndex`
//     (which one is happening now). The current label shows under the bar in an
//     aria-live region so a screen reader announces each step as it changes.
//
// The bar itself never invents progress. For the app's AI calls (a single
// request with no server-sent progress) pair it with useStagedProgress below,
// which creeps the value forward honestly and only hits 100 once the response
// actually lands.
type ProgressBarProps = {
  // 0-100. Clamped and rounded before it drives the fill width.
  value: number;
  // Optional honest step labels; the one at `stageIndex` is shown under the bar.
  stages?: string[];
  stageIndex?: number;
  // An explicit label, used instead of the stage-derived one when set.
  label?: string;
  // Extra classes on the outer wrapper (spacing at the call site).
  className?: string;
  // Accessible name for the bar; falls back to the visible label.
  ariaLabel?: string;
};

export default function ProgressBar({
  value,
  stages,
  stageIndex = 0,
  label,
  className = "",
  ariaLabel,
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  const stageLabel =
    label ??
    (stages && stages.length
      ? stages[Math.min(Math.max(0, stageIndex), stages.length - 1)]
      : undefined);

  return (
    <div className={className}>
      <div
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={ariaLabel ?? stageLabel ?? "Progress"}
        className="h-2 w-full overflow-hidden rounded-full bg-stone-200 dark:bg-white/10"
      >
        <div
          className="h-full rounded-full bg-bark-600 transition-[width] duration-300 ease-out dark:bg-bark-500 motion-reduce:transition-none"
          style={{ width: `${clamped}%` }}
        />
      </div>
      {stageLabel && (
        <p
          aria-live="polite"
          className="mt-2 text-xs text-stone-500 dark:text-stone-400"
        >
          {stageLabel}
        </p>
      )}
    </div>
  );
}

// Simulated staged progress for a single request that has no real progress
// events (all of OakTend's AI reads are one POST that either lands or times out).
// It is honest about that: the bar creeps toward a ceiling below 100 and slows
// as it climbs, so it can move without ever claiming the work is done, then
// snaps to 100 only when the caller says the response arrived.
//
// Usage stays tiny at each call site:
//   const progress = useStagedProgress(STAGES);
//   progress.start();
//   try { ...await fetch... } finally { progress.finish(); }
//   {loading && <ProgressBar value={progress.value} stages={STAGES}
//                            stageIndex={progress.stageIndex} />}
//
// `expectedMs` is a rough guess at how long the whole call takes; it only sets
// the pace stage labels advance at. Being wrong never makes the bar lie, since
// it still can't reach 100 until finish() is called.
export function useStagedProgress(stages: string[], expectedMs = 14000) {
  const [value, setValue] = useState(0);
  const [stageIndex, setStageIndex] = useState(0);
  // Mirrors of the state read inside the timers, so each tick sees the live
  // number instead of the value captured when the interval was created.
  const valueRef = useRef(0);
  const stageRef = useRef(0);
  const creepTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stageTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = useCallback(() => {
    if (creepTimer.current) {
      clearInterval(creepTimer.current);
      creepTimer.current = null;
    }
    if (stageTimer.current) {
      clearInterval(stageTimer.current);
      stageTimer.current = null;
    }
  }, []);

  const start = useCallback(() => {
    clearTimers();
    const n = Math.max(1, stages.length);
    valueRef.current = 0;
    stageRef.current = 0;
    setValue(0);
    setStageIndex(0);

    // Each stage owns a slice of the bar, and the last stage's slice stops at
    // 92 so the bar always leaves visible room for the real finish. Within a
    // stage the value eases toward that ceiling and never crosses it on its own.
    const ceilingFor = (i: number) => ((i + 1) / n) * 92;
    creepTimer.current = setInterval(() => {
      const ceiling = ceilingFor(stageRef.current);
      const v = valueRef.current;
      if (v < ceiling) {
        const next = v + (ceiling - v) * 0.12;
        valueRef.current = next;
        setValue(next);
      }
    }, 200);

    // Walk the stage label forward on an even cadence, then hold on the last
    // one (which is where the wait usually is) until finish() lands.
    stageTimer.current = setInterval(
      () => {
        if (stageRef.current < n - 1) {
          stageRef.current += 1;
          setStageIndex(stageRef.current);
        }
      },
      Math.max(500, expectedMs / n)
    );
  }, [stages, expectedMs, clearTimers]);

  const finish = useCallback(() => {
    clearTimers();
    stageRef.current = Math.max(0, stages.length - 1);
    valueRef.current = 100;
    setStageIndex(stageRef.current);
    setValue(100);
  }, [clearTimers, stages.length]);

  const reset = useCallback(() => {
    clearTimers();
    valueRef.current = 0;
    stageRef.current = 0;
    setValue(0);
    setStageIndex(0);
  }, [clearTimers]);

  // Stop the timers if the component unmounts mid-run.
  useEffect(() => () => clearTimers(), [clearTimers]);

  return { value, stageIndex, start, finish, reset };
}
