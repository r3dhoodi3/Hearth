"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";

type MenuLink = {
  href: string;
  label: string;
  // Optional visual accent for an item that needs to stand out (currently only
  // used by the homeowner "Emergency" link). Undefined renders the normal row.
  accent?: "red";
  // Optional: submit a server action instead of navigating. The row renders as
  // a form button that looks exactly like a link row. Used by the side
  // switcher in both navs, which has to RECORD the switch (the preferred
  // landing side) as well as go there; `side` rides along as a hidden field.
  // Every other item leaves both undefined and renders as a plain Link.
  action?: (formData: FormData) => void | Promise<void>;
  side?: "homeowner" | "contractor";
};

// Avatar + dropdown shown in the top-right of both navs. Account-scoped only:
// profile/settings/help links and Log out. Navigation destinations belong in
// the nav itself (homeowner: ToolsMenu), not here. The chrome - avatar, name,
// chevron, and the Log out form - is shared so the two toolbars can't drift
// apart.
export default function ProfileMenu({
  name,
  links,
  linksLabel,
  hasPlus,
  themeToggle,
}: {
  name: string | null;
  links: MenuLink[];
  // Optional section label rendered above `links`. Omitted on both navs today,
  // which render links plain; kept as a harmless generic hook.
  linksLabel?: string;
  // Homeowner-only: whether the signed-in user has Hearth Plus. Undefined on
  // the contractor side (ProNav), which has no Plus entry to show.
  hasPlus?: boolean;
  // When true, a "Dark mode" row (with a visible on/off switch) renders above
  // Log out so signed-in users can always change theme from either nav.
  themeToggle?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Plays the exit animation instead of an instant unmount: on the open ->
  // closed transition the panel stays mounted for one more tick with
  // fade-scale-out, then drops.
  const [closing, setClosing] = useState(false);
  const wasOpen = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open && wasOpen.current) {
      setClosing(true);
      const t = setTimeout(() => setClosing(false), 120);
      wasOpen.current = open;
      return () => clearTimeout(t);
    }
    wasOpen.current = open;
  }, [open]);
  const shouldRender = open || closing;

  // Close on outside click or Escape. Escape hands focus back to the trigger
  // so keyboard users aren't dropped at the top of the page.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={name ? `Account menu for ${name}` : "Account menu"}
        className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 text-sm font-medium text-stone-700 hover:bg-bark-50 dark:text-stone-200 dark:hover:bg-stone-800"
      >
        {name ? (
          // Initials monogram - the first letter of the name in brand colors.
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-bark-100 font-semibold text-bark-700 dark:bg-bark-700 dark:text-stone-300"
          >
            {name.trim().charAt(0).toUpperCase()}
          </span>
        ) : (
          // Placeholder avatar - blank humanoid head + torso.
          <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-stone-200 text-stone-500 dark:bg-stone-700 dark:text-stone-400">
            <svg
              viewBox="0 0 24 24"
              className="h-7 w-7"
              fill="currentColor"
              aria-hidden="true"
            >
              <circle cx="12" cy="9" r="4" />
              <path d="M4 20c0-3.6 3.6-6 8-6s8 2.4 8 6v1H4v-1z" />
            </svg>
          </span>
        )}
        {name && (
          <span className="hidden max-w-[12rem] truncate sm:inline">{name}</span>
        )}
        {/* Dropdown indicator. Hidden below sm: on a phone the avatar alone
            already reads as the account button, and the 24px this costs is
            24px the home address next to it does not have. sm and up are
            unchanged. */}
        <svg
          viewBox="0 0 20 20"
          className={`hidden h-4 w-4 text-stone-500 transition-transform sm:block dark:text-stone-400 ${
            open ? "rotate-180" : ""
          }`}
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {/* Plain disclosure panel, not an ARIA menu: we don't implement the
          menu keyboard contract (arrow keys, focus trapping), so we don't
          claim the role either. Tab + Escape work as expected. */}
      {shouldRender && (
        <div
          className={`absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-xl border border-stone-200 bg-white py-1.5 shadow-menu dark:border-white/10 dark:bg-stone-700 ${
            open ? "motion-safe:animate-fade-scale" : "motion-safe:animate-fade-scale-out"
          }`}
        >
          {hasPlus !== undefined && (
            <Link
              href="/plus"
              onClick={() => setOpen(false)}
              className={
                hasPlus
                  ? "block border-b border-stone-100 px-4 py-2 text-sm text-stone-500 dark:border-white/10 dark:text-stone-400"
                  : "block border-b border-stone-100 bg-bark-50 px-4 py-2 text-sm font-medium text-bark-700 hover:bg-bark-100 dark:border-white/10 dark:bg-bark-700/40 dark:text-stone-300 dark:hover:bg-bark-700/60"
              }
            >
              {hasPlus ? "Hearth Plus ✓" : "Upgrade to Hearth Plus"}
            </Link>
          )}
          <div>
            {linksLabel && (
              <p className="px-4 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
                {linksLabel}
              </p>
            )}
            {links.map((l) => {
              const rowClass =
                l.accent === "red"
                  ? "mx-1 flex items-center rounded-md px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/15"
                  : "mx-1 flex items-center rounded-md px-3 py-2 text-sm text-stone-700 hover:bg-bark-50 dark:text-stone-300 dark:hover:bg-stone-600";
              if (l.action) {
                return (
                  <form key={l.href} action={l.action}>
                    {l.side && (
                      <input type="hidden" name="side" value={l.side} />
                    )}
                    {/* No onClick close here: closing the menu on click
                        unmounts this form before the browser submits it
                        ("Form submission canceled because the form is not
                        connected"). The action redirects, which closes the
                        menu by navigating away. */}
                    <button
                      type="submit"
                      className={`${rowClass} w-[calc(100%-0.5rem)] text-left`}
                    >
                      {l.label}
                    </button>
                  </form>
                );
              }
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className={rowClass}
                >
                  {l.label}
                </Link>
              );
            })}
          </div>
          {themeToggle && <ThemeToggle variant="row" />}
          <form
            action="/auth/signout"
            method="post"
            className="border-t border-stone-100 dark:border-white/10"
          >
            <button
              type="submit"
              className="block w-full px-4 py-2 text-left text-sm font-medium text-stone-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-stone-400 dark:hover:bg-red-500/15 dark:hover:text-red-400"
            >
              Log out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
