import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import {
  SYSTEM_TYPES,
  ISSUE_CATEGORIES,
  labelFor,
  categoryForSystem,
} from "@/lib/constants";
import { DEFAULT_LIFESPANS, assessSystem } from "@/lib/health";
import AskHearth from "@/components/AskHearth";
import LearnGuides, { type GuideData } from "./LearnGuides";

const STAGE_LABEL: Record<string, string> = {
  healthy: "Healthy",
  aging: "Plan ahead",
  due: "Needs maintenance",
  unknown: "Add details",
};
const STAGE_STYLE: Record<string, string> = {
  healthy: "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200",
  aging: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300",
  due: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
  unknown: "border-stone-200 bg-stone-50 text-stone-500 dark:border-white/10 dark:bg-stone-700 dark:text-stone-400",
};

// Short, concise maintenance bullets per system. Kept here since it's only used
// on this page.
const LEARN: Record<string, string[]> = {
  roof: [
    "Inspect after big storms for missing, curled, or cracked shingles.",
    "Keep valleys and gutters clear so water drains off fast.",
    "Trim branches that rub the surface or drop debris.",
    "Ceiling stains usually mean a leak. Act early.",
  ],
  hvac: [
    "Swap the air filter every 1 to 3 months.",
    "Book a pro tune-up before summer and before winter.",
    "Keep the outdoor unit clear of leaves with 2 ft of space.",
    "Weak airflow or short cycling means it needs a look.",
  ],
  water_heater: [
    "Flush the tank once a year to clear sediment.",
    "Test the pressure-relief valve annually.",
    "Check the anode rod every 2 to 3 years.",
    "Rusty water or popping sounds signal wear.",
  ],
  electrical_panel: [
    "Label which breaker controls what.",
    "Breakers that trip often point to a real problem.",
    "A warm cover or burning smell is urgent. Call a pro.",
    "Avoid overloading outlets with power strips.",
  ],
  plumbing: [
    "Know where your main water shutoff is.",
    "Check under sinks now and then for slow leaks.",
    "Never pour grease down a drain.",
    "Let faucets drip in a freeze to protect pipes.",
  ],
  windows: [
    "Reseal worn caulk and weatherstripping yearly.",
    "Clear weep holes so water drains out.",
    "Foggy glass means a broken seal.",
    "Lubricate tracks so they open and close freely.",
  ],
  foundation: [
    "Keep soil sloped away from the house.",
    "New or growing cracks deserve a pro's eye.",
    "Doors that suddenly stick can signal movement.",
    "Aim downspouts well away from the base.",
  ],
  appliance: [
    "Clean coils, lint traps, and filters regularly.",
    "Don't overload washers or dryers.",
    "Keep the manual for model-specific care.",
    "Odd noises or smells mean stop and check.",
  ],
  gutters: [
    "Clear leaves at least twice a year.",
    "Make sure downspouts carry water 4+ ft away.",
    "Check for sagging or pulling-away sections.",
    "Overflow stains on siding mean a clog.",
  ],
  siding: [
    "Rinse off dirt and mildew once a year.",
    "Touch up paint or caulk to keep moisture out.",
    "Look for warping, rot, or pest holes.",
    "Keep sprinklers from constantly hitting it.",
  ],
  garage_door: [
    "Test the auto-reverse safety feature monthly.",
    "Lubricate rollers and hinges yearly.",
    "Never DIY the torsion springs. Call a pro.",
    "Listen for grinding or jerky movement.",
  ],
  deck: [
    "Check for loose boards and popped nails.",
    "Reseal or stain the wood every 2 to 3 years.",
    "Look for soft, rotting spots near the ground.",
    "Keep board gaps clear so water drains.",
  ],
  driveway: [
    "Seal cracks before winter so water can't freeze in them.",
    "Reseal asphalt every few years.",
    "Fix low spots where water pools.",
    "Go easy on harsh de-icing salt on concrete.",
  ],
  sump_pump: [
    "Pour in a bucket of water to test it a few times a year.",
    "Keep the pit free of debris.",
    "Add a battery backup for storms and outages.",
    "Constant running or silence in rain means trouble.",
  ],
  sewer_line: [
    "Flush only toilet paper. No wipes or grease.",
    "Slow drains house-wide signal a main-line clog.",
    "Consider a camera inspection every few years.",
    "Tree roots are a common cause of blockages.",
  ],
  fence: [
    "Reset leaning posts early before they pull others.",
    "Seal or stain wood to slow rot.",
    "Check for loose boards and rusted hardware.",
    "Clear vines and growth that trap moisture.",
  ],
};

// One-line summary shown before a guide is expanded, so the card is useful even
// collapsed.
const SUMMARY: Record<string, string> = {
  roof: "Watch for storm damage and keep water moving off the roof.",
  hvac: "Change the filter often and get it tuned up twice a year.",
  water_heater: "Flush it yearly and watch for rust or strange noises.",
  electrical_panel: "Know your breakers, and take warning signs seriously.",
  plumbing: "Know your shutoff, and catch slow leaks early.",
  windows: "Reseal yearly, and keep tracks and weep holes clear.",
  foundation: "Keep water sloped away, and watch for new cracks.",
  appliance: "Clean filters and coils, and don't overload them.",
  gutters: "Clear them at least twice a year so water drains properly.",
  siding: "Rinse it yearly and fix small damage before it spreads.",
  garage_door: "Test the safety reverse, and lubricate moving parts.",
  deck: "Check for rot, and reseal the wood every couple years.",
  driveway: "Seal cracks early so water can't freeze and expand them.",
  sump_pump: "Test it a few times a year, and keep the pit clear.",
  sewer_line: "Flush only paper, and watch for house-wide slow drains.",
  fence: "Reset leaning posts early, and reseal wood to slow rot.",
};

