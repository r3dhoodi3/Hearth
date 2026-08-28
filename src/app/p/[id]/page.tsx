import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { JOB_CATEGORIES, labelFor } from "@/lib/constants";
import { isAcceptableCustomCategory } from "@/lib/customCategory";
import Logo from "@/components/Logo";
import RequestQuoteForm from "./RequestQuoteForm";
import BackLink from "./BackLink";
import ReportSheet from "@/components/ReportSheet";
import BlockMenu from "@/components/BlockMenu";
import { requestProAction } from "@/app/(app)/contractors/actions";

// Public, shareable business page for a pro: /p/<contractor_id> or, once
// migration 0043 lands, /p/<slug>. No account needed. Data comes from the
// public_pro_profile RPC (0033, extended with 'slug' in 0043), which returns
// only safe fields: name, categories, the REAL rating/reviews (same math and
// ordering as everywhere else, membership never touches them), the free
// license/insurance "on file" booleans (0109, shown for every pro), and, for
// Pro members only, logo + about. Never contact info.
//
// STAYS DYNAMIC, deliberately, even though this is the most SEO-valuable
// surface in the app. The root layout's cookie read is gone (see
// src/app/layout.tsx), so the remaining blocker is entirely in the body below:
// auth.getUser() decides between a real direct-request form (signed-in
// homeowner, migration 0104) and the create-an-account link. Adding
// generateStaticParams + revalidate here would change nothing on its own - a
// cookies()-backed read inside the page opts the render back out to
// per-request no matter what the segment config says - and forcing it static
// would break the signed-in "Request a quote" CTA, which is the page's whole
// conversion path. Making this static means moving that one CTA decision into
// a client component that resolves the session in the browser (RequestQuoteForm
// can import requestProAction directly), leaving the profile body - the part
// Google actually indexes - free to prerender against the RPC with
// generateStaticParams: [] + revalidate. Worth doing; too big for this pass.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Render-side moderation for a pro's own custom service names.
//
// isAcceptableCustomCategory (src/lib/customCategory.ts) gates the "Other" box
// at WRITE time, but it shipped after rows already existed and it cannot reach
// backwards: a live row still carries a slur in its categories array, printed
// verbatim next to a business name on this page. Re-running the same pure
// function at render is the cheap fix - no query, no round trip, and the gate
// stays in one place.
//
// Canonical values are checked FIRST and pass through untouched. That order
// matters: isAcceptableCustomCategory deliberately REJECTS canonical strings
// (typed into the "Other" box they are duplicates), so filtering on it alone
// would wipe every real category off the page.
const CANONICAL_CATEGORY_VALUES = new Set<string>(
  JOB_CATEGORIES.map((c) => c.value)
);

function visibleCategories(categories: string[]): string[] {
  return categories.filter(
    (c) => CANONICAL_CATEGORY_VALUES.has(c) || isAcceptableCustomCategory(c)
  );
}

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

type PublicReview = {
  // Optional: absent until migration 0138 runs, which adds the review's id to
  // public_pro_profile's payload. A review with no id gets no Report control
  // rather than one pointing at nothing.
  id?: string;
  rating: number;
  comment: string | null;
  created_at: string;
};

type PublicProjectPhoto = {
  url: string;
  // Already gated in the RPC: collapses to false unless the pro is a member,
  // same m.live gate as logo/about.
  is_before: boolean;
};

type PublicProject = {
  title: string;
  category: string | null;
  description: string | null;
  months: string | null;
  photos: PublicProjectPhoto[];
};

