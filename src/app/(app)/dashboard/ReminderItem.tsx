"use client";

import { useEffect, useState } from "react";
import {
  completeReminderAction,
  uncompleteReminderAction,
  deleteReminderAction,
} from "./actions";
import { useChecklist } from "@/components/ChecklistProvider";
import { useToast } from "@/components/ToastProvider";
import InlineSpinner from "@/components/InlineSpinner";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Format a YYYY-MM-DD date string as e.g. "Jul 15" without going through Date
// (avoids timezone off-by-one and the argless-Date restriction).
function formatDue(d: string): string {
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return d;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}` : d;
}

// A friendly due-date chip: overdue (red), due soon (amber), or a plain date
// further out. Purely presentational. `days` comes from the server (the same
// daysUntil the page uses to group rows under Overdue / Due soon) so the chip
// and its group heading can never disagree, which they did when this file
// recomputed days from the browser's clock while the page grouped by the
// server's.
function dueChip(
  due: string | null,
  done: boolean,
  days: number | null
): { label: string; className: string } | null {
  if (done) {
    return {
      label: "Done",
      className: "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200",
    };
  }
  if (!due) return null;
  if (days === null || Number.isNaN(days)) {
    return {
      label: formatDue(due),
      className: "border-stone-200 bg-stone-50 text-stone-500 dark:border-white/10 dark:bg-stone-700 dark:text-stone-400",
    };
  }
  if (days < 0) {
    return {
      label: days === -1 ? "Overdue by 1 day" : `Overdue by ${-days} days`,
      className: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
    };
  }
  if (days === 0) {
    return {
      label: "Due today",
      className: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300",
    };
  }
  if (days <= 7) {
    return {
      label: `Due in ${days} day${days === 1 ? "" : "s"}`,
      className: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300",
    };
  }
  return {
    label: formatDue(due),
    className: "border-stone-200 bg-stone-50 text-stone-500 dark:border-white/10 dark:bg-stone-700 dark:text-stone-400",
  };
}

// A reminder row: click the checkbox to cross it out (click again to uncross).
export default function ReminderItem({
  id,
  title,
  due,
  daysLeft = null,
  initialDone = false,
}: {
  id: string;
  title: string;
  due: string | null;
  // Whole days until due, computed by the server page with the same clock it
  // used to group rows, so chip and group heading always agree.
  daysLeft?: number | null;
  initialDone?: boolean;
}) {
  const [done, setDone] = useState(initialDone);
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState(false);
  // True only right after the toggle turns a reminder on, so the check-pop
  // animation plays for that action and not for items already done on load.
  const [justCompleted, setJustCompleted] = useState(false);
  const checklist = useChecklist();
  const toast = useToast();

  useEffect(() => {
    checklist?.register(id, initialDone);
    return () => checklist?.unregister(id);
  }, [id, initialDone, checklist]);

  if (removed) return null;

  async function remove() {
    setBusy(true);
    // Optimistic: hide the row immediately, restore it if the delete fails.
    checklist?.unregister(id);
    setRemoved(true);
    try {
      const res = await deleteReminderAction(id);
      if (!res.ok) {
        setRemoved(false);
        checklist?.register(id, done);
        // A stay-on-page failure never shows via the flash cookie, so surface
        // the returned reason here.
        toast.error(res.error);
        return;
      }
    } catch {
      setRemoved(false);
      checklist?.register(id, done);
      // Server errors already surface as a toast (the actions call setFlash);
      // this fallback covers a truly unexpected failure (network drop, etc.)
      // that never reaches that path.
      toast.error("Couldn't remove that reminder. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle() {
    const next = !done;
    setBusy(true);
    // Optimistic: flip the checkbox immediately, revert on failure. The
    // checklist report (which can trigger the once-per-session completion
    // celebration) waits for server confirmation, so a toggle that rolls
    // back never burns that celebration for a completion that didn't
    // actually happen.
    setDone(next);
    setJustCompleted(next);
    try {
      const res = next
        ? await completeReminderAction(id)
        : await uncompleteReminderAction(id);
      if (!res.ok) {
        setDone(!next);
        setJustCompleted(false);
        // A stay-on-page failure never shows via the flash cookie, so surface
        // the returned reason here.
        toast.error(res.error);
        return;
      }
      checklist?.report(id, next);
    } catch {
      setDone(!next);
      setJustCompleted(false);
      // Fallback for an unexpected failure the server toast never sees.
      toast.error("Couldn't update that reminder. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const chip = dueChip(due, done, daysLeft);

  return (
    <li className="list-none">
      <div
        // max-sm:py-0.5 with the min-h-11 button below keeps the phone row at
        // about 48px instead of growing it to 64px.
        className={`flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors max-sm:py-0.5 ${
          done ? "bg-stone-50/60 dark:bg-stone-700/40" : "hover:bg-stone-50 dark:hover:bg-stone-700/40"
        }`}
      >
        <button
          type="button"
          disabled={busy}
          onClick={toggle}
          // The done state is otherwise only conveyed visually (fill +
          // strikethrough), so expose it as a checkbox to assistive tech.
          role="checkbox"
          aria-checked={done}
          aria-label={due ? `${title}, due ${formatDue(due)}` : title}
          // Phone only: the button was only as tall as its text (~20px) in a
          // 40px row. Marking a task done is the most repeated action here.
          className="flex min-w-0 flex-1 items-center gap-3 text-left max-sm:min-h-11"
        >
          <span
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] max-sm:h-6 max-sm:w-6 max-sm:text-xs ${
              done
                ? "border-green-500 bg-green-500 text-white"
                : "border-stone-300 text-transparent dark:border-stone-600"
            } ${justCompleted ? "motion-safe:animate-check-pop" : ""}`}
          >
            ✓
          </span>
          <span
            className={`truncate text-sm ${
              done ? "text-stone-500 line-through dark:text-stone-400" : "text-stone-800 dark:text-stone-200"
            }`}
          >
            {title}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {chip && (
            <span
              className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${chip.className}`}
            >
              {chip.label}
            </span>
          )}
          {/* Rendered whether or not the task is done so an unwanted open
              reminder can be dismissed without marking it complete. */}
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="flex min-h-[44px] items-center gap-1.5 px-1 text-xs text-stone-500 hover:text-red-600 dark:text-stone-400 dark:hover:text-red-400"
          >
            {busy && <InlineSpinner size={12} />}
            Delete
          </button>
        </div>
      </div>
    </li>
  );
}
