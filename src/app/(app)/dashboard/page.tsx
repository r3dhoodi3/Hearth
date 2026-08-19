import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { getUser } from "@/lib/auth";
import { hasPlus } from "@/lib/subscription";
import { generateMaintenancePlanAction } from "./actions";
import SubmitButton from "@/components/SubmitButton";
import {
  scoreBreakdown,
  scoreBand,
  scoreIsMostlyEstimated,
  systemPriority,
  assessSystem,
  openIssueFor,
} from "@/lib/health";
import {
  REMODEL_PROJECTS,
  categoryForSystem,
  labelFor,
  SYSTEM_TYPES,
  ISSUE_CATEGORIES,
  SEASONAL_TASKS,
  seasonForMonth,
} from "@/lib/constants";
import { planTitles } from "@/lib/maintenancePlan";
import SystemForm from "../profile/SystemForm";
import SystemRow from "../profile/SystemRow";
import { addSystemFormAction } from "../profile/actions";
import SeasonalChecklist from "@/components/SeasonalChecklist";
import ChecklistProvider from "@/components/ChecklistProvider";
import ReminderItem from "./ReminderItem";
import WalkthroughNudge from "./WalkthroughNudge";
import HomeAlerts from "@/components/HomeAlerts";
import WeatherStrip from "@/components/WeatherStrip";
import CategoryIcon from "@/components/CategoryIcon";
import {
  Home,
  TrendingUp,
  Search,
  ClipboardList,
  FileText,
  CalendarDays,
} from "lucide-react";
import { estimateHomeValue, calculateEquity } from "@/lib/homeValue";
import {
  estimateSeasonalEnergyCost,
  estimateUpgradeSavings,
} from "@/lib/energy";
import type { Issue } from "@/lib/database.types";