type PublicProfile = {
  id: string;
  // Optional: absent until migration 0043 runs (0033's payload has no slug).
  slug?: string | null;
  name: string;
  categories: string[];
  created_at: string;
  rating: number | null;
  review_count: number;
  member: boolean;
  logo_url: string | null;
  about: string | null;
  has_license: boolean;
  has_insurance: boolean;
  // Optional outbound review-page links (0110): absent until migration 0110
  // runs. Plain outbound links only - the page renders a "See our reviews"
  // button, never imported review content or star counts. Free trust signal,
  // never gated on Pro membership.
  yelp_url?: string | null;
  google_reviews_url?: string | null;
  // Optional: absent until migration 0055 runs. Real CSLB verification
  // timestamp, only ever set on an actually-confirmed license (0055) - never
  // gated behind Pro membership, unlike has_license/has_insurance above.
  license_verified_at?: string | null;
  // Optional: absent until migration 0057 runs. Real Checkr background
  // check timestamp, only ever set on a 'clear' result (0057) - never gated
  // behind Pro membership, same reasoning as license_verified_at. A
  // 'consider' or in-progress check is never exposed here at all: it is
  // indistinguishable from having never started one.
  background_checked_at?: string | null;
  reviews: PublicReview[];
  // Optional: absent until migration 0045 runs (older payloads have no
  // projects key).
  projects?: PublicProject[];
};

// cache(): generateMetadata and the page body both call this, so per-request
// memoization keeps it at one RPC round-trip (same pattern as subscription.ts).
const loadProfile = cache(
  async (
    id: string
  ): Promise<{ profile: PublicProfile | null; unavailable: boolean }> => {
    const supabase = await createClient();
    // Cast: the generated types don't know this RPC (database.types.ts is not
    // regenerated here).
    const { data, error } = await (supabase.rpc as any)("public_pro_profile", {
      p_contractor: id,
    });
    // A missing function (migration 0033 not applied yet) must degrade to a
    // soft "not ready" page, never a crash.
    if (error) return { profile: null, unavailable: true };
    return {
      profile: (data as PublicProfile | null) ?? null,
      unavailable: false,
    };
  }
);

// The [id] segment accepts BOTH a raw contractor UUID and a slug (0043).
// UUID-shaped params skip the lookup entirely, so UUID URLs keep working even
// before the slug migration runs. Non-UUID params resolve through the
// public_pro_id_for_slug RPC; if that function doesn't exist yet (pre-0043),
// slug URLs soft-fail to the "not ready" card instead of crashing.
const resolveContractorId = cache(
  async (
    param: string
  ): Promise<{ id: string | null; unavailable: boolean }> => {
    if (UUID_RE.test(param)) return { id: param, unavailable: false };
    const supabase = await createClient();
    // Cast: the generated types don't know this RPC (database.types.ts is not
    // regenerated here).
    const { data, error } = await (supabase.rpc as any)(
      "public_pro_id_for_slug",
      { p_slug: param }
    );
    if (error) return { id: null, unavailable: true };
    return { id: (data as string | null) ?? null, unavailable: false };
  }
);

// Canonical path prefers the slug form once the profile has one; the UUID
// form stays valid but points search engines at the single slug URL.
function canonicalPath(profile: PublicProfile): string {
  return `/p/${profile.slug ?? profile.id}`;
}

