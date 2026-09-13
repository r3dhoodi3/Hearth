"use client";

// C8 (2026-09-07 tester wave): filter taps on this page used to be plain
// <Link>s to /contractors/browse?category=...&rating=..., which meant EVERY
// tap re-ran the whole server component - re-fetching the active property AND
// re-calling browse_pros() over the network - just to change which rows of
// an array already sitting in the browser were shown. That's the same
// "per-option full refetch" shape the leads board's sort buttons had before
// 2026-08-30 (see the long comment at the top of src/lib/leadSort.ts and
// src/app/pro/leads/LeadsBoard.tsx).
//
// Fix, mirroring that same pattern: the server fetches browse_pros ONCE, with
// no category filter (it already returns "a small, launch-market list, never
// paginated" per the RPC's own comment - up to 200 rows, safe to hold in
// memory). This component filters that array in the browser: a tap is a
// pure array filter, not a request. The rating filter already worked this
// way (see the removed comment in page.tsx); category joins it here instead
// of staying a server round trip.
//
// The URL still reflects the current filter (history.replaceState, not a
// navigation - same technique LeadsBoard uses), so a shared or reloaded link
// still lands on the right filter with no flash: the server reads the same
// ?category=&rating= to pick the INITIAL state below, so hydration agrees.

import { useMemo, useState } from "react";
import Link from "next/link";
import { JOB_CATEGORIES, SERVICE_CATEGORIES, labelFor } from "@/lib/constants";
import { isAcceptableCustomCategory } from "@/lib/customCategory";
import { licenseVerifiedOnLine } from "@/lib/guaranteeCopy";
import { MIN_RATING_OPTIONS, type BrowsePro } from "./browseProsShared";

export type { BrowsePro };

const BROWSE_HREF = "/contractors/browse";

