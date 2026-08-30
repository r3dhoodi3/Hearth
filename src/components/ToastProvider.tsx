"use client";

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useReducer,
  useEffect,
  type ReactNode,
} from "react";
import {
  CheckCircle2,
  Info,
  AlertTriangle,
  AlertCircle,
  X,
  type LucideIcon,
} from "lucide-react";

// One shared toast stack. Two feeders push into it: client components via
// useToast(), and the flash cookie via FlashToast. Both land in the
// same queue and render with the same look, so every setFlash() call site is
// upgraded without edits. See toast-system-plan for the full rationale.

export type ToastType = "success" | "error" | "info" | "warning";

export interface ToastOptions {
  // Milliseconds before auto-dismiss. 0 forces the toast to persist until it
  // is dismissed manually. Omit to use the per-type default below.
  duration?: number;
}

export interface ToastApi {
  success: (message: string, opts?: ToastOptions) => string;
  error: (message: string, opts?: ToastOptions) => string;
  warning: (message: string, opts?: ToastOptions) => string;
  info: (message: string, opts?: ToastOptions) => string;
  dismiss: (id: string) => void;
}

interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration: number; // resolved; 0 = persist
  createdAt: number;
  exiting: boolean;
}

// Errors used to persist (duration 0) so an unread error was never a silent
// failure, but the owner found having to press the X on every error annoying.
// Five seconds is long enough to read a one-line error, and any error worth
// acting on re-fires the moment the user retries the same action. Warnings
// still get extra read time; success/info are terse and self-clear quickly.
// Callers that truly must persist can still pass `duration: 0` explicitly.
const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 4000,
  info: 4000,
  warning: 8000,
  error: 5000,
};

const MAX_VISIBLE = 3;
const DEDUPE_MS = 500;
const EXIT_MS = 120;

const ICONS: Record<ToastType, LucideIcon> = {
  success: CheckCircle2,
  info: Info,
  warning: AlertTriangle,
  error: AlertCircle,
};

// Each toast layers an opaque base (bg-white / bg-stone-800) under the chip
// tint so translucent dark chip tones stay crisp over any page background.
// Tones map onto the existing chip-ok / chip-muted / chip-warn / chip-danger
// token families, no new colors.
const TONE: Record<
  ToastType,
  { border: string; text: string; tint: string; icon: string }
