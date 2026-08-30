"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { setActiveHomeAction } from "@/lib/homeActions";
import SubmitButton from "@/components/SubmitButton";
import type { HomeSummary } from "@/lib/property";

// Dropdown of the user's homes: switch or add (no self-serve delete; see the
// "Need to remove a home?" line below). Closes on outside click or Escape (no
// need to click the toggle again).
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

  // min-w-0 at EVERY width, not just below sm: this box sits in the header's
  // shrinkable left group, and without it the automatic minimum size of the
  // box is its content width, so the whole left group refuses to shrink and
  // the address runs straight under whatever is beside it. On a phone that
  // was the Tools button ("8892 ConstitutiTools"); on a 1024-1680px desktop
  // it was the nav strip, which is shrink-0, so a long address rendered as
  // "Hearth · 3831 [Home]ve[Browse Pros]". The address yields (truncated,
  // with the full one in the aria-label and in the open menu) and the nav
  // links keep their room at every width.
  return (
    <div ref={ref} className="relative min-w-0">
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
        // Phone only: -my/py cancel out, so the extra padding buys a 44px
        // target without moving the header.
        className="-my-2.5 flex min-w-0 max-w-full items-center gap-1 py-2.5 text-sm font-medium text-stone-600 active:opacity-70 hover:text-stone-800 max-sm:-my-3 max-sm:py-3 dark:text-stone-400 dark:hover:text-stone-200"
      >
        {/* min-w-0 as well as truncate: a <button> is laid out with a
            min-content size equal to its max-content size, so the explicit
            min-width:0 above is what actually lets this label give way. The
            max-w ladder is a ceiling, not a floor - it stops a long address
            eating the header on a wide screen, while the min-w-0 above lets
            it go narrower still when the nav needs the space. */}
        <span className="min-w-0 max-w-[8.5rem] truncate sm:max-w-[10rem] lg:max-w-[14rem]">
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
          <p className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-stone-500 max-sm:text-sm dark:text-stone-400">
            Your homes
          </p>

          {homes.map((h) => (
            <div
              key={h.id}
              // Phone only: the rows were 32px tall and the switch button
              // inside them was a bare ~20px line of text.
              className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-bark-50 max-sm:min-h-11 dark:hover:bg-stone-600"
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
                    className="w-full truncate text-left text-sm text-stone-700 active:opacity-70 hover:text-bark-700 disabled:opacity-60 max-sm:flex max-sm:min-h-11 max-sm:items-center dark:text-stone-300 dark:hover:text-stone-300"
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
            </div>
          ))}

          <Link
            href="/onboarding"
            className="mt-1 block rounded-md px-2 py-1.5 text-sm font-medium text-bark-700 hover:bg-bark-50 max-sm:flex max-sm:min-h-11 max-sm:items-center dark:text-stone-300 dark:hover:bg-stone-600"
          >
            + Add a home
          </Link>
          {homes.length >= 1 && (
            <p className="px-2 pb-1 text-xs text-stone-500 max-sm:text-sm dark:text-stone-400">
              Free includes 1 home. Hearth Plus unlocks up to 5.
            </p>
          )}
          {/* No self-serve delete (see homeActions.ts removeHomeAction): a
              free-tier delete-and-recreate loop is how the one-home cap gets
              cycled between neighbours, so removal goes through support. */}
          <p className="px-2 pb-1 text-xs text-stone-500 max-sm:text-sm dark:text-stone-400">
            Need to remove a home?{" "}
            <Link href="/contact" className="underline hover:text-stone-700 max-sm:py-3 dark:hover:text-stone-300">
              Contact us
            </Link>{" "}
            and we will take care of it.
          </p>
        </div>
      )}
    </div>
  );
}