export default function BrowseProsBoard({
  allPros,
  initialCategory,
  initialMinRating,
  capped = false,
}: {
  /** Every launch-market pro, unfiltered by category - browse_pros() already
   *  caps this at 200 rows, so holding the whole list client-side costs
   *  nothing a phone can't spare. */
  allPros: BrowsePro[];
  initialCategory: string;
  initialMinRating: number;
  /** True when the server's unfiltered fetch came back AT the RPC's 200-row
   *  cap, which means the list is truncated and filtering it here would hide
   *  matching pros past the cap. Then the category chips navigate instead, so
   *  the database does the filtering (page.tsx re-asks for that one category).
   *  See BROWSE_PROS_ROW_CAP in browseProsShared.ts. */
  capped?: boolean;
}) {
  const [category, setCategory] = useState(initialCategory);
  const [minRating, setMinRating] = useState(initialMinRating);

  // A pure filter over the array the server already fetched: no network, no
  // re-render of anything but this list. review_count > 0 mirrors the card's
  // own hasRating check below - a pro with zero reviews has no real average
  // to filter on, whatever `minRating` happens to be.
  const pros = useMemo(() => {
    return allPros.filter((p) => {
      if (category && !p.categories.includes(category)) return false;
      if (minRating > 0) {
        if (p.review_count <= 0 || p.rating == null || p.rating < minRating) {
          return false;
        }
      }
      return true;
    });
  }, [allPros, category, minRating]);

  // Reflected in the URL, NOT navigated to (same as LeadsBoard's chooseSort):
  // a reload or a shared link still lands on this filter (the server reads
  // ?category=&rating= for the initial props above), while the tap itself
  // costs nothing but a re-render.
  function urlFor(nextCategory: string, nextMinRating: number) {
    const params = new URLSearchParams();
    if (nextCategory) params.set("category", nextCategory);
    if (nextMinRating > 0) params.set("rating", String(nextMinRating));
    const qs = params.toString();
    return qs ? `${BROWSE_HREF}?${qs}` : BROWSE_HREF;
  }

  function pushUrl(nextCategory: string, nextMinRating: number) {
    window.history.replaceState(
      window.history.state,
      "",
      urlFor(nextCategory, nextMinRating)
    );
  }

  function chooseCategory(next: string) {
    setCategory(next);
    pushUrl(next, minRating);
  }

  function chooseMinRating(next: number) {
    setMinRating(next);
    pushUrl(category, next);
  }

  return (
    <>
      {/* Flat category chips, same rounded-full convention as the rest of the
          app. "All" clears the filter. Buttons (a free in-memory filter) until
          the fetched list is truncated at the RPC's cap, at which point they
          become links so the database does the filtering and no matching pro
          past the cap is hidden. The route's loading.tsx is the pending state
          for that navigation. */}
      <div className="-mx-1 flex flex-wrap gap-2 sm:gap-1.5 px-1">
        <CategoryChip
          label="All"
          value=""
          active={!category}
          capped={capped}
          href={urlFor("", minRating)}
          onClick={chooseCategory}
        />
        {SERVICE_CATEGORIES.map((c) => (
          <CategoryChip
            key={c.value}
            label={c.label}
            value={c.value}
            active={category === c.value}
            capped={capped}
            href={urlFor(c.value, minRating)}
            onClick={chooseCategory}
          />
        ))}
      </div>

      {/* B9: minimum-rating filter, same flat chip convention. "Any" clears it. */}
      <div className="-mx-1 flex flex-wrap gap-2 sm:gap-1.5 px-1">
        {MIN_RATING_OPTIONS.map((r) => (
          <FilterChip
            key={r}
            label={r === 0 ? "Any rating" : `${r}★ & up`}
            onClick={() => chooseMinRating(r)}
            active={minRating === r}
          />
        ))}
      </div>

      {pros.length === 0 ? (
        <div className="card text-sm text-stone-500 dark:text-stone-400">
          {minRating > 0 && allPros.length > 0 ? (
            <p>
              No pros at {minRating}★ & up{category ? ` for ${labelFor(JOB_CATEGORIES, category)}` : ""} yet.
              Try a lower rating, or{" "}
              <button
                type="button"
                onClick={() => chooseMinRating(0)}
                className="text-bark-700 underline hover:no-underline dark:text-stone-300"
              >
                clear the rating filter
              </button>
              .
            </p>
          ) : category ? (
            <p>
              No pros listed for {labelFor(JOB_CATEGORIES, category)} yet. OakTend
              is still new in some areas, so pro coverage is catching up. Try
              another category, or{" "}
              <Link href="/contractors" className="text-bark-700 hover:underline dark:text-stone-300">
                post the job
              </Link>{" "}
              so matching pros can come to you.
            </p>
          ) : (
            <p>
              No pros are listed here yet. OakTend is still new in some areas, so
              pro coverage is catching up. You can still{" "}
              <Link href="/contractors" className="text-bark-700 hover:underline dark:text-stone-300">
                post a job
              </Link>{" "}
              and matching pros will be alerted.
            </p>
          )}
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* Two-up from sm on: the detailed cards need full width on a phone,
              but a single column wasted the horizontal space on tablet/desktop.
              gap-3 matches the old space-y-3 rhythm. */}
          {pros.map((p) => (
            <ProCard key={p.id} pro={p} />
          ))}
        </ul>
      )}
    </>
  );
}

// One chip look, whether the chip is a button or a link, so the truncated-list
// fallback below is invisible to anyone reading the page.
function chipClass(active: boolean) {
  return `inline-flex shrink-0 touch-manipulation items-center whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition-colors max-sm:min-h-11 active:bg-stone-100 dark:active:bg-white/10 ${
    active
      ? "border-bark-200 bg-bark-100 text-bark-700 dark:border-bark-700 dark:bg-bark-700 dark:text-stone-200"
      : "border-stone-200 bg-stone-50 text-stone-600 sm:hover:border-bark-200 sm:hover:text-bark-700 dark:border-white/10 dark:bg-stone-800 dark:text-stone-300 dark:hover:text-stone-200"
  }`;
}