export async function generateMetadata(
  props: {
    params: Promise<{ id: string }>;
  }
): Promise<Metadata> {
  const params = await props.params;
  const { id } = await resolveContractorId(params.id);
  if (!id) return { title: "Hearth" };
  const { profile } = await loadProfile(id);
  if (!profile) return { title: "Hearth" };

  const title = `${profile.name} on Hearth`;
  const description =
    profile.review_count > 0 && profile.rating != null
      // "verified" was doing more work than the rule behind it. What Hearth
      // actually checks (leave_review, migrations 0017/0082/0132) is that the
      // reviewer owned the property on a job this pro was hired for, that it
      // is not the pro's own account, and that it is not a linked second
      // account. That is real, so the description says it plainly instead of
      // leaning on a word the FTC's consumer-review rule reads as a claim.
      // LAWYER: check that "from homeowners who hired them" is a safe way to
      // describe review eligibility under the FTC Rule on Consumer Reviews
      // and Testimonials (16 CFR 465), and confirm dropping "verified" here
      // is the right call rather than defining the term on the page.
      ? `${profile.name} is rated ${profile.rating} from ${profile.review_count} review${profile.review_count === 1 ? "" : "s"} on Hearth, left by homeowners who hired them. See reviews and services.`
      : `Reviews and services for ${profile.name}, a home service pro on Hearth.`;
  const url = `${SITE_URL}${canonicalPath(profile)}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: "Hearth",
      type: "website",
      // og:image comes from the colocated opengraph-image.tsx route; Next
      // wires it up automatically for this segment.
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

// JSON-LD for Google review-star rich results. Hearth hosts third-party
// reviews, so LocalBusiness + AggregateRating markup is eligible (a pro's own
// site would not be). Every number mirrors the page render EXACTLY: same
// rating value, same review_count. Per-review markup is deliberately omitted:
// Review schema wants an author, the RPC intentionally exposes no reviewer
// identity, and inventing one would be fabrication. The aggregate needs no
// authors, so it carries the rich result on its own.
function buildJsonLd(profile: PublicProfile): Record<string, unknown> {
  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: profile.name,
    url: `${SITE_URL}${canonicalPath(profile)}`,
  };
  if (profile.review_count > 0 && profile.rating != null) {
    jsonLd.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: profile.rating,
      reviewCount: profile.review_count,
      bestRating: 5,
      worstRating: 1,
    };
  }
  return jsonLd;
}

function Stars({ rating }: { rating: number }) {
  const full = Math.round(rating);
  return (
    <span className="text-amber-500" aria-hidden>
      {"★".repeat(full)}
      <span className="text-stone-300 dark:text-stone-600">{"★".repeat(5 - full)}</span>
    </span>
  );
}

function NotReadyCard() {
  return (
    <main className="mx-auto max-w-xl px-6 py-16 text-center">
      <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm dark:border-white/10 dark:bg-stone-800">
        {/* Flat warm banner strip, no gradient: hearth-100 in light, a
            translucent hearth tint over the stone-800 card in dark. */}
        <div className="h-20 bg-bark-100 dark:bg-bark-700/30" />
        <div className="px-6 pb-8 pt-2">
          <h1 className="text-xl font-semibold text-stone-900 dark:text-stone-100">
            This page is not ready yet
          </h1>
          <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
            The pro&apos;s public page is still being set up. Please check back
            soon.
          </p>
        </div>
      </div>
      <Link
        href="/pros"
        className="mt-6 inline-block text-sm font-medium text-bark-700 hover:underline dark:text-stone-300"
      >
        Powered by Hearth
      </Link>
    </main>
  );
}

export default async function PublicProPage(
  props: {
    params: Promise<{ id: string }>;
  }
) {
  const params = await props.params;
  const { id, unavailable: slugUnavailable } = await resolveContractorId(
    params.id
  );
  // Slug resolver RPC missing (pre-0043): soft-fail slug URLs only.
  if (slugUnavailable) return <NotReadyCard />;
  // Unknown slug: a real 404, not a soft state.
  if (!id) notFound();

  const { profile, unavailable } = await loadProfile(id);

  if (unavailable) return <NotReadyCard />;

  if (!profile) notFound();

  // "Request a quote" CTA. Signed-in homeowners now get a real DIRECT REQUEST
  // (migration 0104): the form below sends this one pro a private request only
  // they can see and pay to accept, via requestProAction. Signed-out visitors
  // keep the create-an-account-first behavior, carrying the pro's primary
  // category through ?next= so the job form is prefilled after signup (same
  // pattern as /onboarding and /signin).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Every place this page shows or forwards a category reads this list, not
  // the raw one: the chips below, the quote form's category picker, and the
  // ?category= prefill (a rejected value has no business riding a URL either).
  const shownCategories = visibleCategories(profile.categories);
  const primaryCategory = shownCategories[0] ?? "other";
  const quoteHref = `/contractors?category=${encodeURIComponent(primaryCategory)}`;
  const requestQuoteHref = `/homeowner-signup?next=${encodeURIComponent(quoteHref)}`;

  const hasRating = profile.review_count > 0 && profile.rating != null;
  // Trust badges are free for every pro (migration 0109): the self-reported
  // "on file" badge shows whenever there's something on file, member or not,
  // the same as the CSLB and background-check badges below. Membership only
  // gates cosmetics (logo, about).
  const showBadge = profile.has_license || profile.has_insurance;
  const badgeLabel =
    profile.has_license && profile.has_insurance
      ? "License and insurance on file"
      : profile.has_license
        ? "License on file"
        : "Insurance on file";
  const about = profile.member ? (profile.about ?? "").trim() : "";
  // Guard: the RPC only includes 'projects' once migration 0045 has run, so
  // older payloads simply render no section.
  const projects = Array.isArray(profile.projects) ? profile.projects : [];
  // Real CSLB verification (0055): free feature, never gated behind Pro
  // membership - the same policy the "on file" badge above now follows (0109).
  // A 'failed' or 'pending' check is never shown publicly at all - this page
  // only ever renders the positive, confirmed case, straight off a real
  // timestamp.
  const licenseVerifiedAt = profile.license_verified_at ?? null;
  const licenseVerifiedLabel = licenseVerifiedAt
    ? new Date(licenseVerifiedAt).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;
  // Real Checkr background check (0057): same rules as license_verified_at
  // and the "on file" badge - free feature, not gated on membership, and a
  // 'consider' or
  // in-progress check is never shown publicly (indistinguishable from
  // 'none'). This page only ever renders the positive, confirmed case.
  const backgroundCheckedAt = profile.background_checked_at ?? null;
  const backgroundCheckedLabel = backgroundCheckedAt
    ? new Date(backgroundCheckedAt).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <main className="mx-auto max-w-2xl px-6 pb-16 pt-10">
      {/* Structured data for review-star rich results. "<" is escaped to its
          unicode form so review text can never close the script tag. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(buildJsonLd(profile)).replace(
            /</g,
            "\\u003c"
          ),
        }}
      />
      {/* Way back to the browse results (or the public directory on a direct
          link) - homeowners land here mid-browse and expect to return to
          their list. */}
      <BackLink />
      <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm dark:border-white/10 dark:bg-stone-800">
        {/* Flat warm banner strip, no gradient: hearth-100 in light, a
            translucent hearth tint over the stone-800 card in dark. */}
        <div className="h-20 bg-bark-100 dark:bg-bark-700/30" />
        <div className="px-6 pb-6">
          {/* Logo (Pro members) or a neutral monogram */}
          <div className="-mt-8 mb-4">
            {profile.member && profile.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={profile.logo_url}
                alt={`${profile.name} logo`}
                className="h-16 w-16 rounded-2xl bg-white object-cover shadow-sm ring-2 ring-white dark:ring-stone-800"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-stone-200 bg-stone-50 text-xl font-semibold text-stone-500 shadow-sm ring-2 ring-white dark:border-white/10 dark:bg-stone-700 dark:text-stone-400 dark:ring-stone-800">
                {profile.name.slice(0, 1).toUpperCase()}
              </div>
            )}
          </div>

          <h1 className="text-2xl font-bold text-stone-900 dark:text-stone-100">{profile.name}</h1>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            {hasRating ? (
              <span className="font-medium text-stone-700 dark:text-stone-300">
                <Stars rating={profile.rating!} />{" "}
                <span className="tabular-nums">{profile.rating}</span>
                <span className="font-normal text-stone-500 dark:text-stone-400">
                  {" "}
                  · {profile.review_count} review
                  {profile.review_count === 1 ? "" : "s"}
                </span>
              </span>
            ) : (
              <span className="text-stone-500 dark:text-stone-400">No reviews yet</span>
            )}
          </div>

          {showBadge && (
            <div className="mt-3">
              {/* Self-reported: neutral stone, not green, so it can never be
                  mistaken for the real CSLB-verified badge below. */}
              <span className="inline-flex items-center gap-1.5 rounded-full border border-stone-300 bg-stone-100 px-3 py-1 text-xs font-medium text-stone-700 dark:border-white/10 dark:bg-stone-700 dark:text-stone-300">
                <svg
                  viewBox="0 0 24 24"
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M9 15l2 2 4-4" />
                </svg>
                {badgeLabel}
              </span>
              <p className="mt-1 text-xs text-stone-600 dark:text-stone-400">
                Reported by the business, not verified.
              </p>
            </div>
          )}

          {(licenseVerifiedLabel || backgroundCheckedLabel) && (
            <div className="mt-3 flex flex-wrap gap-3">
              {licenseVerifiedLabel && (
                <div>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-green-200 bg-green-50 px-3 py-1 text-xs font-medium text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">
                    <svg
                      viewBox="0 0 24 24"
                      className="h-3.5 w-3.5"
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
                  <p className="mt-1 text-xs text-stone-600 dark:text-stone-400">
                    Checked against the CSLB public database on {licenseVerifiedLabel}.
                  </p>
                </div>
              )}
              {backgroundCheckedLabel && (
                <div>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-green-200 bg-green-50 px-3 py-1 text-xs font-medium text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">
                    <svg
                      viewBox="0 0 24 24"
                      className="h-3.5 w-3.5"
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
                  <p className="mt-1 text-xs text-stone-600 dark:text-stone-400">
                    Background check run by Checkr on {backgroundCheckedLabel}.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Honest neutral empty state: no CSLB-verified license AND nothing
              self-reported on file. Muted stone, not alarming - just states
              the fact so the absence reads as neutral, not as a red flag. */}
          {!licenseVerifiedLabel && !profile.has_license && (
            <div className="mt-3">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-stone-50 px-3 py-1 text-xs font-medium text-stone-500 dark:border-white/10 dark:bg-stone-700 dark:text-stone-400">
                No license listed
              </span>
            </div>
          )}

          {/* Outbound review-page links (0110). Plain links only: never
              embeds review content or shows star counts from those sites, just
              a button that opens the pro's own Yelp / Google page. Sits near
              the trust badges above; the one-line disclaimer keeps clear that
              these are not Hearth-verified. */}
          {(profile.yelp_url || profile.google_reviews_url) && (
            <div className="mt-3">
              <div className="flex flex-wrap gap-2">
                {profile.yelp_url && (
                  <a
                    href={profile.yelp_url}
                    target="_blank"
                    rel="noopener nofollow"
                    className="btn-secondary inline-flex text-sm"
                  >
                    See our reviews on Yelp
                  </a>
                )}
                {profile.google_reviews_url && (
                  <a
                    href={profile.google_reviews_url}
                    target="_blank"
                    rel="noopener nofollow"
                    className="btn-secondary inline-flex text-sm"
                  >
                    See our reviews on Google
                  </a>
                )}
              </div>
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                Reviews on outside sites are not verified by Hearth.
              </p>
            </div>
          )}

          {shownCategories.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {shownCategories.map((c) => (
                <span
                  key={c}
                  className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-0.5 text-xs font-medium text-stone-600 dark:border-white/10 dark:bg-stone-700 dark:text-stone-300"
                >
                  {labelFor(JOB_CATEGORIES, c)}
                </span>
              ))}
            </div>
          )}

          <div className="mt-5">
            {user ? (
              // profile.id is the real contractor UUID (the [id] param may be a
              // slug), which is what requestProAction targets.
              <RequestQuoteForm
                contractorId={profile.id}
                contractorName={profile.name}
                categories={shownCategories}
                action={requestProAction}
              />
            ) : (
              <Link href={requestQuoteHref} className="btn-primary inline-flex">
                Request a quote
              </Link>
            )}
          </div>

          {about && (
            <section className="mt-5 border-t border-stone-100 pt-4 dark:border-white/10">
              <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">About</h2>
              <p className="mt-1 whitespace-pre-line text-sm text-stone-600 dark:text-stone-400">
                {about}
              </p>
            </section>
          )}

          {/* Projects: the pro's own portfolio albums (0045). Deliberately a
              separate section from Reviews; nothing here feeds rating math. */}
          {projects.length > 0 && (
            <section className="mt-5 border-t border-stone-100 pt-4 dark:border-white/10">
              <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                Projects
              </h2>
              <p className="mt-0.5 text-xs text-stone-600 dark:text-stone-400">
                Photos provided by the business.
              </p>
              <ul className="mt-2 space-y-4">
                {projects.map((p, i) => {
                  // Before/After chips only make sense when a pair exists;
                  // for non-members the RPC collapses is_before to false, so
                  // free pros' photos show without badges.
                  const hasPair = p.photos.some((ph) => ph.is_before);
                  return (
                    <li
                      key={i}
                      className="rounded-xl border border-stone-100 bg-stone-50/50 p-3 dark:border-white/10 dark:bg-stone-800/50"
                    >
                      {p.photos.length > 0 && (
                        <div className="flex gap-2 overflow-x-auto">
                          {p.photos.map((ph, j) => (
                            <div key={j} className="relative flex-none">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={ph.url}
                                alt={`${p.title} photo ${j + 1}`}
                                className="h-24 w-24 rounded-lg border border-stone-200 object-cover dark:border-white/10"
                              />
                              {hasPair && (
                                <span
                                  className={`absolute bottom-1 left-1 rounded-full px-1.5 py-0.5 text-xs font-medium ${
                                    ph.is_before
                                      ? "bg-stone-900/70 text-white"
                                      : "bg-green-600/90 text-white"
                                  }`}
                                >
                                  {ph.is_before ? "Before" : "After"}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      <p
                        className={`text-sm font-medium text-stone-900 dark:text-stone-100 ${p.photos.length > 0 ? "mt-2" : ""}`}
                      >
                        {p.title}
                      </p>
                      {(p.category || p.months) && (
                        <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-stone-500 dark:text-stone-400">
                          {p.category && (
                            <span>{labelFor(JOB_CATEGORIES, p.category)}</span>
                          )}
                          {p.category && p.months ? " · " : ""}
                          {p.months ?? ""}
                        </p>
                      )}
                      {p.description && (
                        <p className="mt-1 whitespace-pre-line text-sm text-stone-600 dark:text-stone-400">
                          {p.description}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section className="mt-5 border-t border-stone-100 pt-4 dark:border-white/10">
            <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              Reviews
              {profile.review_count > 0 && (
                <span className="ml-1 font-normal text-stone-500 dark:text-stone-400">
                  ({profile.review_count})
                </span>
              )}
            </h2>
            {profile.reviews.length === 0 ? (
              <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
                No reviews yet. Reviews come from real Hearth jobs only.
              </p>
            ) : (
              <ul className="mt-1 divide-y divide-stone-100 dark:divide-white/10">
                {profile.reviews.map((r, i) => (
                  <li key={i} className="py-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs">
                        <Stars rating={r.rating} />
                      </span>
                      <span className="text-xs text-stone-500 dark:text-stone-400">
                        {r.created_at.slice(0, 10)}
                      </span>
                    </div>
                    {r.comment && (
                      <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">{r.comment}</p>
                    )}
                    {/* Signed-in only: reportContentAction needs an account to
                        record as the reporter, so offering the control to a
                        signed-out visitor would be a button that always fails.
                        They get the /contact link in the row below instead. */}
                    {user && r.id && (
                      <div className="mt-1">
                        <ReportSheet
                          targetType="review"
                          targetId={r.id}
                          label="Report"
                          openLabel="Report this review"
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Moderation row. Quiet by design and last on the page: it should
              be findable when somebody needs it and invisible otherwise.
              Anonymous visitors see only the contact link - blocking needs an
              account to block FROM, and a Block button that bounced you to
              /signin would be a worse answer than not showing it. */}
          {/* Stacked, not a row: both controls expand in place into a panel
              (a reason picker, a confirm step), and a flex row would have to
              reflow around whichever one is open. */}
          <section className="mt-5 space-y-3 border-t border-stone-100 pt-4 dark:border-white/10">
            {user ? (
              <>
                <ReportSheet
                  targetType="contractor"
                  targetId={profile.id}
                  label="Report this business"
                  openLabel="Report this business"
                />
                {/* profile.id is the real contractor UUID even when the URL
                    used a slug. The action resolves the pro's ACCOUNT from it
                    server-side; this page never handles their user id. A pro
                    who lands on their own page gets an honest "You can't block
                    your own account" from the action. */}
                <BlockMenu
                  contractorId={profile.id}
                  personLabel={profile.name}
                />
              </>
            ) : (
              <Link
                href="/contact?topic=abuse"
                className="text-xs text-stone-500 hover:text-red-600 dark:text-stone-400 dark:hover:text-red-400"
              >
                Report abuse or a safety concern
              </Link>
            )}
          </section>
        </div>
      </div>

      <p className="mt-6 text-center text-sm text-stone-500 dark:text-stone-400">
        <Link
          href="/pros"
          className="inline-flex items-center gap-1.5 hover:text-bark-700 hover:underline dark:hover:text-stone-300"
        >
          <Logo className="h-4 w-4" /> Powered by Hearth
        </Link>
      </p>
    </main>
  );
}