> = {
  success: {
    border: "border-green-200 dark:border-green-500/30",
    text: "text-green-700 dark:text-green-300",
    tint: "bg-green-50 dark:bg-green-500/15",
    icon: "text-green-600 dark:text-green-400",
  },
  info: {
    border: "border-stone-200 dark:border-white/10",
    text: "text-stone-700 dark:text-stone-200",
    tint: "bg-stone-100 dark:bg-stone-700",
    icon: "text-stone-500 dark:text-stone-400",
  },
  warning: {
    border: "border-amber-200 dark:border-amber-500/30",
    text: "text-amber-700 dark:text-amber-300",
    tint: "bg-amber-50 dark:bg-amber-500/15",
    icon: "text-amber-600 dark:text-amber-400",
  },
  error: {
    border: "border-red-100 dark:border-red-500/30",
    text: "text-red-700 dark:text-red-300",
    tint: "bg-red-50 dark:bg-red-500/15",
    icon: "text-red-600 dark:text-red-400",
  },
};

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function ToastProvider({ children }: { children: ReactNode }) {
  // The list is held in a ref (authoritative, read synchronously so add/dismiss
  // can make queue decisions and return ids) and a reducer bump drives renders.
  const listRef = useRef<ToastItem[]>([]);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const exitTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );
  const paused = useRef<Set<string>>(new Set());
  const seq = useRef(0);

  function commit(next: ToastItem[]) {
    listRef.current = next;
    bump();
  }

  function clearTimer(id: string) {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
  }

  function removeNow(id: string) {
    clearTimer(id);
    const et = exitTimers.current.get(id);
    if (et) {
      clearTimeout(et);
      exitTimers.current.delete(id);
    }
    paused.current.delete(id);
    commit(listRef.current.filter((t) => t.id !== id));
    // A freed slot may promote a queued toast into view; give it a timer.
    syncTimers();
  }

  function dismiss(id: string) {
    const item = listRef.current.find((t) => t.id === id);
    if (!item || item.exiting) return;
    clearTimer(id);
    commit(listRef.current.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
    const delay = prefersReducedMotion() ? 0 : EXIT_MS;
    exitTimers.current.set(
      id,
      setTimeout(() => removeNow(id), delay)
    );
  }

  function startTimer(id: string) {
    clearTimer(id);
    if (paused.current.has(id)) return;
    const item = listRef.current.find((t) => t.id === id);
    if (!item || item.exiting || item.duration <= 0) return;
    timers.current.set(
      id,
      setTimeout(() => dismiss(id), item.duration)
    );
  }

  // Ensure every visible, timed, non-paused toast has a running timer. Safe to
  // call repeatedly: it never restarts a timer that already exists, and skips
  // paused toasts so pause-on-hover is not undone.
  function syncTimers() {
    const visible = listRef.current.slice(0, MAX_VISIBLE);
    for (const t of visible) {
      if (
        !t.exiting &&
        t.duration > 0 &&
        !paused.current.has(t.id) &&
        !timers.current.has(t.id)
      ) {
        startTimer(t.id);
      }
    }
  }

  function pause(id: string) {
    paused.current.add(id);
    clearTimer(id);
  }

  function resume(id: string) {
    paused.current.delete(id);
    // Restart from full duration (matches the plan: leave restarts the timer).
    startTimer(id);
  }

  function add(type: ToastType, message: string, opts?: ToastOptions): string {
    const now = Date.now();
    // De-dupe identical {type, message} fired within a short window so a
    // double-submit does not stack the same toast twice.
    const dup = listRef.current.find(
      (t) =>
        !t.exiting &&
        t.type === type &&
        t.message === message &&
        now - t.createdAt < DEDUPE_MS
    );
    if (dup) return dup.id;

    seq.current += 1;
    const id = `t-${now}-${seq.current}`;
    const duration =
      opts && typeof opts.duration === "number"
        ? opts.duration
        : DEFAULT_DURATION[type];

    let next: ToastItem[] = [
      ...listRef.current,
      { id, type, message, duration, createdAt: now, exiting: false },
    ];

    // Cap visible at MAX_VISIBLE. When full, drop the oldest NON-error toast to
    // make room. Never drop an error: if all others are errors, the new toast
    // stays queued past the cap and shows when a slot frees.
    const active = next.filter((t) => !t.exiting);
    if (active.length > MAX_VISIBLE) {
      const victim = next.find(
        (t) => !t.exiting && t.type !== "error" && t.id !== id
      );
      if (victim) {
        clearTimer(victim.id);
        paused.current.delete(victim.id);
        next = next.filter((t) => t.id !== victim.id);
      }
    }

    commit(next);
    syncTimers();
    return id;
  }

  // Stable API: consumers keep the same object across toast state changes.
  // addRef/dismissRef point at the latest closures, which read the refs above.
  const addRef = useRef(add);
  const dismissRef = useRef(dismiss);
  addRef.current = add;
  dismissRef.current = dismiss;

  const api = useMemo<ToastApi>(
    () => ({
      success: (m, o) => addRef.current("success", m, o),
      error: (m, o) => addRef.current("error", m, o),
      warning: (m, o) => addRef.current("warning", m, o),
      info: (m, o) => addRef.current("info", m, o),
      dismiss: (id) => dismissRef.current(id),
    }),
    []
  );

  // Clear every pending timer if the provider unmounts.
  useEffect(() => {
    const running = timers.current;
    const exiting = exitTimers.current;
    return () => {
      running.forEach((t) => clearTimeout(t));
      exiting.forEach((t) => clearTimeout(t));
    };
  }, []);

  const visible = listRef.current.slice(0, MAX_VISIBLE);
  const statusToasts = visible.filter((t) => t.type !== "error");
  const errorToasts = visible.filter((t) => t.type === "error");

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Bottom-center. Below sm, raise the whole stack above the fixed mobile
          tab bar (3.5rem) - do NOT reuse .fixed.bottom-4.right-4, that offset
          belongs to the corner widgets. Wrapper ignores pointer events so the
          empty gutters never block the page; each toast re-enables them. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4 max-sm:bottom-[calc(3.5rem_+_env(safe-area-inset-bottom)_+_0.5rem)]">
        <div className="flex w-full max-w-sm flex-col gap-2">
          {/* Two sibling live regions so screen readers announce reliably:
              polite for success/info/warning, assertive for errors. Both stay
              mounted (empty regions announce more dependably than ones that
              appear with their content). */}
          <ol
            role="status"
            aria-live="polite"
            aria-relevant="additions"
            className="m-0 flex list-none flex-col gap-2 p-0"
          >
            {statusToasts.map((t) => (
              <ToastCard
                key={t.id}
                item={t}
                onDismiss={() => dismiss(t.id)}
                onPause={() => pause(t.id)}
                onResume={() => resume(t.id)}
              />
            ))}
          </ol>
          <ol
            role="alert"
            aria-live="assertive"
            aria-relevant="additions"
            className="m-0 flex list-none flex-col gap-2 p-0"
          >
            {errorToasts.map((t) => (
              <ToastCard
                key={t.id}
                item={t}
                onDismiss={() => dismiss(t.id)}
                onPause={() => pause(t.id)}
                onResume={() => resume(t.id)}
              />
            ))}
          </ol>
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({
  item,
  onDismiss,
  onPause,
  onResume,
}: {
  item: ToastItem;
  onDismiss: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const tone = TONE[item.type];
  const Icon = ICONS[item.type];
  return (
    <li className="pointer-events-auto w-full list-none">
      <div
        // Pause-on-hover and pause-on-focus: clear the timer on enter, restart
        // it on leave. Errors now auto-dismiss too, so hovering one holds it on
        // screen for as long as the user is reading it.
        onMouseEnter={onPause}
        onMouseLeave={onResume}
        onFocus={onPause}
        onBlur={onResume}
        className={`relative overflow-hidden rounded-xl border bg-white shadow-lift dark:bg-stone-800 ${
          tone.border
        } ${tone.text} ${
          item.exiting
            ? "motion-safe:animate-fade-slide-down"
            : "motion-safe:animate-fade-slide-up"
        }`}
      >
        {/* Chip tint over the opaque base. Behind the content (which is
            relative) so it never covers the text. */}
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 ${tone.tint}`}
        />
        <div className="relative flex items-start gap-3 px-4 py-3">
          <Icon aria-hidden="true" className={`mt-0.5 h-5 w-5 shrink-0 ${tone.icon}`} />
          <span className="min-w-0 flex-1 break-words text-sm font-medium leading-snug">
            {item.message}
          </span>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            // max-sm: the visible glyph stays the same size, but the hit area
            // grows to 44px - this is the only way to dismiss a persistent
            // error toast, and it used to be a 20px target sitting over the
            // bottom tab bar.
            className="-mr-1 -mt-0.5 shrink-0 rounded p-0.5 text-stone-400 transition hover:text-stone-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bark-600 max-sm:-m-2 max-sm:flex max-sm:h-11 max-sm:w-11 max-sm:items-center max-sm:justify-center max-sm:p-0 dark:text-stone-500 dark:hover:text-stone-300 dark:focus-visible:ring-bark-500"
          >
            <X aria-hidden="true" className="h-4 w-4 max-sm:h-5 max-sm:w-5" />
          </button>
        </div>
      </div>
    </li>
  );
}
