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
import SystemsPhoneList from "./SystemsPhoneList";
import WalkthroughNudge from "./WalkthroughNudge";
import HomeAlerts from "@/components/HomeAlerts";
import WeatherStrip from "@/components/WeatherStrip";
import {
  Home,
  TrendingUp,
  Search,
  ClipboardList,
  FileText,
  CalendarDays,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import { calculateEquity, headlineHomeValue } from "@/lib/homeValue";
import { plausibleHomeFigure } from "@/lib/parcelSanity";
import HomeValueAutoFetch from "../value/ValueAutoFetch";
import ProjectChips from "../contractors/ProjectChips";
import { estimateSeasonalEnergyCost } from "@/lib/energy";
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

// The two one-time free-taste credits (migration 0099), read in one row so the
// query can ride along in the dashboard's main parallel wave instead of being
// a third sequential round trip.
//
// FAIL OPEN on any read error, including the columns not being live yet: a
// homeowner must never be told a free credit is used when it never was. No
// user id (signed out, which the (app) layout already prevents) reads as "no
// credits", exactly as before.
async function readFreeCredits(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string | null
): Promise<{ planUnused: boolean; quoteUnused: boolean }> {
  if (!userId) return { planUnused: false, quoteUnused: false };
  const { data, error } = await supabase
    .from("users")
    .select("free_plan_used_at, free_quote_used_at")
    .eq("id", userId)
    .maybeSingle();
  if (error) return { planUnused: true, quoteUnused: true };
  return {
    planUnused: !!data && data.free_plan_used_at === null,
    quoteUnused: !!data && data.free_quote_used_at === null,
  };
}

export default async function HomePage(
  props: {
    searchParams: Promise<{ welcome?: string; plan?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  // "View my plan" lands here with ?plan=open so the collapsed task groups
  // start expanded, making the click visibly do something.
  const planOpen = searchParams.plan === "open";
  // First visit after claiming a home (?welcome=1): the banner below already
  // walks through the started systems, so the below-the-fold detail sections
  // default collapsed instead of dumping everything open at once. Health
  // Score and "This month" stay expanded either way. Normal visits are
  // untouched.
  const isFirstVisit = !!searchParams.welcome;
  // getActiveProperty, hasPlus and getUser don't depend on each other - run
  // them together instead of stacking round trips before the redirect check.
  // getUser is the cached, network-free read, and its id is needed by the
  // free-credit query that now rides along in the wave below.
  const [property, plus, user] = await Promise.all([
    getActiveProperty(),
    hasPlus(),
    getUser(),
  ]);
  if (!property) redirect("/onboarding");
  const supabase = await createClient();

  const [
    { data: systems },
    { data: issues },
    { data: tasks },
    { data: pics },
    { data: jobs },
    { data: docs },
    credits,
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
    // The free-credit read used to be a THIRD sequential wave below (it only
    // ran for non-Plus homeowners, i.e. most of them), so the dashboard paid
    // three stacked round trips before it could render. Fired here instead:
    // same query, same cost when it runs, but off the critical path. Plus
    // members pay one extra parallel read they then ignore, which is cheaper
    // than an extra serial hop for everyone else.
    readFreeCredits(supabase, user?.id ?? null),
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
  // Same idea for the quote analyzer's one free check (users.
  // free_quote_used_at): the tile below advertises a "1 free" chip, and that
  // chip has to disappear once the credit is actually spent or it is an ad for
  // something the user no longer has. Read in the same round trip.
  //
  // Plus members never see either offer, so the read above is simply ignored
  // for them - same behavior as when this was gated behind `if (!plus)`.
  const freePlanCredit = !plus && credits.planUnused;
  const freeQuoteCredit = !plus && credits.quoteUnused;

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
  // THE BUILDING-RECORD GATE (src/lib/parcelSanity.ts), the same one /value
  // and /taxes apply. A condo's county record is the whole building's, so its
  // sale price can be the developer buying the parcel - and with no AVM on
  // file this tile would compound a $34,000,000 "purchase" into an eight-
  // figure headline. Measured against the AVM, never against the price itself.
  const homeValuePurchasePrice: number | null = plausibleHomeFigure(
    typeof rawProperty.purchase_price === "number" ? rawProperty.purchase_price : null,
    {
      unit: rawProperty.unit,
      propertyType: rawProperty.property_type,
      sqft: typeof rawProperty.sqft === "number" ? rawProperty.sqft : null,
      estimate:
        typeof rawProperty.market_value === "number" ? rawProperty.market_value : null,
    }
  );
  const homeValueMortgageBalance: number | null =
    typeof rawProperty.mortgage_balance === "number" ? rawProperty.mortgage_balance : null;
  // Dropped with the price it belongs to, so the model never runs from a
  // building's sale date.
  const homeValuePurchaseYear: number | null =
    property.purchase_date && homeValuePurchasePrice != null
      ? Number(property.purchase_date.slice(0, 4)) || null
      : null;
  const hasHomeValueData =
    homeValuePurchasePrice != null && homeValuePurchaseYear != null;
  // The headline number comes from the SAME shared chooser the /value page
  // uses (headlineHomeValue in src/lib/homeValue.ts): the stored RentCast AVM
  // when we have one, otherwise the capped purchase-price model. Both screens
  // calling one helper is what stops the tile and the page disagreeing on the
  // same day, and the cap is what stops a decades-old purchase compounding
  // into eight figures.
  const homeMarketValue: number | null =
    typeof rawProperty.market_value === "number" ? rawProperty.market_value : null;
  const homeHeadline = headlineHomeValue({
    marketValue: homeMarketValue,
    marketValueLow:
      typeof rawProperty.market_value_low === "number"
        ? rawProperty.market_value_low
        : null,
    marketValueHigh:
      typeof rawProperty.market_value_high === "number"
        ? rawProperty.market_value_high
        : null,
    purchasePrice: homeValuePurchasePrice,
    purchaseYear: homeValuePurchaseYear,
    state: property.state,
    currentYear: now.getFullYear(),
  });
  const homeEstimatedValue = homeHeadline?.value ?? null;
  const homeEquity =
    homeEstimatedValue != null
      ? calculateEquity(homeEstimatedValue, homeValueMortgageBalance)
      : null;
  // Kick the lazy AVM lookup off the FIRST time an address-holding home is
  // seen with no value on file, exactly as /value does. Client-side and
  // once-per-home (see HomeValueAutoFetch): this render never calls RentCast.
  const homeValueNeedsFetch =
    homeMarketValue == null && !!property.address_line1 && !!property.zip;

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

  // Shared body of the "Thinking about a project?" block - identical whether
  // it's rendered as a plain section (normal visits) or inside a collapsed
  // <details> (first visit), so the two render paths below can't drift.
  const projectChips = (
    <>
      <p className="text-sm text-stone-500 dark:text-stone-400">
        Popular upgrades. Tap one to get matched with a local pro.
      </p>
      {/* The chip row itself now lives in contractors/ProjectChips so the
          phone copy at the top of /contractors renders the exact same list.
          Same markup as before, just no longer written out twice. */}
      <ProjectChips />
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

      {/* The address masthead used to live here: a big address line, the home
          facts caption (or an "Add home details" link in its place), and a
          "Something broken right now?" link. All three are gone - the address
          is already in the top-left of the header on every page, and both
          links have permanent homes in the Tools menu ("Walk your home" and
          "Emergency"), so nothing lost an entry point. The dashboard now opens
          on the weather row and goes straight to the numbers.

          Quiet trust signal, kept: it only renders when the ownership check
          actually matched (migration 0093). Same green chip-ok tone and same
          wording spirit as the pro-side "Ownership verified" badge, so the
          semantics read the same on both ends. No section at all when
          unverified - nothing to nag about, since a mismatch is expected and
          harmless, and an empty section would leave a dead 32px gap in the
          space-y-8 stack. */}
      {property.ownership_status === "verified" && (
        <section>
          <details className="inline-block">
            <summary className="chip-ok focus-ring w-fit cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              Matches county records
            </summary>
            <p className="mt-1.5 max-w-sm text-xs text-stone-500 dark:text-stone-400">
              The name on your account matches the county assessor&apos;s
              public owner-of-record for this address. It&apos;s a soft trust
              signal we show pros, not proof of ownership.
            </p>
          </details>
        </section>
      )}

      {/* Proactive weather + safety-recall alerts; self-hides when there's none */}
      <HomeAlerts propertyId={property.id} />

      {/* PHONE ONLY. The floating Ask Hearth pill is desktop-only (see
          AskHearthDock's hideOnPhone), so on a phone the assistant lived
          entirely inside Messages as a pinned row - a tester never found it.
          This is the door: one compact row right under the weather and
          alerts, above every number on the page. Desktop is untouched; the
          pill is already on screen there. */}
      <Link
        href="/ask"
        data-testid="ask-hearth-card"
        className="card-link flex min-h-11 items-center gap-3 p-4 sm:hidden"
      >
        <span className="icon-chip">
          <Sparkles className="h-5 w-5 text-bark-700 dark:text-stone-300" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-stone-900 dark:text-stone-100">
            Ask Hearth anything about your home
          </span>
          <span className="mt-0.5 block truncate text-xs text-stone-500 dark:text-stone-400">
            Like: why is my water heater making that noise?
          </span>
        </span>
        <ChevronRight
          className="h-5 w-5 shrink-0 text-stone-400 dark:text-stone-500"
          aria-hidden="true"
        />
      </Link>

      {/* Key stats, kept above the fold so the Health Score is the first
          thing the owner sees. */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className={`card-hero border ${band.tone}`}>
          <div className="flex items-center gap-1.5">
            <p className="stat-label text-sm">Home Health Score</p>
            {/* One plain sentence for "what does this number mean," separate
                from the "Why this score?" breakdown below. A first-time
                visitor sees the score before they see any explanation of it
                otherwise, so this sits right next to the title. */}
            <details className="group">
              <summary className="focus-ring cursor-pointer list-none text-xs font-medium underline opacity-70 [&::-webkit-details-marker]:hidden hover:opacity-100 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">
                What is this?
              </summary>
              <p className="mt-1 max-w-xs text-xs opacity-80">
                Your home score is a quick read on how your home is doing. It
                goes up when systems are in good shape and tasks are done,
                and drops when something needs attention.
              </p>
            </details>
          </div>
          <p className="stat-number mt-1 text-4xl">{score}</p>
          <p className="text-sm">{mostlyEstimated ? "Estimated score" : band.label}</p>
          <details className="group mt-2 text-sm">
            <summary className="focus-ring flex w-fit cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden opacity-80 hover:opacity-100">
              <ChevronRight
                className="h-4 w-4 shrink-0 transition-transform duration-150 group-open:rotate-90"
                aria-hidden="true"
              />
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
            {mostlyEstimated && (
              <p className="mt-2 text-xs opacity-80">
                Based on your home&apos;s age until you confirm your systems.
              </p>
            )}
            {(biggestLever || unconfirmedCount > 0) && (
              <Link
                href="/walkthrough"
                className="mt-2 block font-medium underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
              >
                {biggestLever
                  ? `Confirm your ${labelFor(SYSTEM_TYPES, biggestLever.system.system_type).toLowerCase()} (+${biggestLever.pts} pts)`
                  : "Confirm your systems"}
              </Link>
            )}
          </details>
        </div>
        {/* Phone: hidden. "Open jobs" is a jobs concept, not a home-state one,
            and the home page was too long to scroll. The count now lives at the
            top of /contractors (the "Post" tab, one tap away on the bottom nav),
            which is also where this card already pointed. Desktop keeps the
            four-card grid exactly as it was. */}
        <Link
          href={openJobsCount > 0 ? "/contractors#your-jobs" : "/contractors"}
          className="card-link max-sm:hidden"
        >
          <p className="stat-label text-sm">Open jobs</p>
          {openJobsCount > 0 ? (
            <p className="stat-number mt-1 text-2xl">{openJobsCount}</p>
          ) : (
            <p className="mt-1 text-lg font-semibold text-stone-900 dark:text-stone-100">
              No open jobs
            </p>
          )}
          <p className="text-sm text-stone-500 dark:text-stone-400">
            {openJobsCount > 0 ? "View job postings" : "Post your first job"}
          </p>
        </Link>
        {/* Renders nothing: it exists to fire the one-per-home AVM lookup
            client-side, so the dashboard shows the real estimate instead of
            waiting for someone to open /value first. Cached 30 days in
            parcel_cache, so this costs at most one RentCast call per home per
            month, and none at all during this render. */}
        <HomeValueAutoFetch
          needsFetch={homeValueNeedsFetch}
          propertyId={property.id}
          silent
        />
        {/* Phone: hidden. /value is already a permanent entry in the phone
            Tools sheet ("Your home" group), so this card is a duplicate there,
            not the only way in. The AVM fetch above still runs on phone, so the
            number is warm by the time someone opens /value. Desktop unchanged. */}
        <Link href="/value" className="card-link max-sm:hidden">
          <p className="stat-label text-sm">Home value</p>
          {homeEstimatedValue != null ? (
            <>
              <p className="stat-number mt-1 text-2xl">
                ${Math.round(homeEstimatedValue).toLocaleString()}
              </p>
              <p className="text-sm text-stone-500 dark:text-stone-400">
                {homeEquity != null && homeEquity < 0
                  ? `-$${Math.round(Math.abs(homeEquity)).toLocaleString()} equity`
                  : `$${Math.round(homeEquity ?? 0).toLocaleString()} equity`}
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 text-lg font-semibold text-stone-900 dark:text-stone-100">
                Not tracked yet
              </p>
              <p className="text-sm text-stone-500 dark:text-stone-400">
                Get your estimate
              </p>
            </>
          )}
        </Link>
        {/* A plain card, not a link: this used to open /forecast, which is
            the 10-year REPAIR forecast and never mentions energy at all -
            a tester followed it expecting an energy breakdown and found
            nothing about energy on the page. In place of navigating
            anywhere, it now discloses its own method inline, matching the
            Health Score card's "Why this score?" pattern above. */}
        <div className="card">
          <p className="stat-label text-sm">Energy this season</p>
          {energyEstimate ? (
            <>
              <p className="stat-number mt-1 text-2xl">
                ~${energyEstimate.low.toLocaleString()}-
                {energyEstimate.high.toLocaleString()}
              </p>
              <p className="text-sm text-stone-500 dark:text-stone-400">
                {energySeason === "winter"
                  ? "For heating this winter"
                  : "For cooling this summer"}
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 text-lg font-semibold text-stone-900 dark:text-stone-100">
                No estimate yet
              </p>
              <p className="text-sm text-stone-500 dark:text-stone-400">
                Add home details
              </p>
            </>
          )}
          <details className="group mt-2 text-sm">
            <summary className="focus-ring flex w-fit cursor-pointer list-none items-center gap-1 text-stone-500 [&::-webkit-details-marker]:hidden hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-300">
              <ChevronRight
                className="h-4 w-4 shrink-0 transition-transform duration-150 group-open:rotate-90"
                aria-hidden="true"
              />
              How this is estimated?
            </summary>
            <p className="mt-1.5 text-xs text-stone-500 dark:text-stone-400">
              Estimated from your home&apos;s size, age, and typical energy
              prices in your state, plus your HVAC&apos;s age and type if
              you&apos;ve added one. It&apos;s a ballpark, not a bill.
            </p>
            <Link
              href="/walkthrough"
              className="mt-1.5 block font-medium text-bark-700 underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-stone-300"
            >
              Add home details
            </Link>
          </details>
        </div>
      </section>

      {/* This month: focus + one merged checklist (reminders + seasonal) */}
      <section id="this-month" className="scroll-mt-20 space-y-3">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">This month</h2>
        <WalkthroughNudge count={unconfirmedCount} />
        <div className="card space-y-3">
          <div className="rounded-lg bg-bark-50 p-3 dark:bg-bark-700/30">
            <p className="text-xs font-semibold uppercase tracking-wide text-bark-700 dark:text-stone-300">
              This month&apos;s checklist
            </p>
            {/* Each briefing item with a destination is one full-width row
                that is entirely tappable, not a bare "→" glyph glued to the
                end of a wrapped sentence. The row clears 44px, the label
                ("Find a pro", "Plan it") stays visible, and the chevron is the
                same real icon every other disclosure on this page uses. Same
                colors as before at every width - the row just became a row.
                One anchor per item, no nesting (dashboardShape.test.tsx). */}
            <ul className="mt-1.5 space-y-1">
              {briefing.map((b, i) =>
                b.href ? (
                  <li key={i}>
                    <Link
                      href={b.href}
                      className="focus-ring -mx-2 flex min-h-11 items-center gap-2 rounded-lg px-2 py-2 text-sm text-stone-900 hover:bg-black/[0.03] active:bg-black/[0.06] dark:text-stone-100 dark:hover:bg-white/[0.05]"
                    >
                      <span className="flex-1">
                        {b.urgent && (
                          <span className="chip-danger mr-1 py-0 align-middle">
                            Urgent
                          </span>
                        )}
                        {b.text}
                      </span>
                      <span className="flex shrink-0 items-center gap-0.5 whitespace-nowrap font-medium text-bark-700 dark:text-stone-300">
                        {b.cta}
                        <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
                      </span>
                    </Link>
                  </li>
                ) : (
                  <li
                    key={i}
                    className="-mx-2 flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-stone-900 dark:text-stone-100"
                  >
                    <span className="flex-1">
                      {b.urgent && (
                        <span className="chip-danger mr-1 py-0 align-middle">
                          Urgent
                        </span>
                      )}
                      {b.text}
                    </span>
                  </li>
                )
              )}
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

            <details
              open={planOpen || isFirstVisit}
              className="group mt-3"
              data-testid="this-month-tasks"
            >
              <summary className="focus-ring flex w-fit cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden text-sm font-medium text-stone-700 dark:text-stone-300">
                <ChevronRight
                  className="h-4 w-4 shrink-0 text-stone-400 transition-transform duration-150 group-open:rotate-90 dark:text-stone-500"
                  aria-hidden="true"
                />
                See this month&apos;s tasks
              </summary>

              <ChecklistProvider>
                <div className="mt-3 space-y-4">
                  {/* Near-term work stays in view; everything further out
                      folds into collapsed groups so the card shows a handful
                      of tasks, not a wall. */}
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
                          className={`focus-ring flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden px-2 text-xs font-semibold uppercase tracking-wide ${URGENCY_TONE[u]}`}
                        >
                          <ChevronRight
                            className="h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-open:rotate-90"
                            aria-hidden="true"
                          />
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
                    <summary className="focus-ring flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden px-2 text-xs font-semibold uppercase tracking-wide text-stone-600 dark:text-stone-400">
                      <ChevronRight
                        className="h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-open:rotate-90"
                        aria-hidden="true"
                      />
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
                            <FileText className="h-4 w-4" aria-hidden="true" />
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
            </details>
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
                Reminders timed to your systems.
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
                First plan build is free.
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

        <div className="grid grid-cols-3 gap-2 sm:gap-4">
          {[
            // All three go straight to the tool, member or not. Each page
            // handles its own gating in context (the forecast masks the
            // per-system detail, the quote analyzer spends the one free check
            // then redirects, the home report opens and gates the export), so
            // routing a free user to a pitch page first only hid the product
            // behind an ad for the product.
            {
              href: "/forecast",
              icon: TrendingUp,
              title: "Cost forecast",
              line: "Plan future costs",
            },
            {
              href: "/quote-check",
              icon: Search,
              title: "Quote analyzer",
              line: "Check a quote",
            },
            {
              href: "/home-report",
              icon: ClipboardList,
              title: "Home report",
              line: "Shareable home record",
            },
          ].map((t) => (
            <Link key={t.title} href={t.href} className="card-link p-3 text-center">
              <p className="icon-chip">
                <t.icon className="h-5 w-5" aria-hidden="true" />
              </p>
              <p className="mt-1.5 text-xs font-medium text-stone-900 dark:text-stone-100 sm:text-sm">
                {t.title}
              </p>
              {!plus && (
                <p className="mt-0.5 flex flex-wrap justify-center gap-1">
                  <PlusChip />
                  {freeQuoteCredit && t.title === "Quote analyzer" && (
                    <span className="chip bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300">
                      1 free
                    </span>
                  )}
                </p>
              )}
              <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{t.line}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* Systems inventory (the old Home Profile) */}
      {/* Open by default, always. It used to collapse on a first visit
          (?welcome), which hid the "+ Roof / + HVAC" quick-adds from exactly
          the person who needs them. The summary line stays visible either
          way - collapsing only drops the list under it. */}
      <details id="systems" open className="group space-y-4">
        <summary className="focus-ring flex w-fit cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden text-lg font-semibold text-stone-900 dark:text-stone-100">
          {/* Real chevron rather than a "▸" glyph: it rotates to point down
              when the section is open, so the control shows its own state. */}
          <ChevronRight
            className="h-5 w-5 shrink-0 text-stone-400 transition-transform duration-150 group-open:rotate-90 dark:text-stone-500"
            aria-hidden="true"
          />
          <span>
            Your systems{sortedSys.length > 0 ? ` (${sortedSys.length})` : ""}
          </span>
          {mustCount > 0 ? (
            <span className="chip chip-danger">{mustCount} must do</span>
          ) : null}
        </summary>

        {sortedSys.length > 0 ? (
          // Phone: the first three rows, then "See all N systems" expands the
          // rest in place. Desktop renders the same <ul> with every row, as
          // before - see SystemsPhoneList.
          <SystemsPhoneList total={sortedSys.length}>
            {sortedSys.map((s) => (
              <SystemRow
                key={s.id}
                system={s}
                openIssue={issueForSystem(s)}
                photos={photosBySystem.get(s.id) ?? []}
              />
            ))}
          </SystemsPhoneList>
        ) : (
          <div className="rounded-xl border border-dashed border-stone-300 p-6 text-center dark:border-stone-700">
            <div className="flex justify-center">
              <span className="icon-chip">
                <Home className="h-5 w-5" aria-hidden="true" />
              </span>
            </div>
            <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
              Add your roof, HVAC, and water heater to get started.
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
          below Systems too.

          Phone: both render paths are hidden (max-sm:hidden). Twenty-one chips
          wrap to about seven rows at 390px, which is a big chunk of scroll for
          a browse-y section at the very bottom of the home page. The same chips
          now sit at the top of /contractors on phone, right above the Post a
          job form they prefill. Desktop keeps this block exactly as it was. */}
      {isFirstVisit ? (
        <details className="group space-y-3 max-sm:hidden">
          <summary className="focus-ring flex w-fit cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden text-lg font-semibold text-stone-900 dark:text-stone-100">
            <ChevronRight
              className="h-5 w-5 shrink-0 text-stone-400 transition-transform duration-150 group-open:rotate-90 dark:text-stone-500"
              aria-hidden="true"
            />
            Thinking about a project?
          </summary>
          {projectChips}
        </details>
      ) : (
        <section className="space-y-3 max-sm:hidden">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Thinking about a project?
          </h2>
          {projectChips}
        </section>
      )}

    </div>
  );
}