// Shared "Plus" badge chip, used on every paywalled CTA/card on this page.
// className lets each call site set its own margin, everything else fixed.
function PlusChip({ className = "" }: { className?: string }) {
  return (
    <span
      className={`chip bg-bark-100 text-bark-700 dark:bg-bark-700 dark:text-stone-300 ${className}`}
    >
      Plus
    </span>
  );
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: { welcome?: string; plan?: string };
}) {
  // "View my plan" lands here with ?plan=open so the collapsed task groups
  // start expanded, making the click visibly do something.
  const planOpen = searchParams.plan === "open";
  // First visit after claiming a home (?welcome=1): the banner below already
  // walks through the started systems, so the below-the-fold detail sections
  // default collapsed instead of dumping everything open at once. Health
  // Score and "This month" stay expanded either way. Normal visits are
  // untouched.
  const isFirstVisit = !!searchParams.welcome;
  // getActiveProperty and hasPlus don't depend on each other - run them
  // together instead of stacking two round trips before the redirect check.
  const [property, plus] = await Promise.all([getActiveProperty(), hasPlus()]);
  if (!property) redirect("/onboarding");
  const supabase = createClient();

  const [
    { data: systems },
    { data: issues },
    { data: tasks },
    { data: pics },
    { data: jobs },
    { data: docs },
  ] = await Promise.all([
    // home_systems: kept as select(*) on purpose. SystemRow's edit form
    // reads filter_size/filter_interval_months (migration 0042 columns that
    // were never added to database.types.ts), and Supabase's typed client
    // rejects any explicit select string that names a column absent from the
    // generated Database type (compile error), so those two columns cannot
    // be spelled out without regenerating types. Every other home_systems
    // column here IS actually read downstream (SystemRow/SystemForm/
    // health.ts), so an explicit list would be zero-byte-savings anyway -
    // select(*) is both correct and no slower.
    supabase
      .from("home_systems")
      .select("*")
      .eq("property_id", property.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("issues")
      // Only what scoreBreakdown/openIssueFor/the briefing loop below read
      // (severity, category, description) plus the ids needed to match a
      // system - drops property_id/status/converted_to_lead/created_at, which
      // nothing on this page touches (status is already pinned to "open" by
      // the filter above).
      .select("id, system_id, category, severity, description")
      .eq("property_id", property.id)
      .eq("status", "open")
      .order("created_at", { ascending: false }),
    supabase
      .from("maintenance_tasks")
      // Only what the reminders list/grouping/ReminderItem read - drops
      // property_id, system_id, recurrence, reminded_upcoming_at,
      // reminded_overdue_at, none of which this page uses.
      .select("id, title, due_date, status, completed_at, created_at")
      .eq("property_id", property.id)
      .in("status", ["open", "done"])
      .order("due_date", { ascending: true }),
    supabase
      .from("photos")
      .select("related_id, url")
      .eq("property_id", property.id)
      .eq("related_type", "system"),
    supabase
      .from("contractor_leads")
      .select("id, contractor_id")
      .eq("property_id", property.id),
    supabase
      .from("documents")
      .select("id, title, warranty_expires, system_type")
      .eq("property_id", property.id)
      .not("warranty_expires", "is", null)
      .order("warranty_expires", { ascending: true }),
  ]);

  // Open jobs = postings the owner has put up that no pro has been picked for yet.
  const openJobsCount = (jobs ?? []).filter((j) => !j.contractor_id).length;

  // Whether a maintenance plan already exists, so the CTA can switch from
  // "Build my plan" to "View my plan". Only plan-generated tasks count - a
  // manual reminder (say, from chat) must not hide "Build my plan" forever.
  const planTitleSet = planTitles();
  const hasOpenPlan = (tasks ?? []).some(
    (t) => t.status === "open" && planTitleSet.has(t.title)
  );

  // Non-Plus homeowners get exactly one free plan build as a taste of Plus,
  // tracked the same way the free quote check is (users.free_plan_used_at,
  // migration 0099). freePlanCredit is true only while that credit is unused,
  // so the CTA can offer the real build once, then revert to the Plus pitch.
  let freePlanCredit = false;
  if (!plus) {
    // The cached, network-free getUser(): the row below is RLS-protected and
    // pinned to this id, so a live auth-server round trip buys nothing here.
    const user = await getUser();
    if (user) {
      const { data: creditRow, error: creditErr } = await supabase
        .from("users")
        .select("free_plan_used_at")
        .eq("id", user.id)
        .maybeSingle();
      // FAIL OPEN if the column isn't live yet (migration 0099 not run): a
      // homeowner must never be told the free build is used when it never was.
      freePlanCredit = creditErr
        ? true
        : !!creditRow && creditRow.free_plan_used_at === null;
    }
  }

  // Group system photos by system id so each row can show its own thumbnails.
  const photosBySystem = new Map<string, string[]>();
  for (const p of pics ?? []) {
    const list = photosBySystem.get(p.related_id) ?? [];
    list.push(p.url);
    photosBySystem.set(p.related_id, list);
  }

  const sys = systems ?? [];
  const openIssues = issues ?? [];
  // Systems whose details are still an onboarding estimate (migration 0056:
  // confirmed_at null), powering the "walk your home" entry points below.
  const unconfirmedCount = sys.filter((s) => !s.confirmed_at).length;
  // scoreBreakdown's declared param is the full Issue[] shape (health.ts, out
  // of lane), but it only ever reads .severity/.category - both present in
  // the trimmed select above. Safe cast, no behavior change.
  const { score, lines: scoreLines } = scoreBreakdown(
    sys,
    openIssues as unknown as Issue[]
  );
  const band = scoreBand(score);
  // More than half the systems are still onboarding estimates: label the
  // score "Estimated" and soften the band line, so a guess never reads as a
  // verdict.
  const mostlyEstimated = scoreIsMostlyEstimated(sys);

  // Biggest lever: the unconfirmed system costing the most points right now.
  // Same math as scoreBreakdown's per-system deductions, tied back to the
  // system so the fix ("confirm it in a walkthrough") is one tap away. Only
  // unconfirmed systems qualify, since the copy promises confirming helps.
  const biggestLever = sys
    .filter((s) => !s.confirmed_at)
    .map((s) => {
      const h = assessSystem(s);
      let pts = 0;
      // Pure age estimates (no owner condition) deduct at half weight in
      // scoreBreakdown, so the promised win here must match.
      const est = s.condition_rating == null;
      if (h.stage === "due") pts += est ? 5 : 10;
      else if (h.stage === "aging") pts += est ? 2 : 4;
      if (s.condition_rating && s.condition_rating <= 2) pts += 5;
      return { system: s, pts };
    })
    .filter((d) => d.pts > 0)
    .sort((a, b) => b.pts - a.pts)[0] ?? null;

  // Link reported issues to systems - by system_id when the issue was filed
  // against a specific system, falling back to category (a reported roof
  // issue shows on the roof system and pushes it to the top). Shared with
  // Cost Forecast via health.ts so both pick the same issue for a system.
  const issueForSystem = (s: any) => openIssueFor(s, openIssues);

  // Order: must-do (failing or reported issue) pinned to the very top, then by
  // maintenance status - needs maintenance (due), then plan ahead (aging), then
  // healthy, then unknown. systemPriority breaks ties within a stage.
  const isMust = (s: any) =>
    s.condition_rating === 1 || issueForSystem(s)?.severity === "urgent";
  const STAGE_RANK: Record<string, number> = {
    due: 3,
    aging: 2,
    healthy: 1,
    unknown: 0,
  };
  const sortedSys = [...sys].sort((a, b) => {
    const mustDiff = (isMust(b) ? 1 : 0) - (isMust(a) ? 1 : 0);
    if (mustDiff !== 0) return mustDiff;
    const stageDiff =
      (STAGE_RANK[assessSystem(b).stage] ?? 0) -
      (STAGE_RANK[assessSystem(a).stage] ?? 0);
    if (stageDiff !== 0) return stageDiff;
    return systemPriority(b) - systemPriority(a);
  });

  const mustCount = sortedSys.filter(isMust).length;

  // Seasonal task content, but the checklist resets per month (year-month key).
  const now = new Date();
  const season = seasonForMonth(now.getMonth());
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // Proactive briefing: the top few things Hearth would flag right now, ranked
  // the same way the systems list is - open issues first (urgent on top), then
  // systems past/near their life, then aging ones, with a seasonal nudge to
  // round it out. Each item carries a prefilled action so it's one tap to act.
  type Brief = { text: string; href: string | null; cta: string; urgent?: boolean };
  const briefing: Brief[] = [];
  const seenCat = new Set<string>();

  const issuesByUrgency = [...openIssues].sort(
    (a, b) =>
      (b.severity === "urgent" ? 1 : 0) - (a.severity === "urgent" ? 1 : 0)
  );
  for (const i of issuesByUrgency) {
    if (briefing.length >= 3) break;
    // One line per category so two open issues of the same kind cannot produce
    // two near-identical briefing items.
    if (seenCat.has(i.category)) continue;
    const name = labelFor(ISSUE_CATEGORIES, i.category);
    const desc =
      `Need help with a ${name} issue.` +
      (i.description ? ` ${i.description}` : "");
    briefing.push({
      text: `Your ${name.toLowerCase()} issue needs attention.`,
      href:
        `/contractors?category=${i.category}` +
        `&desc=${encodeURIComponent(desc)}` +
        (i.severity === "urgent" ? "&timing=asap" : ""),
      cta: "Find a pro",
      urgent: i.severity === "urgent",
    });
    seenCat.add(i.category);
  }

  for (const s of sortedSys) {
    if (briefing.length >= 3) break;
    const cat = categoryForSystem(s.system_type);
    if (seenCat.has(cat)) continue;
    const h = assessSystem(s);
    const must = isMust(s) || h.stage === "due";
    if (!must && h.stage !== "aging") continue;
    const name = labelFor(SYSTEM_TYPES, s.system_type);
    const desc =
      `Need help with my ${name}.` +
      (s.install_year ? ` Installed ${s.install_year}.` : "") +
      (s.material_or_model ? ` Material/model: ${s.material_or_model}.` : "") +
      (s.condition_rating
        ? ` I rated its condition ${s.condition_rating} of 5.`
        : "");
    const urgent = s.condition_rating != null && s.condition_rating <= 2;
    // Verb agreement for plural labels ("windows are", not "windows is"), and
    // show our work: when the call comes from age alone, say so.
    const plural = name.toLowerCase().endsWith("s");
    const verb = plural ? "are" : "is";
    const its = plural ? "their" : "its";
    const them = plural ? "them" : "it";
    const ageOnly = !isMust(s);
    const basedOnAge = ageOnly ? `, based on ${its} age` : "";
    // "Plan it" starts a job posting (prefilled with this system's details);
    // "Learn more" is a lower-stakes ask (aging, not yet due) so it points at
    // the maintenance guides instead of the contractor flow.
    const contractorHref =
      `/contractors?category=${cat}` +
      `&desc=${encodeURIComponent(desc)}` +
      (urgent ? "&timing=asap" : "");
    briefing.push({
      text: must
        ? `Your ${name.toLowerCase()} ${verb} near the end of ${its} life${basedOnAge}. It is worth planning ahead.`
        : `Your ${name.toLowerCase()} ${verb} aging${basedOnAge}. Keep an eye on ${them}.`,
      href: must ? contractorHref : "/learn",
      cta: must ? "Plan it" : "Learn more",
    });
    seenCat.add(cat);
  }

  // If nothing urgent surfaced, point them at the seasonal checklist below
  // rather than repeating one of its tasks verbatim in the briefing.
  if (briefing.length === 0) {
    briefing.push({
      text: "Nothing urgent right now. Knock out this month's seasonal tasks below.",
      href: null,
      cta: "",
    });
  }

  // Reminders: open ones always; a done (crossed-out) one lingers for 30 days
  // after it was COMPLETED, then drops off. Measure from completed_at (falling
  // back to created_at for older rows) so a task you just finished doesn't
  // vanish because it was created long ago.
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const reminders = (tasks ?? []).filter(
    (t) =>
      t.status === "open" ||
      (t.status === "done" &&
        nowMs - new Date(t.completed_at ?? t.created_at).getTime() <
          THIRTY_DAYS)
  );

  // Purely presentational grouping so "This month" reads like an organized
  // plan (Overdue / Due soon / Later / Done) instead of a flat list. Doesn't
  // touch how tasks are generated, ordered in the query, or toggled.
  type ReminderRow = (typeof reminders)[number];
  type Urgency = "overdue" | "soon" | "later" | "done";
  const URGENCY_LABEL: Record<Urgency, string> = {
    overdue: "Overdue",
    soon: "Due soon",
    later: "Later",
    done: "Done",
  };
  const URGENCY_TONE: Record<Urgency, string> = {
    overdue: "text-red-600 dark:text-red-400",
    soon: "text-amber-600 dark:text-amber-400",
    // stone-600, not stone-400: stone-400 on the card's white background is
    // only ~2.5:1 contrast, below the 4.5:1 minimum for this small text. These
    // labels are also tappable disclosure headers, so the darker weight helps
    // them read as buttons rather than dim captions.
    later: "text-stone-600 dark:text-stone-400",
    done: "text-stone-600 dark:text-stone-400",
  };
  function daysUntil(dateStr: string): number {
    const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return NaN;
    const due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((due.getTime() - today.getTime()) / 86_400_000);
  }
  function urgencyFor(t: ReminderRow): Urgency {
    if (t.status === "done") return "done";
    if (!t.due_date) return "later";
    const days = daysUntil(t.due_date);
    if (Number.isNaN(days)) return "later";
    if (days < 0) return "overdue";
    if (days <= 14) return "soon";
    return "later";
  }
  const groupedReminders: Record<Urgency, ReminderRow[]> = {
    overdue: [],
    soon: [],
    later: [],
    done: [],
  };
  for (const t of reminders) groupedReminders[urgencyFor(t)].push(t);
  const URGENCY_ORDER: Urgency[] = ["overdue", "soon", "later", "done"];

  const remindersTotal = reminders.length;
  const remindersDone = groupedReminders.done.length;
  const seasonLabel = season.charAt(0).toUpperCase() + season.slice(1);

  // Upcoming warranties from the documents vault, soonest first, so the owner
  // hears about coverage before it lapses. Local date, not toISOString's UTC
  // one - in US evenings UTC has already rolled to tomorrow, which would drop
  // a warranty expiring today before local midnight actually arrives.
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const warranties = (docs ?? [])
    .filter((d) => d.warranty_expires && d.warranty_expires >= todayStr)
    .map((d) => {
      const w = d.warranty_expires as string;
      const days = Math.max(
        0,
        Math.ceil(
          (new Date(w + "T00:00:00").getTime() - Date.now()) / 86_400_000
        )
      );
      return { id: d.id, title: d.title, system_type: d.system_type, days };
    });
  const warrantyLeft = (days: number) =>
    days <= 60
      ? `${days} day${days === 1 ? "" : "s"} left`
      : `about ${Math.round(days / 30)} months left`;

  // Home value & equity tile. purchase_price/mortgage_balance are new columns
  // (migration 0029) not yet in database.types.ts, so read off the row with a
  // cast rather than widening the generated types by hand; if the migration
  // hasn't run yet these just come back undefined and the tile shows the CTA.
  const rawProperty = property as any;
  const homeValuePurchasePrice: number | null =
    typeof rawProperty.purchase_price === "number" ? rawProperty.purchase_price : null;
  const homeValueMortgageBalance: number | null =
    typeof rawProperty.mortgage_balance === "number" ? rawProperty.mortgage_balance : null;
  const homeValuePurchaseYear: number | null = property.purchase_date
    ? Number(property.purchase_date.slice(0, 4)) || null
    : null;
  const hasHomeValueData =
    homeValuePurchasePrice != null && homeValuePurchaseYear != null;
  const homeEstimatedValue = hasHomeValueData
    ? estimateHomeValue(
        homeValuePurchasePrice!,
        homeValuePurchaseYear!,
        property.state,
        now.getFullYear()
      )
    : null;
  const homeEquity =
    homeEstimatedValue != null
      ? calculateEquity(homeEstimatedValue, homeValueMortgageBalance)
      : null;
  // Year-over-year movement: same estimate run for last year, so the tile can
  // say how much the ballpark moved. Purely derived, no schema changes.
  const homeValueLastYear = hasHomeValueData
    ? estimateHomeValue(
        homeValuePurchasePrice!,
        homeValuePurchaseYear!,
        property.state,
        now.getFullYear() - 1
      )
    : null;
  const homeValueDelta =
    homeEstimatedValue != null && homeValueLastYear != null
      ? homeEstimatedValue - homeValueLastYear
      : null;

  // Energy-this-season tile. Reuses data already on the page (property +
  // home_systems), no extra queries. Fall points at the coming winter and
  // spring at the coming summer, so the number is always about the bill the
  // owner is heading into, not one that already passed.
  const energySeason: "winter" | "summer" =
    season === "winter" || season === "fall" ? "winter" : "summer";
  const hvacSystem = sys.find((s) => s.system_type === "hvac") ?? null;
  // Numbers only make sense with a state (weather + prices) and at least one
  // real fact about the home; otherwise the tile nudges setup instead.
  const hasEnergyInputs =
    property.state != null &&
    (property.sqft != null || property.year_built != null || hvacSystem != null);
  const energyEstimate = hasEnergyInputs
    ? estimateSeasonalEnergyCost({
        sqft: property.sqft,
        yearBuilt: property.year_built,
        state: property.state,
        hvacInstallYear: hvacSystem?.install_year ?? null,
        hvacType: hvacSystem?.material_or_model ?? null,
        season: energySeason,
        currentYear: now.getFullYear(),
      })
    : null;
  // Non-null only for a 15+ year old HVAC (the lib enforces the threshold).
  const upgradeSavings =
    hasEnergyInputs && hvacSystem
      ? estimateUpgradeSavings({
          sqft: property.sqft,
          yearBuilt: property.year_built,
          state: property.state,
          hvacInstallYear: hvacSystem.install_year,
          hvacType: hvacSystem.material_or_model,
          currentYear: now.getFullYear(),
        })
      : null;

  // Shared body of the "Thinking about a project?" block - identical whether
  // it's rendered as a plain section (normal visits) or inside a collapsed
  // <details> (first visit), so the two render paths below can't drift.
  const projectChips = (
    <>
      <p className="text-sm text-stone-500 dark:text-stone-400">
        Popular upgrades. Tap one to get matched with a local pro.
      </p>
      <div className="flex flex-wrap gap-2">
        {REMODEL_PROJECTS.map((p) => (
          <Link
            key={p.label}
            href={`/contractors?category=${p.category}`}
            className="focus-ring rounded-full border border-stone-200 bg-white px-3 py-1.5 text-sm text-stone-700 shadow-sm hover:border-bark-500 hover:text-bark-700 dark:border-white/10 dark:bg-stone-800 dark:text-stone-300 dark:hover:border-bark-600 dark:hover:text-stone-300"
          >
            <p.icon className="mr-1 inline-block h-3.5 w-3.5 align-[-2px]" aria-hidden="true" />
            {p.label}
          </Link>
        ))}
        <Link
          href="/contractors?category=other"
          className="focus-ring rounded-full border border-stone-200 bg-white px-3 py-1.5 text-sm text-stone-700 shadow-sm hover:border-bark-500 hover:text-bark-700 dark:border-white/10 dark:bg-stone-800 dark:text-stone-300 dark:hover:border-bark-600 dark:hover:text-stone-300"
        >
          Other
        </Link>
      </div>
    </>
  );

  return (
    <div className="space-y-8">
      {/* Current conditions for the home's city, one quiet row. Renders only
          when the lookup succeeds; shares its fetch with HomeAlerts below. */}
      <WeatherStrip propertyId={property.id} />

      {searchParams.welcome && (
        <div className="rounded-xl border border-bark-100 bg-bark-50 p-4 dark:border-bark-700/40 dark:bg-bark-700/30">
          {sys.length > 0 ? (
            <>
              <p className="font-medium text-stone-900 dark:text-stone-100">
                Your home is claimed.
              </p>
              <p className="mt-1 text-sm text-bark-700 dark:text-stone-300">
                We started {sys.length} system
                {sys.length === 1 ? "" : "s"} with estimated details based on
                your home&apos;s age:
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {sys.map((s) => (
                  <li
                    key={s.id}
                    className="chip border border-bark-100 bg-white text-stone-700 dark:border-bark-700 dark:bg-stone-800 dark:text-stone-300"
                  >
                    <CategoryIcon
                      list={SYSTEM_TYPES}
                      value={s.system_type}
                      className="mr-1 inline-block h-3.5 w-3.5 align-[-2px]"
                    />
                    {labelFor(SYSTEM_TYPES, s.system_type)}
                  </li>
                ))}
              </ul>
              <Link
                href="/walkthrough"
                className="btn-primary mt-3 inline-block"
              >
                Walk your home to confirm them
              </Link>
            </>
          ) : (
            <p className="text-sm text-bark-700 dark:text-stone-300">
              Your home is claimed. Add your systems below. It&apos;s what
              powers your maintenance reminders and your Home Health Score.
            </p>
          )}
        </div>
      )}

      {/* Property header */}
      <section>
        <h1 className="break-words text-2xl font-semibold text-stone-900 dark:text-stone-100">
          {property.address_line1}
          {property.city ? `, ${property.city}` : ""}
        </h1>
        {/* Quiet trust signal: only when the ownership check actually matched
            (migration 0093). Same green chip-ok tone and same wording spirit as
            the pro-side "Ownership verified" badge, so the semantics read the
            same on both ends. No chip at all when unverified - nothing to nag
            about, since a mismatch is expected and harmless. */}
        {property.ownership_status === "verified" && (
          <details className="mt-2 inline-block">
            <summary className="chip-ok focus-ring w-fit cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              Matches county records
            </summary>
            <p className="mt-1.5 max-w-sm text-xs text-stone-500 dark:text-stone-400">
              The name on your account matches the county assessor&apos;s
              public owner-of-record for this address. It&apos;s a soft trust
              signal we show pros, not proof of ownership.
            </p>
          </details>
        )}
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Built {property.year_built ?? "-"} · {property.sqft ?? "-"} sqft ·{" "}
          {property.beds ?? "-"} bd / {property.baths ?? "-"} ba
        </p>
        {/* Always-there escape hatch for urgent problems, kept quiet so it
            doesn't compete with the rest of the page. */}
        <Link
          href="/emergency"
          className="mt-1 inline-block text-sm text-red-600 hover:underline dark:text-red-400"
        >
          Something broken right now?
        </Link>
      </section>

      {/* Proactive weather + safety-recall alerts; self-hides when there's none */}
      <HomeAlerts propertyId={property.id} />

      {/* Key stats, kept above the fold so the Health Score is the first
          thing the owner sees. */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className={`card-hero border ${band.tone}`}>
          <p className="stat-label text-sm">Home Health Score</p>
          {mostlyEstimated && (
            <p className="mt-1 text-xs font-medium uppercase tracking-wide opacity-80">
              Estimated score
            </p>
          )}
          <p className="stat-number mt-1 text-4xl">{score}</p>
          <p className="text-sm">
            {mostlyEstimated
              ? "Based on your home's age. Confirm your systems to sharpen it."
              : band.label}
          </p>
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer opacity-80 hover:opacity-100">
              Why this score?
            </summary>
            <ul className="mt-2 space-y-1">
              <li className="flex justify-between">
                <span>Starting score</span>
                <span className="font-medium">100</span>
              </li>
              {scoreLines.map((l, i) => (
                <li key={i} className="flex justify-between gap-2">
                  <span className="truncate capitalize">{l.label}</span>
                  <span className="font-medium">{l.points}</span>
                </li>
              ))}
              {scoreLines.length === 0 && (
                <li className="opacity-80">No deductions. Everything looks healthy.</li>
              )}
            </ul>
            {unconfirmedCount > 0 && (
              <Link
                href="/walkthrough"
                className="mt-2 block font-medium underline"
              >
                Confirm your systems to make this score real
              </Link>
            )}
          </details>
          {biggestLever && (
            <p className="mt-2 text-xs">
              Biggest win:{" "}
              <Link href="/walkthrough" className="font-medium underline">
                confirm your{" "}
                {labelFor(SYSTEM_TYPES, biggestLever.system.system_type).toLowerCase()}{" "}
                (+{biggestLever.pts} pts)
              </Link>
            </p>
          )}
        </div>
        <div className="card">
          <p className="stat-label text-sm">Open jobs</p>
          {openJobsCount > 0 ? (
            <>
              <p className="stat-number mt-1 text-2xl">
                {openJobsCount}
              </p>
              <Link
                href="/contractors"
                className="text-sm text-bark-700 hover:underline dark:text-stone-300"
              >
                View job postings →
              </Link>
            </>
          ) : (
            <>
              <p className="mt-1 text-lg font-semibold text-stone-900 dark:text-stone-100">
                Post your first job
              </p>
              <p className="text-sm text-stone-500 dark:text-stone-400">
                Describe what needs doing and get matched with a local pro.
              </p>
              <Link
                href="/contractors"
                className="text-sm text-bark-700 hover:underline dark:text-stone-300"
              >
                Find a pro →
              </Link>
            </>
          )}
        </div>
        <Link
          href="/value"
          className="card-link"
        >
          <p className="stat-label text-sm">Home value</p>
          {hasHomeValueData && homeEstimatedValue != null ? (
            <>
              <p className="stat-number mt-1 text-2xl">
                ${Math.round(homeEstimatedValue).toLocaleString()}
              </p>
              <p className="text-sm text-stone-500 dark:text-stone-400">
                {homeEquity != null && homeEquity < 0
                  ? `-$${Math.round(Math.abs(homeEquity)).toLocaleString()} equity (underwater)`
                  : `$${Math.round(homeEquity ?? 0).toLocaleString()} equity`}
              </p>
              {homeValueDelta != null && homeValueDelta !== 0 && (
                <p
                  className={`text-sm ${
                    homeValueDelta > 0 ? "text-green-700 dark:text-green-400" : "text-stone-500 dark:text-stone-400"
                  }`}
                >
                  {homeValueDelta > 0
                    ? `Up $${Math.round(homeValueDelta).toLocaleString()} this year`
                    : `Down $${Math.round(Math.abs(homeValueDelta)).toLocaleString()} this year`}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="mt-1 text-lg font-semibold text-stone-900 dark:text-stone-100">
                Track your home&apos;s value
              </p>
              <p className="text-sm text-stone-500 dark:text-stone-400">
                See what your home is likely worth today and how much equity
                you have.
              </p>
            </>
          )}
        </Link>
        <div className="card">
          <p className="stat-label text-sm">
            Energy this season
          </p>
          {energyEstimate ? (
            <>
              <p className="stat-number mt-1 text-2xl">
                ~${energyEstimate.low.toLocaleString()}-
                {energyEstimate.high.toLocaleString()}
              </p>
              <p className="text-sm text-stone-500 dark:text-stone-400">
                {energySeason === "winter"
                  ? "to keep warm this winter"
                  : "to stay cool this summer"}
              </p>
              {upgradeSavings &&
                (plus ? (
                  <Link
                    href="/forecast"
                    className="mt-1 block text-xs text-bark-700 hover:underline dark:text-stone-300"
                  >
                    Your HVAC is {upgradeSavings.hvacAge} years old. A new unit
                    could save ~${upgradeSavings.low.toLocaleString()}-
                    {upgradeSavings.high.toLocaleString()}/yr →
                  </Link>
                ) : (
                  <Link
                    href="/plus?reason=forecast"
                    className="mt-1 block text-xs text-bark-700 hover:underline dark:text-stone-300"
                  >
                    See what a new unit would save
                    <PlusChip className="mx-1.5" />
                    →
                  </Link>
                ))}
            </>
          ) : (
            <>
              <p className="mt-1 text-lg font-semibold text-stone-900 dark:text-stone-100">
                Estimate your energy bills
              </p>
              <p className="text-sm text-stone-500 dark:text-stone-400">
                Add your home&apos;s state and square footage to see what
                heating and cooling likely cost.
              </p>
              <Link
                href="/profile"
                className="text-sm text-bark-700 hover:underline dark:text-stone-300"
              >
                Finish your home profile →
              </Link>
            </>
          )}
        </div>
      </section>

      {/* This month: focus + one merged checklist (reminders + seasonal) */}
      <section id="this-month" className="scroll-mt-20 space-y-3">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">This month</h2>
        <WalkthroughNudge count={unconfirmedCount} />
        <div className="card space-y-3">
          <div className="rounded-lg bg-bark-50 p-3 dark:bg-bark-700/30">
            <p className="text-xs font-semibold uppercase tracking-wide text-bark-700 dark:text-stone-300">
              Hearth&apos;s briefing
            </p>
            <ul className="mt-1.5 space-y-1.5">
              {briefing.map((b, i) => (
                <li key={i} className="text-sm text-stone-900 dark:text-stone-100">
                  <span className="text-bark-700 dark:text-stone-300">•</span>{" "}
                  {b.urgent && (
                    <span className="chip-danger mr-1 py-0 align-middle">Urgent</span>
                  )}
                  {b.text}
                  {b.href && (
                    <Link
                      href={b.href}
                      className="ml-1 font-medium text-bark-700 hover:underline dark:text-stone-300"
                    >
                      {b.cta} →
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div className="border-t border-stone-100 pt-3 dark:border-white/10">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-stone-700 dark:text-stone-300">
                {remindersTotal > 0
                  ? `${remindersTotal} task${remindersTotal === 1 ? "" : "s"} on your plan`
                  : "No maintenance tasks yet"}
              </p>
              {remindersTotal > 0 && (
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  {remindersDone} of {remindersTotal} done
                </p>
              )}
            </div>
            {remindersTotal > 0 && (
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-stone-100 dark:bg-stone-700">
                <div
                  className="h-full rounded-full bg-green-500 transition-all duration-500 ease-out"
                  style={{
                    width: `${Math.round((remindersDone / remindersTotal) * 100)}%`,
                  }}
                />
              </div>
            )}

            {/* Everything checked off: celebrate, then tee up the next round
                (rebuilding schedules fresh future dates for the same tasks). */}
            {remindersTotal > 0 && remindersDone === remindersTotal && (
              <div className="chip-ok mt-3 flex flex-col items-start gap-2 rounded-lg p-3 motion-safe:animate-fade-slide-up sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm">
                  All caught up. Your home thanks you.
                </p>
                {plus ? (
                  <form action={generateMaintenancePlanAction}>
                    <SubmitButton
                      className="text-sm font-medium hover:underline disabled:opacity-60"
                      pendingLabel="Planning…"
                    >
                      Plan my next round →
                    </SubmitButton>
                  </form>
                ) : (
                  <Link
                    href="/plus?reason=plan"
                    className="text-sm font-medium hover:underline"
                  >
                    Plan my next round
                    <PlusChip className="mx-1.5" />
                    →
                  </Link>
                )}
              </div>
            )}

            <ChecklistProvider>
              <div className="mt-3 space-y-4">
                {/* Near-term work stays in view; everything further out folds
                    into collapsed groups so the card shows a handful of tasks,
                    not a wall. */}
                {(["overdue", "soon"] as Urgency[])
                  .filter((u) => groupedReminders[u].length > 0)
                  .map((u) => (
                    <div key={u}>
                      <p
                        className={`px-2 text-xs font-semibold uppercase tracking-wide ${URGENCY_TONE[u]}`}
                      >
                        {URGENCY_LABEL[u]} ({groupedReminders[u].length})
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {groupedReminders[u].map((t) => (
                          <ReminderItem
                            key={t.id}
                            id={t.id}
                            title={t.title}
                            due={t.due_date}
                            daysLeft={t.due_date ? daysUntil(t.due_date) : null}
                            initialDone={t.status === "done"}
                          />
                        ))}
                      </ul>
                    </div>
                  ))}

                {(["later", "done"] as Urgency[])
                  .filter((u) => groupedReminders[u].length > 0)
                  .map((u) => (
                    <details key={u} open={planOpen} className="group">
                      <summary
                        className={`focus-ring cursor-pointer list-none [&::-webkit-details-marker]:hidden px-2 text-sm font-semibold uppercase tracking-wide ${URGENCY_TONE[u]}`}
                      >
                        <span className="mr-1 inline-block transition-transform group-open:rotate-90">
                          ▸
                        </span>
                        {URGENCY_LABEL[u]} ({groupedReminders[u].length})
                      </summary>
                      <ul className="mt-1 space-y-0.5">
                        {groupedReminders[u].map((t) => (
                          <ReminderItem
                            key={t.id}
                            id={t.id}
                            title={t.title}
                            due={t.due_date}
                            daysLeft={t.due_date ? daysUntil(t.due_date) : null}
                            initialDone={t.status === "done"}
                          />
                        ))}
                      </ul>
                    </details>
                  ))}

                <details open={planOpen || remindersTotal === 0} className="group">
                  <summary className="focus-ring cursor-pointer list-none [&::-webkit-details-marker]:hidden px-2 text-sm font-semibold uppercase tracking-wide text-stone-600 dark:text-stone-400">
                    <span className="mr-1 inline-block transition-transform group-open:rotate-90">
                      ▸
                    </span>
                    Seasonal, {seasonLabel} ({SEASONAL_TASKS[season].length})
                  </summary>
                  <ul className="mt-1 space-y-0.5">
                    <SeasonalChecklist
                      period={monthKey}
                      tasks={SEASONAL_TASKS[season]}
                    />
                  </ul>
                </details>
              </div>
            </ChecklistProvider>

            {/* Warranties from the documents vault, folded in as a compact
                sub-block under this month's tasks instead of a standalone
                section further down the page. */}
            {warranties.length > 0 && (
              <div className="mt-4 border-t border-stone-100 pt-3 dark:border-white/10">
                <p className="text-sm font-medium text-stone-700 dark:text-stone-300">
                  Warranties ({warranties.length})
                </p>
                <ul className="mt-1.5 divide-y divide-stone-100 dark:divide-white/10">
                  {warranties.map((w) => (
                    <li
                      key={w.id}
                      className="flex items-center justify-between gap-3 py-1.5 first:pt-0"
                    >
                      <span className="flex min-w-0 items-center gap-2 text-sm text-stone-800 dark:text-stone-200">
                        <span>
                          {w.system_type ? (
                            <CategoryIcon list={SYSTEM_TYPES} value={w.system_type} className="h-4 w-4" />
                          ) : (
                            <FileText className="h-4 w-4" aria-hidden="true" />
                          )}
                        </span>
                        <span className="truncate">{w.title ?? "Home document"}</span>
                      </span>
                      <span
                        className={`chip shrink-0 text-sm ${
                          w.days <= 60 ? "chip-warn" : "chip-muted"
                        }`}
                      >
                        {warrantyLeft(w.days)}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-xs text-stone-500 dark:text-stone-400">
                  Pulled from your{" "}
                  <Link href="/documents" className="text-bark-700 hover:underline dark:text-stone-300">
                    documents
                  </Link>
                  .
                </p>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Hearth Plus: one cohesive "plan ahead" block (plan + premium tools) */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          {plus ? "Your Hearth Plus tools" : "Plan ahead with Hearth Plus"}
        </h2>
        <div className="card flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="icon-chip text-xl">
              <CalendarDays className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h3 className="font-medium text-stone-900 dark:text-stone-100">
                Build my maintenance plan
              </h3>
              <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
                Upkeep reminders timed to your home&apos;s systems, a few at a
                time so it never feels like a chore.
              </p>
            </div>
          </div>
          {plus ? (
            hasOpenPlan ? (
              <Link
                href="/dashboard?plan=open#this-month"
                className="btn-primary whitespace-nowrap text-center"
              >
                View my plan
              </Link>
            ) : (
              <form action={generateMaintenancePlanAction}>
                <SubmitButton
                  className="btn-primary whitespace-nowrap"
                  pendingLabel="Building…"
                >
                  Build my plan
                </SubmitButton>
              </form>
            )
          ) : freePlanCredit ? (
            // First build is a real, free taste of Plus (deterministic, no AI
            // cost). The note keeps the promise honest: rebuilding to keep the
            // plan fresh is the Plus part.
            <div className="flex flex-col gap-1.5 sm:max-w-xs sm:items-end sm:text-right">
              <form action={generateMaintenancePlanAction}>
                <SubmitButton
                  className="btn-primary w-full whitespace-nowrap sm:w-auto"
                  pendingLabel="Building…"
                >
                  Build my plan
                </SubmitButton>
              </form>
              <p className="text-xs text-stone-500 dark:text-stone-400">
                Your first plan build is free. Keeping it fresh as your home
                changes is a Plus thing.
              </p>
            </div>
          ) : (
            // Free build already used: a paywall door, not a free action.
            // Labeled with the Plus chip and styled secondary so the filled-
            // primary look stays reserved for buttons that act right away.
            <Link
              href="/plus?reason=plan"
              className="btn-secondary whitespace-nowrap text-center"
            >
              Get my maintenance plan
              <PlusChip className="ml-1.5" />
            </Link>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          {[
            {
              href: plus ? "/forecast" : "/plus?reason=forecast",
              icon: TrendingUp,
              title: "Cost forecast",
              desc: "See what will need replacing and the amount to set aside each month.",
            },
            {
              href: plus ? "/quote-check" : "/plus?reason=quote",
              icon: Search,
              title: "Quote analyzer",
              desc: "Snap a contractor's quote and check whether the price is fair.",
            },
            {
              href: plus ? "/home-report" : "/plus?reason=report",
              icon: ClipboardList,
              title: "Home report",
              desc: "A shareable record of your home for insurance and resale.",
            },
          ].map((t) => (
            <Link
              key={t.title}
              href={t.href}
              className="card-link"
            >
              <p className="icon-chip">
                <t.icon className="h-5 w-5" aria-hidden="true" />
              </p>
              <p className="mt-1 font-medium text-stone-900 dark:text-stone-100">
                {t.title}
                {!plus && <PlusChip className="ml-1.5" />}
                {!plus && t.title === "Quote analyzer" && (
                  <span className="chip ml-1.5 bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300">
                    1 free
                  </span>
                )}
              </p>
              <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{t.desc}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* Systems inventory (the old Home Profile) */}
      <details id="systems" open={!isFirstVisit} className="group space-y-4">
        <summary className="focus-ring w-fit cursor-pointer list-none [&::-webkit-details-marker]:hidden text-lg font-semibold text-stone-900 dark:text-stone-100">
          <span className="mr-1 inline-block transition-transform group-open:rotate-90">
            ▸
          </span>
          Your systems{sortedSys.length > 0 ? ` (${sortedSys.length})` : ""}
          {mustCount > 0 ? (
            <span className="chip chip-danger ml-2">
              {mustCount} must do
            </span>
          ) : null}
        </summary>

        {sortedSys.length > 0 ? (
          <ul className="space-y-3">
            {sortedSys.map((s) => (
              <SystemRow
                key={s.id}
                system={s}
                openIssue={issueForSystem(s)}
                photos={photosBySystem.get(s.id) ?? []}
              />
            ))}
          </ul>
        ) : (
          <div className="rounded-xl border border-dashed border-stone-300 p-6 text-center dark:border-stone-700">
            <div className="flex justify-center">
              <span className="icon-chip">
                <Home className="h-5 w-5" aria-hidden="true" />
              </span>
            </div>
            <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
              No systems yet. Add your roof, HVAC, and water heater first. Those
              drive the most useful reminders.
            </p>
            {/* One-tap starts: each chip files the system with just its type;
                details (year, condition, photos) can come later in a
                walkthrough or an edit. */}
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {[
                { type: "roof", label: "+ Roof" },
                { type: "hvac", label: "+ HVAC" },
                { type: "water_heater", label: "+ Water heater" },
              ].map((q) => (
                <form key={q.type} action={addSystemFormAction}>
                  <input type="hidden" name="system_type" value={q.type} />
                  <SubmitButton
                    className="focus-ring rounded-full border border-stone-200 bg-white px-3 py-1.5 text-sm text-stone-700 shadow-sm hover:border-bark-500 hover:text-bark-700 disabled:opacity-60 dark:border-white/10 dark:bg-stone-800 dark:text-stone-300 dark:hover:border-bark-600 dark:hover:text-stone-300"
                    pendingLabel="Adding…"
                  >
                    {q.label}
                  </SubmitButton>
                </form>
              ))}
            </div>
          </div>
        )}

        <SystemForm propertyId={property.id} />
      </details>

      {/* Project ideas. Always-open plain section on normal visits (not
          collapsible - unchanged from before); collapsed by default right
          after claiming a home so first-visit declutter doesn't dump this
          below Systems too. */}
      {isFirstVisit ? (
        <details className="group space-y-3">
          <summary className="focus-ring w-fit cursor-pointer list-none [&::-webkit-details-marker]:hidden text-lg font-semibold text-stone-900 dark:text-stone-100">
            <span className="mr-1 inline-block transition-transform group-open:rotate-90">
              ▸
            </span>
            Thinking about a project?
          </summary>
          {projectChips}
        </details>
      ) : (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Thinking about a project?
          </h2>
          {projectChips}
        </section>
      )}

    </div>
  );
}
