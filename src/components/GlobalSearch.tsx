"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import InlineSpinner from "@/components/InlineSpinner";
import {
  matchDestinations,
  matchFaq,
  type SearchSide,
} from "@/lib/searchSuggestions";
import type { FaqEntry } from "@/lib/faqIndex";

// A compact smart-search box for the top nav, mounted on BOTH shells: the
// homeowner header (src/components/Nav.tsx, default side) and the pro header
// (src/components/ProNav.tsx, side="pro"). From the first keystrokes it shows
// grouped suggestions under the input: app destinations and matching FAQ
// answers, all matched client-side from the static registries in
// src/lib/searchSuggestions.ts and src/lib/faqIndex.ts, so nothing waits on a
// request. Submitting still routes to the side's search page (/search for the
// homeowner, which also queries their own systems/documents/issues on the
// server; /pro/search for pros), so enter-without-picking keeps working.
const EXAMPLES: Record<SearchSide, string[]> = {
  homeowner: [
    "Water heater",
    "Warranty",
    "Find a plumber",
    "When to replace my roof",
    "My documents",
  ],
  pro: [
    "Browse leads",
    "Lead pricing",
    "Deposits",
    "Your public page",
    "Membership",
  ],
};

// The flat, keyboard-navigable list behind the grouped dropdown.
type Item =
  | { kind: "dest"; label: string; href: string }
  | { kind: "faq"; faq: FaqEntry };

// How long typing has to pause before suggestions recompute. Matching is
// synchronous and cheap, so this is about not reshuffling the list mid-word.
const DEBOUNCE_MS = 180;

