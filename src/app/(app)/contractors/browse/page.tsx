import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { JOB_CATEGORIES, SERVICE_CATEGORIES, labelFor } from "@/lib/constants";
import { isAcceptableCustomCategory } from "@/lib/customCategory";

// Homeowner-facing pro directory. Lists claimed, launch-market pros from the
// browse_pros() RPC (migration 0104, trust fields added in 0111), which
// returns safe public fields only (never contact). A category chip filters
// the list; each card links to the pro's public page (/p/<slug or id>), where
// a signed-in homeowner can ask that pro for a quote directly.

type BrowsePro = {
  id: string;
  slug: string | null;
  name: string;
  categories: string[];
  rating: number | null;
  review_count: number;
  has_license: boolean;
  license_verified_at: string | null;
  background_checked_at: string | null;
  logo_url: string | null;
  service_area: string | null;
  project_count: number;
  // Trust upgrades: absent until migration 0111 runs, so every field below is
  // optional and the card renders exactly as before when they are missing.
  has_insurance?: boolean | null;
  yelp_url?: string | null;
  google_reviews_url?: string | null;
  latest_review_comment?: string | null;
  latest_review_rating?: number | null;
  photo_urls?: string[] | null;
  created_at?: string | null;
};

export default async function BrowseProsPage(
  props: {
    searchParams: Promise<{ category?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const supabase = await createClient();

  // Same guard the rest of (app) uses: no active property means the owner
  // hasn't onboarded a home yet.
  const property = await getActiveProperty();
  if (!property) redirect("/onboarding");

  // Reuse the same param name /contractors uses for its category prefill.
  const category = searchParams.category ?? "";
  const filter = SERVICE_CATEGORIES.some((c) => c.value === category)
    ? category
    : "";

  // browse_pros is SECURITY DEFINER and safe for any authenticated user. Cast:
  // the generated types know the function, but keeping the row shape explicit
  // here documents exactly what the card renders.
  const { data, error } = await (supabase.rpc as any)("browse_pros", {
    p_category: filter || null,
  });
  const pros = (error ? [] : ((data as BrowsePro[]) ?? [])) as BrowsePro[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Browse pros
        </h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Find a local pro and ask them for a quote directly. Only the pro you
          ask sees your request. Prefer to let pros come to you?{" "}
          <Link href="/contractors" className="text-bark-700 hover:underline dark:text-stone-300">
            Post a job
          </Link>{" "}
          instead.
        </p>
      </div>

      {/* Flat category chips, same rounded-full convention as the rest of the
          app. "All" clears the filter. */}
      <div className="-mx-1 flex flex-wrap gap-2 sm:gap-1.5 px-1">
        <FilterChip label="All" href="/contractors/browse" active={!filter} />
        {SERVICE_CATEGORIES.map((c) => (
          <FilterChip
            key={c.value}
            label={c.label}
            href={`/contractors/browse?category=${encodeURIComponent(c.value)}`}
            active={filter === c.value}
          />
        ))}
      </div>

      {pros.length === 0 ? (
        <div className="card text-sm text-stone-500 dark:text-stone-400">
          {filter ? (
            <p>
              No pros listed for {labelFor(JOB_CATEGORIES, filter)} yet. Hearth
              is still new in some areas, so pro coverage is catching up. Try
              another category, or{" "}
              <Link href="/contractors" className="text-bark-700 hover:underline dark:text-stone-300">
                post the job
              </Link>{" "}
              so matching pros can come to you.
            </p>
          ) : (
            <p>
              No pros are listed here yet. Hearth is still new in some areas, so
              pro coverage is catching up. You can still{" "}
              <Link href="/contractors" className="text-bark-700 hover:underline dark:text-stone-300">
                post a job
              </Link>{" "}
              and matching pros will be alerted.
            </p>
          )}
        </div>
      ) : (
        <ul className="space-y-3">
          {pros.map((p) => (
            <ProCard key={p.id} pro={p} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterChip({
  label,
  href,
  active,
}: {
  label: string;
  href: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium max-sm:min-h-11 ${
        active
          ? "border-bark-200 bg-bark-100 text-bark-700 dark:border-bark-700 dark:bg-bark-700 dark:text-stone-200"
          : "border-stone-200 bg-stone-50 text-stone-600 sm:hover:border-bark-200 sm:hover:text-bark-700 dark:border-white/10 dark:bg-stone-800 dark:text-stone-300 dark:hover:text-stone-200"
      }`}
    >
      {label}
    </Link>
  );
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
              neither. Background check is its own green chip. Insurance (0111)
              is self-reported, so it gets the same neutral gray as "License on
              file", never green. */}
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
              {pro.has_insurance && (
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
                    <path d="M12 22s8-3.6 8-9V5l-8-3-8 3v8c0 5.4 8 9 8 9z" />
                  </svg>
                  Insurance on file
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
              {/* Outbound review-page links (0111, columns from 0110). Plain
                  links only, never imported review content. Standalone anchors
                  in the chip row: the card has no wrapping link, so these can
                  never nest inside the name or CTA anchors. */}
              {pro.yelp_url && (
                <a
                  href={pro.yelp_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-xs font-medium text-stone-600 max-sm:min-h-11 max-sm:px-3 sm:hover:border-bark-200 sm:hover:text-bark-700 dark:border-white/10 dark:bg-stone-700 dark:text-stone-300 dark:hover:text-stone-200"
                >
                  Reviews on Yelp
                </a>
              )}
              {pro.google_reviews_url && (
                <a
                  href={pro.google_reviews_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-xs font-medium text-stone-600 max-sm:min-h-11 max-sm:px-3 sm:hover:border-bark-200 sm:hover:text-bark-700 dark:border-white/10 dark:bg-stone-700 dark:text-stone-300 dark:hover:text-stone-200"
                >
                  Reviews on Google
                </a>
              )}
          </div>

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
              On Hearth since {memberSince}
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
