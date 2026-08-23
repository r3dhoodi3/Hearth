"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { setActiveHomeAction } from "@/lib/homeActions";
import RemoveHomeButton from "@/components/RemoveHomeButton";
import SubmitButton from "@/components/SubmitButton";
import type { HomeSummary } from "@/lib/property";

// Dropdown of the user's homes: switch, remove, or add. Closes on outside
// click or Escape (no need to click the toggle again).
export default function HomeSwitcher({
  homes,
  activeId,
}: {
  homes: HomeSummary[];
  activeId: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = homes.find((h) => h.id === activeId) ?? homes[0];

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // min-w-0 on the root: it sits in the header's shrinkable left group, and
  // without it the automatic minimum size of this box is its content width,
  // so on a narrow phone it refused to shrink and the address ran straight
  // under the Tools button beside it ("8892 ConstitutiTools"). Restored to
  // min-width:auto from sm up, where the header has room for the whole
  // address and shrinking it would be a pointless truncation.
  return (
    <div ref={ref} className="relative min-w-0 sm:min-w-[auto]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={
          active
            ? `Switch home, current: ${active.address_line1}`
            : "Switch home"
        }
        className="-my-2.5 flex min-w-0 max-w-full items-center gap-1 py-2.5 text-sm font-medium text-stone-600 active:opacity-70 hover:text-stone-800 sm:min-w-[auto] sm:max-w-none dark:text-stone-400 dark:hover:text-stone-200"
      >
        {/* min-w-0 as well as truncate: a <button> is laid out with a
            min-content size equal to its max-content size, so the explicit
            min-width:0 above is what actually lets this label give way. */}
        <span className="min-w-0 max-w-[8.5rem] truncate sm:max-w-[12rem]">
          {active?.address_line1}
        </span>
        <span
          className={`shrink-0 text-stone-500 transition dark:text-stone-400 ${open ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>

      {open && (
        <div className="absolute left-0 z-20 mt-2 w-72 rounded-xl border border-stone-200 bg-white p-2 shadow-pop dark:border-white/10 dark:bg-stone-700">
          <p className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
            Your homes
          </p>

          {homes.map((h) => (
            <div
              key={h.id}
              className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-bark-50 dark:hover:bg-stone-600"
            >
              {h.id === active?.id ? (
                <span className="flex-1 truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                  ✓ {h.address_line1}
                  {h.isShared && (
                    <span className="ml-1 text-xs font-normal text-stone-500 dark:text-stone-400">
                      Shared
                    </span>
                  )}
                </span>
              ) : (
                <form action={setActiveHomeAction} className="min-w-0 flex-1">
                  <input type="hidden" name="id" value={h.id} />
                  <SubmitButton
                    className="w-full truncate text-left text-sm text-stone-700 active:opacity-70 hover:text-bark-700 disabled:opacity-60 dark:text-stone-300 dark:hover:text-stone-300"
                    pendingLabel="Switching…"
                  >
                    {h.address_line1}
                    {h.isShared && (
                      <span className="ml-1 text-xs font-normal text-stone-500 dark:text-stone-400">
                        Shared
                      </span>
                    )}
                  </SubmitButton>
                </form>
              )}

              {!h.isShared && <RemoveHomeButton id={h.id} label={h.address_line1} />}
            </div>
          ))}

          <Link
            href="/onboarding"
            className="mt-1 block rounded-md px-2 py-1.5 text-sm font-medium text-bark-700 hover:bg-bark-50 dark:text-stone-300 dark:hover:bg-stone-600"
          >
            + Add a home
          </Link>
          {homes.length >= 1 && (
            <p className="px-2 pb-1 text-xs text-stone-500 dark:text-stone-400">
              Free includes 1 home. Hearth Plus unlocks up to 5.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
