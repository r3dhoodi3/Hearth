import Link from "next/link";
import { getActiveProperty } from "@/lib/property";
import { createClient } from "@/lib/supabase/server";
import { homeHealthScore, scoreBand } from "@/lib/health";
import { labelFor, SYSTEM_TYPES } from "@/lib/constants";
import type { HomeSystem, Issue } from "@/lib/database.types";
import SystemCaptureCard from "./SystemCaptureCard";

// "Walk your home": the Centriq-style capture flow. Lists every system,
// grouped by whether its details are still an onboarding ESTIMATE
// (confirmed_at is null - migration 0056) or owner-CONFIRMED. Each estimated
// system gets a "snap the data plate" card (SystemCaptureCard) so a walk
// through the house turns every guess into a real fact, one scan at a time.
export default async function WalkthroughPage(props: {
  searchParams: Promise<{ mode?: string }>;
}) {
  // ?mode=manual opens every card straight on its typing form, for the owner
  // who is not standing in front of the furnace with a phone. A query
  // parameter rather than client state so the choice survives a reload and
  // can be linked to from anywhere (the dashboard nudge does).
  const { mode } = await props.searchParams;
  const manual = mode === "manual";
  const property = (await getActiveProperty())!;
  const supabase = await createClient();

  const [{ data: systems }, { data: issues }] = await Promise.all([
    supabase
      .from("home_systems")
      .select("*")
      .eq("property_id", property.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("issues")
      .select("*")
      .eq("property_id", property.id)
      .eq("status", "open"),
  ]);

  const sys = (systems ?? []) as HomeSystem[];
  const openIssues = (issues ?? []) as Issue[];
  const estimated = sys.filter((s) => !s.confirmed_at);
  const confirmed = sys.filter((s) => s.confirmed_at);
  const score = homeHealthScore(sys, openIssues);
  const band = scoreBand(score);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Walk your home
        </h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Snap the data plate on each system as you walk through your home.
          Hearth reads the brand, model, and age off it, you confirm, and your
          Home Health Score gets sharper on the spot.
        </p>
      </div>

      {/* The choice, up front. The photo path is still the default and is
          unchanged; this only says out loud that typing is allowed, which
          used to be a small link you found after opening a camera. Both
          options are plain links so the answer lives in the URL. */}
      {estimated.length > 0 && (
        <div
          role="group"
          aria-label="How to add your details"
          className="flex flex-wrap gap-2"
        >
          <Link
            href="/walkthrough"
            aria-current={manual ? undefined : "page"}
            className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium ${
              manual
                ? "border-stone-200 bg-white text-stone-700 hover:border-bark-500 dark:border-white/10 dark:bg-stone-800 dark:text-stone-300"
                : "border-bark-600 bg-bark-600 text-white dark:border-bark-500 dark:bg-bark-500"
            }`}
          >
            Take photos
          </Link>
          <Link
            href="/walkthrough?mode=manual"
            aria-current={manual ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium ${
              manual
                ? "border-bark-600 bg-bark-600 text-white dark:border-bark-500 dark:bg-bark-500"
                : "border-stone-200 bg-white text-stone-700 hover:border-bark-500 dark:border-white/10 dark:bg-stone-800 dark:text-stone-300"
            }`}
          >
            Type it in instead
          </Link>
        </div>
      )}

      <div className={`card-hero inline-flex items-center gap-4 border ${band.tone}`}>
        <div>
          <p className="stat-label">Home Health Score</p>
          <p className="stat-number mt-1 text-3xl">{score}</p>
        </div>
        <p className="text-sm">{band.label}</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          To confirm{estimated.length > 0 ? ` (${estimated.length})` : ""}
        </h2>
        {estimated.length > 0 ? (
          <ul className="space-y-3">
            {estimated.map((s) => (
              <SystemCaptureCard
                key={s.id}
                system={s}
                propertyId={property.id}
                startManual={manual}
              />
            ))}
          </ul>
        ) : (
          <div className="rounded-xl border border-dashed border-stone-300 p-6 text-center dark:border-stone-700">
            <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
              Every system is confirmed. Nice work.
            </p>
          </div>
        )}
      </section>

      {confirmed.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Confirmed ({confirmed.length})
          </h2>
          <ul className="space-y-2">
            {confirmed.map((s) => (
              <li
                key={s.id}
                className="card flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span className="flex items-center gap-2 text-stone-800 dark:text-stone-200">
                  <span className="font-medium">
                    {labelFor(SYSTEM_TYPES, s.system_type)}
                  </span>
                  {s.material_or_model && (
                    <span className="text-stone-500 dark:text-stone-400">· {s.material_or_model}</span>
                  )}
                  {s.install_year && (
                    <span className="text-stone-500 dark:text-stone-400">
                      · installed {s.install_year}
                    </span>
                  )}
                </span>
                <span className="chip bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-200">
                  ✓ Confirmed
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