function FilterChip({
  label,
  onClick,
  active,
}: {
  label: string;
  onClick: () => void;
  active: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={chipClass(active)}
    >
      {label}
    </button>
  );
}

// A category chip. Normally a button: the whole launch-market list is already
// in memory, so the tap is a filter, not a request. When `capped` is true the
// server's list was truncated at the RPC's 200-row cap, so filtering here
// would hide matching pros past it: the chip becomes a real link and the
// database does the filtering instead (page.tsx re-asks browse_pros for that
// one category). Same markup either way.
function CategoryChip({
  label,
  value,
  active,
  capped,
  href,
  onClick,
}: {
  label: string;
  value: string;
  active: boolean;
  capped: boolean;
  href: string;
  onClick: (next: string) => void;
}) {
  if (capped) {
    return (
      <Link
        href={href}
        aria-current={active ? "true" : undefined}
        className={chipClass(active)}
      >
        {label}
      </Link>
    );
  }
  return <FilterChip label={label} onClick={() => onClick(value)} active={active} />;
}

// Render-side moderation for a pro's own custom service names, matching
// /p/[id]/page.tsx. isAcceptableCustomCategory (src/lib/customCategory.ts)
// gates the "Other" box at WRITE time, but it shipped after rows already
// existed and cannot reach backwards: a live row still carries a slur in its
// categories array, printed verbatim on its card here. Re-running the same
// pure function at render costs nothing and keeps the rule in one place.
//
// Canonical values are checked FIRST and pass through untouched - the function
// deliberately REJECTS canonical strings (typed into the "Other" box they are
// duplicates), so filtering on it alone would blank every real chip.
const CANONICAL_CATEGORY_VALUES = new Set<string>(
  JOB_CATEGORIES.map((c) => c.value)
);

function visibleCategories(categories: string[]): string[] {
  return categories.filter(
    (c) => CANONICAL_CATEGORY_VALUES.has(c) || isAcceptableCustomCategory(c)
  );
}