export default function GlobalSearch({
  side = "homeowner",
}: {
  // Which registry/FAQ half this box searches, and which shell's accent color
  // and search page it uses.
  side?: SearchSide;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  // Plays the exit animation instead of an instant unmount: on the focused
  // -> blurred transition the panel stays mounted for one more tick with
  // fade-scale-out, then drops.
  const [closing, setClosing] = useState(false);
  // Debounced copy of q that the suggestion list is computed from.
  const [debouncedQ, setDebouncedQ] = useState("");
  // Keyboard cursor over the flat items list. -1 means nothing highlighted,
  // so a plain Enter submits the form as before.
  const [activeIndex, setActiveIndex] = useState(-1);
  // Which FAQ question is expanded inline, if any.
  const [openFaq, setOpenFaq] = useState<string | null>(null);
  const wasFocused = useRef(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!focused && wasFocused.current) {
      setClosing(true);
      const t = setTimeout(() => setClosing(false), 120);
      wasFocused.current = focused;
      return () => clearTimeout(t);
    }
    wasFocused.current = focused;
  }, [focused]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  // A fresh result set means the old cursor and any expanded answer point at
  // rows that may no longer exist.
  useEffect(() => {
    setActiveIndex(-1);
    setOpenFaq(null);
  }, [debouncedQ]);

  const items: Item[] = useMemo(() => {
    const s = debouncedQ.trim();
    if (!s) return [];
    const dests = matchDestinations(s, side, 5).map(
      (d): Item => ({ kind: "dest", label: d.label, href: d.href })
    );
    const faqs = matchFaq(s, side, 4).map((f): Item => ({ kind: "faq", faq: f }));
    return [...dests, ...faqs];
  }, [debouncedQ, side]);

  const shouldRender = focused || closing;
  const trimmed = q.trim();
  // Only claim "no matches" once the debounce has caught up with what is in
  // the box, so the empty state never flashes mid-word.
  const settled = debouncedQ.trim() === trimmed;
  const searchHref = side === "pro" ? "/pro/search" : "/search";
  const askHref =
    side === "pro"
      ? `/pro/ask?q=${encodeURIComponent(trimmed)}`
      : `/chats?lead=ask-hearth&q=${encodeURIComponent(trimmed)}`;
  // The two shells keep their own accents: bark on the homeowner side, hearth
  // ember on the pro side, matching each header's palette.
  const focusBorder =
    side === "pro"
      ? "focus:border-hearth-500 dark:focus:border-hearth-500"
      : "focus:border-bark-500 dark:focus:border-bark-500";
  const rowHover = side === "pro" ? "hover:bg-hearth-50" : "hover:bg-bark-50";
  const rowActive = side === "pro" ? "bg-hearth-50" : "bg-bark-50";

  function close() {
    setFocused(false);
    inputRef.current?.blur();
  }

  function navigate(href: string) {
    setFocused(false);
    // Wrap in a transition so the left icon can flip to a spinner the instant
    // they pick, rather than the box sitting dead until the RSC payload lands.
    startTransition(() => router.push(href));
  }

  function go(query: string) {
    const s = query.trim();
    if (s) navigate(`${searchHref}?q=${encodeURIComponent(s)}`);
    else setFocused(false);
  }

  function select(item: Item) {
    if (item.kind === "dest") {
      navigate(item.href);
      return;
    }
    // FAQ rows expand their answer inline instead of leaving the page; the
    // expanded answer carries an "Open page" link when the entry has one.
    setOpenFaq((cur) => (cur === item.faq.question ? null : item.faq.question));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? items.length - 1 : i - 1));
    } else if (e.key === "Enter" && activeIndex >= 0 && activeIndex < items.length) {
      // Enter on a highlighted row picks it; without a highlight the form's
      // own submit below still routes to the search page.
      e.preventDefault();
      select(items[activeIndex]);
    }
  }

  // Shared row classes: 44px minimum height on phones per the house rule.
  const rowBase =
    "block w-full rounded-md px-2 py-1.5 text-left text-sm active:opacity-70 max-sm:flex max-sm:min-h-11 max-sm:items-center";

  const destItems = items.filter((i) => i.kind === "dest");
  const faqItems = items.filter((i) => i.kind === "faq");

  return (
    <div
      className="relative"
      onFocus={() => {
        if (blurTimer.current) clearTimeout(blurTimer.current);
        setFocused(true);
      }}
      onBlur={() => {
        blurTimer.current = setTimeout(() => setFocused(false), 120);
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(q);
        }}
        className="relative"
        role="search"
      >
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-500 dark:text-stone-400">
          {isPending ? (
            <InlineSpinner size={16} />
          ) : (
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
          )}
        </span>
        <input
          ref={inputRef}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search"
          aria-label="Search"
          aria-autocomplete="list"
          // w-24 at rest, not w-32: this box sits in a header row capped at
          // max-w-5xl that was 130px over budget, and 96px is exactly enough
          // for the magnifier and the word "Search". It still expands to w-48
          // the moment it has focus, which is when the extra width is worth
          // anything. text-base (16px) at EVERY width, with no sm:text-sm
          // override: this box only ever renders at sm and up (both navs hide
          // it below sm), so a sm:text-sm here would make it 14px in the only
          // sizes it is visible - including iPad-portrait touch - and iOS
          // Safari zooms the page on focus of any input under 16px. Same
          // reasoning as `.input` in globals.css.
          className={`w-24 rounded-full border border-stone-200 bg-white py-1.5 pl-8 pr-3 text-base text-stone-700 transition-all placeholder:text-stone-500 focus:w-48 focus:outline-none dark:border-white/10 dark:bg-stone-900 dark:text-stone-200 ${focusBorder}`}
        />
      </form>

      {shouldRender && (
        <div
          className={`absolute right-0 z-30 mt-1 w-72 rounded-xl border border-stone-200 bg-white p-2 shadow-menu dark:border-white/10 dark:bg-stone-700 ${
            focused ? "motion-safe:animate-fade-scale" : "motion-safe:animate-fade-scale-out"
          }`}
        >
          {trimmed === "" && (
            <>
              <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
                Try searching
              </p>
              {EXAMPLES[side].map((ex) => (
                <button
                  key={ex}
                  type="button"
                  // Keep focus on the input so the click registers before blur
                  // hides this panel. Same on every row below.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => go(ex)}
                  className={`${rowBase} ${rowHover} text-stone-700 dark:text-stone-300 dark:hover:bg-stone-600`}
                >
                  {ex}
                </button>
              ))}
            </>
          )}

          {trimmed !== "" && items.length > 0 && (
            <div role="listbox" aria-label="Search suggestions">
              {destItems.length > 0 && (
                <>
                  <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
                    Go to
                  </p>
                  {destItems.map((item) => {
                    const idx = items.indexOf(item);
                    return (
                      <button
                        key={item.kind === "dest" ? item.href : idx}
                        type="button"
                        role="option"
                        aria-selected={idx === activeIndex}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => select(item)}
                        className={`${rowBase} ${rowHover} text-stone-700 dark:text-stone-300 dark:hover:bg-stone-600 ${
                          idx === activeIndex ? `${rowActive} dark:bg-stone-600` : ""
                        }`}
                      >
                        {item.kind === "dest" ? item.label : null}
                      </button>
                    );
                  })}
                </>
              )}
              {faqItems.length > 0 && (
                <>
                  <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
                    FAQ
                  </p>
                  {faqItems.map((item) => {
                    if (item.kind !== "faq") return null;
                    const idx = items.indexOf(item);
                    const expanded = openFaq === item.faq.question;
                    return (
                      <div key={item.faq.question}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={idx === activeIndex}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => select(item)}
                          className={`${rowBase} ${rowHover} font-medium text-stone-700 dark:text-stone-300 dark:hover:bg-stone-600 ${
                            idx === activeIndex ? `${rowActive} dark:bg-stone-600` : ""
                          }`}
                        >
                          {item.faq.question}
                        </button>
                        {expanded && (
                          <div className="px-2 pb-2 pt-0.5">
                            <p className="text-xs leading-relaxed text-stone-600 dark:text-stone-300">
                              {item.faq.answer}
                            </p>
                            {item.faq.href && (
                              <button
                                type="button"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => navigate(item.faq.href as string)}
                                className="mt-1 text-xs font-medium text-bark-700 hover:underline max-sm:flex max-sm:min-h-11 max-sm:items-center dark:text-stone-300"
                              >
                                Open page
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {trimmed !== "" && settled && items.length === 0 && (
            <div className="px-2 py-1.5">
              <p className="text-sm text-stone-600 dark:text-stone-300">
                No matches. Try the FAQ or ask Hearth.
              </p>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => navigate(askHref)}
                className={`${rowBase} ${rowHover} -mx-2 mt-1 w-[calc(100%+1rem)] font-medium text-stone-700 dark:text-stone-300 dark:hover:bg-stone-600`}
              >
                Ask Hearth: &ldquo;{trimmed}&rdquo;
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => navigate(side === "pro" ? "/pro/help" : "/account/help")}
                className={`${rowBase} ${rowHover} -mx-2 w-[calc(100%+1rem)] text-stone-700 dark:text-stone-300 dark:hover:bg-stone-600`}
              >
                Browse help and FAQ
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