// Broader category per system, used for the filter chips. Grouped by the kind
// of pro or trade a homeowner would think of, not the raw system list.
const CATEGORY: Record<string, string> = {
  roof: "Roof & exterior",
  gutters: "Roof & exterior",
  siding: "Roof & exterior",
  windows: "Roof & exterior",
  deck: "Roof & exterior",
  fence: "Roof & exterior",
  driveway: "Roof & exterior",
  garage_door: "Roof & exterior",
  foundation: "Structural",
  hvac: "Heating and cooling (HVAC)",
  water_heater: "Plumbing",
  plumbing: "Plumbing",
  sump_pump: "Plumbing",
  sewer_line: "Plumbing",
  electrical_panel: "Electrical",
  appliance: "Appliances",
};

export default async function LearnPage() {
  const supabase = await createClient();
  const property = await getActiveProperty();

  // First instance of each system type they own, for inline status; plus their
  // most recent open issue, to seed a personal starter question.
  const byType = new Map<string, any>();
  let openIssueCategory: string | null = null;
  // Most recent open issue per category, so a pure age-estimate can be told
  // apart from a system with a real reported problem (mirrors SystemRow's
  // isPureAgeEstimate below).
  const openIssueByCat = new Map<string, any>();
  if (property) {
    const [{ data: systems }, { data: issues }] = await Promise.all([
      supabase.from("home_systems").select("*").eq("property_id", property.id),
      supabase
        .from("issues")
        .select("category, severity")
        .eq("property_id", property.id)
        .eq("status", "open")
        .order("created_at", { ascending: false }),
    ]);
    for (const s of systems ?? [])
      if (!byType.has(s.system_type)) byType.set(s.system_type, s);
    if (issues && issues.length) openIssueCategory = issues[0].category;
    for (const i of issues ?? [])
      if (!openIssueByCat.has(i.category)) openIssueByCat.set(i.category, i);
  }

  // Only the systems the owner actually has; fall back to all if none added yet.
  const owned = SYSTEM_TYPES.filter((t) => byType.has(t.value));
  const types = owned.length ? owned : SYSTEM_TYPES;

  // Starter questions seeded from THEIR systems - aging ones ask about lifespan,
  // the rest about maintenance. An open issue takes top billing.
  const suggestions: string[] = [];
  for (const t of owned.slice(0, 3)) {
    const stage = assessSystem(byType.get(t.value)).stage;
    // Keep all-caps acronyms like HVAC uppercase; lowercase normal words so the
    // question reads naturally ("Is my roof...", not "Is my Roof...").
    const label =
      t.label === t.label.toUpperCase() ? t.label : t.label.toLowerCase();
    suggestions.push(
      stage === "due" || stage === "aging"
        ? `Is my ${label} near the end of its life?`
        : `How do I maintain my ${label}?`
    );
  }
  if (openIssueCategory) {
    suggestions.unshift(
      `What should I do about my open ${labelFor(
        ISSUE_CATEGORIES,
        openIssueCategory
      ).toLowerCase()} issue?`
    );
  }
  if (suggestions.length === 0)
    suggestions.push("How do I keep my home in good shape?");
  if (suggestions.length < 4)
    suggestions.push("What should I focus on this season?");

  // Flatten each system into plain guide data for the client-side search,
  // filter, and accordion component.
  const guides: GuideData[] = types.map((t) => {
    const instance = byType.get(t.value);
    const h = instance ? assessSystem(instance) : null;
    const aging = h?.stage === "due" || h?.stage === "aging";
    const label = t.label.toLowerCase();
    // A "due" status with no walkthrough confirmation, no owner-entered
    // condition, and no reported issue is only an age-based guess, not a
    // confirmed problem, so it shouldn't read as scary-red (same softening as
    // profile/SystemRow.tsx's isPureAgeEstimate/estimatedDue).
    const openIssue = openIssueByCat.get(categoryForSystem(t.value)) ?? null;
    const isPureAgeEstimate =
      !!instance &&
      !instance.confirmed_at &&
      instance.condition_rating == null &&
      !openIssue;
    const estimatedDue = h?.stage === "due" && isPureAgeEstimate;
    return {
      systemType: t.value,
      label: t.label,
      category: CATEGORY[t.value] ?? "Other",
      summary: SUMMARY[t.value] ?? "",
      lifespan: DEFAULT_LIFESPANS[t.value] ?? "varies",
      statusLabel: estimatedDue
        ? "Check soon (estimated)"
        : h
          ? STAGE_LABEL[h.stage]
          : undefined,
      statusStyle: estimatedDue
        ? "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300"
        : h
          ? STAGE_STYLE[h.stage]
          : undefined,
      age: h?.age ?? null,
      tips: LEARN[t.value] ?? [],
      askQuestion: aging
        ? `My ${label} is getting older. What should I be doing, and is it near replacement?`
        : `How should I maintain my ${label}?`,
    };
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Learn</h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Ask anything about your home and get an answer based on your actual
          systems. Or search, filter, and browse the basics below.
        </p>
      </div>

      <AskHearth suggestions={suggestions} />

      <div>
        <h2 className="text-sm font-semibold text-stone-700 dark:text-stone-300">
          Maintenance basics
        </h2>
        <div className="mt-2">
          <LearnGuides guides={guides} />
        </div>
      </div>
    </div>
  );
}