function ProCard({ pro }: { pro: BrowsePro }) {
  const profileHref = `/p/${pro.slug ?? pro.id}`;
  const shownCategories = visibleCategories(pro.categories);
  const hasRating = pro.review_count > 0 && pro.rating != null;
  // Trust fields from migration 0111 are optional: each derives to null or
  // empty here, so cards from an older RPC render exactly as before.
  const rawComment = (pro.latest_review_comment ?? "").trim();
  // Truncate on code points (Array.from), not UTF-16 units: a plain
  // .slice(0, 90) can cut an emoji's surrogate pair in half and render a
  // replacement character mid-snippet.
  const commentChars = Array.from(rawComment);
  const reviewSnippet =
    commentChars.length > 90
      ? `${commentChars.slice(0, 90).join("").trimEnd()}...`
      : rawComment;
  const photoUrls = (pro.photo_urls ?? []).slice(0, 3);
  const sinceYear = pro.created_at
    ? new Date(pro.created_at).getFullYear()
    : NaN;
  const memberSince = Number.isFinite(sinceYear) ? sinceYear : null;
  return (
    <li className="card">
      <div className="flex gap-3">
        {/* Logo (Pro members) or a neutral monogram, matching the /p/<id>
            header avatar at a smaller size. */}
        {pro.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={pro.logo_url}
            alt={`${pro.name} logo`}
            className="h-12 w-12 shrink-0 rounded-xl bg-white object-cover ring-1 ring-stone-200 dark:ring-white/10"
          />
        ) : (
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-stone-200 bg-stone-50 text-lg font-semibold text-stone-500 dark:border-white/10 dark:bg-stone-700 dark:text-stone-400">
            {pro.name.slice(0, 1).toUpperCase()}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <Link
              href={profileHref}
              // min-w-0 + break-words: one long unbroken business name must
              // wrap inside the card at 320px instead of overflowing it.
              // Normal names are unaffected.
              className="min-w-0 break-words font-medium text-stone-900 hover:underline dark:text-stone-100"
            >
              {pro.name}
            </Link>
            {hasRating ? (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                ★ {pro.rating}
                <span className="text-stone-500 dark:text-stone-400">
                  {" "}
                  · {pro.review_count} review
                  {pro.review_count === 1 ? "" : "s"}
                </span>
              </span>
            ) : (
              <span className="text-xs text-stone-500 dark:text-stone-400">New</span>
            )}
          </div>

          {pro.service_area && (
            <p className="mt-0.5 truncate text-xs text-stone-500 dark:text-stone-400">
              {pro.service_area}
            </p>
          )}

          {/* Latest review snippet (0111): one quiet truncated line, reviewer
              kept anonymous. Only renders when a non-empty comment exists. */}
          {reviewSnippet && (
            <p className="mt-1 truncate text-xs italic text-stone-500 dark:text-stone-400">
              &ldquo;{reviewSnippet}&rdquo;
            </p>
          )}

          {/* Trust chips: same honest license distinction as the applicant
              card on /contractors, and always shown (trust badges are free for
              every pro, migration 0109). Green "License verified" only for a
              real CSLB-confirmed license; neutral gray "License on file" for a
              self-reported one; muted "No license listed" when there is
              neither. Background check is its own green chip. There is no
              insurance chip: a pro's proof of insurance is private (it lives on
              the Credentials tab of /pro/profile), and a homeowner who wants it
              asks the pro for a copy. has_insurance is still on the type
              because the RPC returns it; nothing here renders it. */}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
              {pro.license_verified_at ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  License verified
                </span>
              ) : pro.has_license ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-stone-300 bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-700 dark:border-white/10 dark:bg-stone-700 dark:text-stone-300">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M9 15l2 2 4-4" />
                  </svg>
                  License on file
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-xs font-medium text-stone-500 dark:border-white/10 dark:bg-stone-700 dark:text-stone-400">
                  No license listed
                </span>
              )}
              {pro.background_checked_at && (
                <span className="inline-flex items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  Background checked
                </span>
              )}
              {/* The outbound review-page links (0111, columns from 0110) used
                  to sit in this chip row. Removed 2026-09-12: they were a route
                  off the platform before any lead record exists. The columns
                  stay on BrowsePro because the query still selects them. */}
          </div>
          {/* What the green badge actually checked, and when: same wording
              the public profile page uses (src/lib/guaranteeCopy.ts), so a
              "License verified" chip is never just a claim with nothing
              behind it. */}
          {pro.license_verified_at && (
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              {licenseVerifiedOnLine(
                new Date(pro.license_verified_at).toLocaleDateString("en-US", {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })
              )}
            </p>
          )}

          {shownCategories.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {shownCategories.map((c) => (
                <span
                  key={c}
                  className="rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-xs font-medium text-stone-600 dark:border-white/10 dark:bg-stone-700 dark:text-stone-300"
                >
                  {labelFor(JOB_CATEGORIES, c)}
                </span>
              ))}
            </div>
          )}

          {/* Photo strip (0111): up to 3 project thumbnails, "after" shots
              preferred by the RPC. Skipped entirely when the pro has no
              photos, so the card stays as compact as before. */}
          {photoUrls.length > 0 && (
            <div className="mt-2 flex gap-1.5">
              {photoUrls.map((url, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={`${url}-${i}`}
                  src={url}
                  alt=""
                  loading="lazy"
                  className="h-14 w-14 rounded-lg bg-stone-100 object-cover ring-1 ring-stone-200 dark:bg-stone-700 dark:ring-white/10"
                />
              ))}
            </div>
          )}

          {pro.project_count > 0 && (
            <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
              {pro.project_count} project
              {pro.project_count === 1 ? "" : "s"} on file
            </p>
          )}

          {memberSince && (
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-500">
              On OakTend since {memberSince}
            </p>
          )}

          <div className="mt-3">
            <Link href={profileHref} className="btn-primary inline-flex text-sm">
              Ask for a quote
            </Link>
          </div>
        </div>
      </div>
    </li>
  );
}
