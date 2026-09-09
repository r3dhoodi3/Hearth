import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { SERVICE_CATEGORIES } from "@/lib/constants";
import BrowseProsBoard from "./BrowseProsBoard";
import {
  MIN_RATING_OPTIONS,
  BROWSE_PROS_ROW_CAP,
  type BrowsePro,
} from "./browseProsShared";

// Homeowner-facing pro directory. Lists claimed, launch-market pros from the
// browse_pros() RPC (migration 0104, trust fields added in 0111), which
// returns safe public fields only (never contact). A category chip and a
// minimum-rating chip filter the list; each card links to the pro's public
// page (/p/<slug or id>), where a signed-in homeowner can ask that pro for a
// quote directly.
//
// C8 (2026-09-07 tester wave): filtering used to be a server round trip per
// tap (a <Link> to a new ?category=&rating=, which re-ran this whole page,
// including a redundant re-fetch of the active property). Fixed by fetching
// browse_pros ONCE here, with no category filter - it already returns a
// small, launch-market list capped at 200 rows - and filtering it in the
// browser (BrowseProsBoard.tsx), the same client-side pattern the leads
// board's sort buttons use. getActiveProperty and the RPC also now run in
// parallel instead of a serial waterfall, since neither depends on the other.

function parseMinRating(raw: string | undefined): number {
  const n = Number(raw);
  return MIN_RATING_OPTIONS.includes(n as (typeof MIN_RATING_OPTIONS)[number])
    ? n
    : 0;
}

export default async function BrowseProsPage(
  props: {
    searchParams: Promise<{ category?: string; rating?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const supabase = await createClient();

  // Independent reads: the property gate and the pros list share nothing, so
  // they go out together instead of one after the other.
  const [property, rpcResult] = await Promise.all([
    getActiveProperty(),
    // browse_pros is SECURITY DEFINER and safe for any authenticated user.
    // No category filter here any more - BrowseProsBoard filters client-side
    // so a filter tap costs no network round trip.
    (supabase.rpc as any)("browse_pros", { p_category: null }),
  ]);
  // Same guard the rest of (app) uses: no active property means the owner
  // hasn't onboarded a home yet.
  if (!property) redirect("/onboarding");

  const { data, error } = rpcResult as { data: BrowsePro[] | null; error: unknown };
  let allPros = (error ? [] : (data ?? [])) as BrowsePro[];

  // Reuse the same param name /contractors uses for its category prefill.
  const rawCategory = searchParams.category ?? "";
  const initialCategory = SERVICE_CATEGORIES.some((c) => c.value === rawCategory)
    ? rawCategory
    : "";
  const initialMinRating = parseMinRating(searchParams.rating);

  // The unfiltered call above is capped at 200 rows by the RPC, and that cap
  // is applied AFTER its own category filter - so once there are 200+ pros in
  // the launch market, filtering this list in the browser would hide matching
  // pros ranked past the cap. At the cap we go back to asking the database for
  // the one category (exactly what this page did before C8) and the board
  // switches its chips back to links. Below the cap, nothing extra runs.
  const capped = allPros.length >= BROWSE_PROS_ROW_CAP;
  if (capped && initialCategory) {
    const { data: narrowed, error: narrowError } = (await (supabase.rpc as any)(
      "browse_pros",
      { p_category: initialCategory }
    )) as { data: BrowsePro[] | null; error: unknown };
    if (!narrowError) allPros = (narrowed ?? []) as BrowsePro[];
  }

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

      <BrowseProsBoard
        allPros={allPros}
        initialCategory={initialCategory}
        initialMinRating={initialMinRating}
        capped={capped}
      />
    </div>
  );
}
