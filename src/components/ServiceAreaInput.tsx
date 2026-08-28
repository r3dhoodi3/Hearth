"use client";

import { useId, useRef, useState } from "react";
import {
  applyCitySuggestion,
  matchOcCities,
  OC_CITIES,
  serviceAreaTokenAt,
} from "@/lib/ocCities";

// Free-text service-area combobox with Orange County city suggestions. On
// focus or click with an empty current token it lists every city
// alphabetically; typing filters via the matcher in src/lib/ocCities.ts
// (name prefix, initials like "fv" or "hb", and a few local nicknames). The
// field can hold several cities ("Irvine, Tustin, ..."), so suggestions apply
// to the token around the caret and accepting one inserts the full city name
// in place of that token. Cities already in the field are shown muted with a
// check and never duplicated. A pinned "All of Orange County" row replaces
// the whole value; picking a specific city afterwards swaps back to just that
// city. Value stays free text and uncontrolled: it submits under `name` and
// anything typed by hand is kept as is.

const ALL_OF_OC = "All of Orange County";

const ALL_CITIES: readonly string[] = [...OC_CITIES].sort((a, b) =>
  a.localeCompare(b)
);

// Lowercased, trimmed comma/semicolon/slash-separated entries of the field.
function tokensOf(value: string): string[] {
  return value
    .split(/[,;/]/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

export default function ServiceAreaInput({
  name,
  className = "input",
  defaultValue = "",
  placeholder,
}: {
  name: string;
  className?: string;
  defaultValue?: string;
  placeholder?: string;
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<{
    start: number;
    end: number;
    query: string;
    caret: number;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<string[]>([]);
  const [present, setPresent] = useState<Set<string>>(new Set());
  // -1 means no row is highlighted (list open, Enter keeps form behavior).
  const [active, setActive] = useState(-1);

  // Index 0 is always the pinned "All of Orange County" row.
  const options = open ? [ALL_OF_OC, ...items] : [];

  const optionId = (i: number) => `${listId}-opt-${i}`;

  function setActiveAndScroll(i: number) {
    setActive(i);
    requestAnimationFrame(() => {
      document.getElementById(optionId(i))?.scrollIntoView({ block: "nearest" });
    });
  }

  // Recomputes the token under the caret and what the dropdown should show:
  // the full alphabetical list when the token is empty, matcher results
  // (existing cap) when it is not. With an empty token nothing is
  // highlighted (active -1) so a reflexive Enter can't wipe the field with
  // the pinned "All of Orange County" row. forceList (explicit ArrowDown)
  // shows the full list even when this would normally close, e.g. because
  // the token already reads exactly like a city.
  function refresh(forceList = false) {
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const { start, end, query } = serviceAreaTokenAt(el.value, caret);
    tokenRef.current = { start, end, query, caret };
    setPresent(new Set(tokensOf(el.value)));
    if (!query) {
      setItems([...ALL_CITIES]);
      setActive(-1);
      setOpen(true);
      return;
    }
    const matches = matchOcCities(query);
    // Close once the token already reads exactly like the only match, or the
    // pro is typing something that is not on the list (free text stays free).
    const done =
      matches.length === 1 && matches[0].toLowerCase() === query.toLowerCase();
    if (done || matches.length === 0) {
      if (forceList) {
        setItems([...ALL_CITIES]);
        setActive(-1);
        setOpen(true);
        return;
      }
      setItems([]);
      setOpen(false);
      return;
    }
    setItems(matches);
    // Start on the first real match, past the pinned row.
    setActive(1);
    setOpen(true);
  }

  function accept(option: string) {
    const el = inputRef.current;
    if (!el) return;

    const finish = (value: string, caret: number) => {
      el.value = value;
      el.focus();
      el.setSelectionRange(caret, caret);
      setOpen(false);
    };

    if (option === ALL_OF_OC) {
      // Listing all 39 cities is noise; the shortcut replaces the whole field.
      finish(ALL_OF_OC, ALL_OF_OC.length);
      return;
    }

    // Picking a specific city while the field says "All of Orange County"
    // swaps back to just that city.
    if (tokensOf(el.value).includes(ALL_OF_OC.toLowerCase())) {
      finish(option, option.length);
      return;
    }

    const token = tokenRef.current;
    if (!token) return;

    // With an empty query and the caret before a downstream token
    // ("Irvine, |Tustin"), applyCitySuggestion INSERTS at the caret instead
    // of replacing, so the duplicate check must keep that token in play.
    const inserting = !token.query && token.caret < token.end;

    // Already listed elsewhere in the field: never duplicate. Drop the
    // partial token (if any) and close.
    const rest = inserting
      ? el.value
      : el.value.slice(0, token.start) + el.value.slice(token.end);
    if (tokensOf(rest).includes(option.toLowerCase())) {
      if (token.query) {
        finish(rest, token.start);
      } else {
        el.focus();
        setOpen(false);
      }
      return;
    }

    const next = applyCitySuggestion(
      el.value,
      token.start,
      token.end,
      option,
      token.caret
    );
    finish(next.value, next.caret);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || options.length === 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        // forceList: an explicit ArrowDown opens the full list even when the
        // token already exactly matches a city (refresh alone would close).
        refresh(true);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveAndScroll(active < 0 ? 0 : (active + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveAndScroll(
        active < 0
          ? options.length - 1
          : (active - 1 + options.length) % options.length
      );
    } else if (e.key === "Enter") {
      if (active < 0) {
        // Nothing highlighted (list opened on an empty token): close and
        // keep Enter's normal form behavior instead of grabbing a row.
        setOpen(false);
        return;
      }
      // Pick the highlighted option instead of submitting the form.
      e.preventDefault();
      accept(options[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "Tab") {
      // Close but let focus move on.
      setOpen(false);
    }
  }

  const allOcListed = present.has(ALL_OF_OC.toLowerCase());

  return (
    <div className="relative">
      <input
        ref={inputRef}
        name={name}
        className={className}
        defaultValue={defaultValue}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && active >= 0 ? optionId(active) : undefined
        }
        onInput={() => refresh()}
        onFocus={() => refresh()}
        onClick={() => refresh()}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      />
      {open && (
        <div
          id={listId}
          role="listbox"
          // preventDefault keeps the input from blurring (which would close
          // the list) before a click lands, and covers mousedowns on the
          // scroll container / scrollbar too, not just the option rows.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm dark:border-white/10 dark:bg-stone-800"
        >
          <button
            type="button"
            id={optionId(0)}
            role="option"
            aria-selected={active === 0}
            tabIndex={-1}
            onClick={() => accept(ALL_OF_OC)}
            onMouseEnter={() => setActive(0)}
            className={`flex w-full items-center justify-between border-b border-stone-100 px-3 py-2 text-left text-sm font-medium max-sm:min-h-11 dark:border-white/10 ${
              allOcListed
                ? "text-stone-500 dark:text-stone-500"
                : "text-stone-700 dark:text-stone-200"
            } ${active === 0 ? "bg-stone-100 dark:bg-stone-700" : ""}`}
          >
            <span>{ALL_OF_OC}</span>
            {allOcListed && <span aria-hidden="true">&#10003;</span>}
          </button>
          <div className="max-h-[260px] overflow-y-auto py-1">
            {items.map((city, i) => {
              const idx = i + 1;
              const listed = present.has(city.toLowerCase());
              return (
                <button
                  key={city}
                  type="button"
                  id={optionId(idx)}
                  role="option"
                  aria-selected={active === idx}
                  tabIndex={-1}
                  onClick={() => accept(city)}
                  onMouseEnter={() => setActive(idx)}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm max-sm:min-h-11 ${
                    listed
                      ? "text-stone-500 dark:text-stone-500"
                      : "text-stone-700 dark:text-stone-200"
                  } ${active === idx ? "bg-stone-100 dark:bg-stone-700" : ""}`}
                >
                  <span>{city}</span>
                  {listed && <span aria-hidden="true">&#10003;</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
