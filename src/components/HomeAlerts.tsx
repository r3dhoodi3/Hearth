"use client";

import { useEffect, useState } from "react";
import { Snowflake, Thermometer, AlertTriangle, type LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/Skeleton";
import { fetchHomeAlerts, type HomeAlert as Alert } from "@/lib/homeAlertsClient";

const ICON: Record<Alert["kind"], LucideIcon> = {
  freeze: Snowflake,
  heat: Thermometer,
  recall: AlertTriangle,
};

const ICON_STYLE: Record<Alert["kind"], string> = {
  freeze: "text-amber-600 dark:text-amber-400",
  heat: "text-amber-600 dark:text-amber-400",
  recall: "text-red-600 dark:text-red-400",
};

// Proactive, time- and home-specific alerts (weather + safety recalls) fetched
// client-side so the dashboard render isn't blocked by external APIs. Renders
// NOTHING unless there's a real alert - kept deliberately compact so it never
// clutters the dashboard. propertyId comes from the dashboard server
// component: switching homes via HomeSwitcher soft-redirects here without
// remounting, so the fetch effect keys on it to load the new home's alerts.
//
// This used to also gate the skeleton on a `pageLoaded` flag (true once
// document.readyState / window's "load" fired), the same per-DOCUMENT (not
// per-navigation) signal WeatherStrip removed for the identical reason: once
// true for the session, every later soft navigation back to /dashboard mounts
// with it already true, collapsing the skeleton before fetchHomeAlerts had a
// realistic chance to resolve and falling straight through to "no alerts yet"
// (rendered as nothing). Keying the skeleton on `loading` alone - with
// HARD_DEADLINE_MS as the only ceiling - fixes that for both cases. See
// WeatherStrip.tsx for the same fix applied first.
const HARD_DEADLINE_MS = 8_000;

export default function HomeAlerts({ propertyId }: { propertyId: string }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    // fetchHomeAlerts owns the hard 6s cap and it dedupes with WeatherStrip's
    // call so the dashboard hits the route once per load. On any failure it
    // resolves null, which lands here as zero alerts. The deadline below is a
    // second, independent cap - see HARD_DEADLINE_MS.
    const deadline = setTimeout(() => {
      if (alive) setLoading(false);
    }, HARD_DEADLINE_MS);
    fetchHomeAlerts(propertyId).then((d) => {
      if (!alive) return;
      clearTimeout(deadline);
      setAlerts([...(d?.weather ?? []), ...(d?.recalls ?? [])]);
      setLoading(false);
    });
    return () => {
      alive = false;
      clearTimeout(deadline);
    };
  }, [propertyId]);

  // Brief skeleton only while the first fetch is in flight - most loads
  // resolve to zero alerts, so this must not linger or reserve space once we
  // know there's nothing to show.
  if (loading) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-stone-200 p-3 dark:border-white/10" aria-hidden="true">
        <Skeleton className="h-5 w-5 shrink-0 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
    );
  }

  if (alerts.length === 0) return null;

  // Keep the dashboard tight: show the three most pressing (weather comes first
  // from the API), tuck the rest behind a toggle.
  const shown = expanded ? alerts : alerts.slice(0, 3);

  return (
    <section className="space-y-2">
      <ul className="space-y-2">
        {shown.map((a, i) => {
          const Icon = ICON[a.kind];
          return (
          <li
            key={i}
            className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
              a.kind === "recall"
                ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40"
                : "border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/15"
            }`}
          >
            <Icon className={`h-5 w-5 shrink-0 ${ICON_STYLE[a.kind]}`} aria-hidden="true" />
            <div>
              <p className="font-medium text-stone-900 dark:text-stone-100">{a.title}</p>
              <p className="mt-0.5 text-stone-600 dark:text-stone-300">{a.detail}</p>
              {a.url && (
                <a
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  // Phone only: matches the "Show N more" toggle below it.
                  className="mt-0.5 inline-block font-medium text-bark-700 hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-stone-300"
                >
                  View the official notice →
                </a>
              )}
            </div>
          </li>
          );
        })}
      </ul>
      {alerts.length > 3 && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          // Phone only: 16px tall before.
          className="text-xs font-medium text-stone-500 hover:text-stone-700 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:text-sm dark:text-stone-400 dark:hover:text-stone-300"
        >
          Show {alerts.length - 3} more
        </button>
      )}
    </section>
  );
}
