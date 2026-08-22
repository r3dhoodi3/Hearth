import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { hasPlus } from "@/lib/subscription";
import {
  labelFor,
  SYSTEM_TYPES,
  ISSUE_CATEGORIES,
  categoryForSystem,
  materialLabel,
  STARTER_SYSTEM_NOTE,
} from "@/lib/constants";
import {
  assessSystem,
  systemStatus,
  lifeLeftText,
  effectiveYearsLeft,
  replacementInfoFor,
} from "@/lib/health";
import type { HomeSystem } from "@/lib/database.types";
import PrintButton from "@/components/PrintButton";
import SystemRow from "../profile/SystemRow";
import SystemForm from "../profile/SystemForm";
import MaintenanceHistoryForm from "./MaintenanceHistoryForm";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Format a YYYY-MM-DD date string as "Mar 5, 2028", timezone-safe (no Date
// parsing of a bare date string, which JS treats as UTC and can shift a day).
function fmtDate(d: string | null): string | null {
  if (!d) return null;
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return d;
  const mon = MONTHS[Number(m[2]) - 1];
  return mon ? `${mon} ${Number(m[3])}, ${m[1]}` : d;
}

// Format a timestamptz column (uploaded_at, completed_at, created_at) as a
// readable date. These carry a full timestamp already, so a plain Date parse
// is safe here (unlike the bare "new Date()" with no arguments).
function fmtTimestamp(ts: string): string {
  return new Date(ts).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const DOC_TYPE_LABEL: Record<string, string> = {
  warranty: "Warranty",
  manual: "Manual",
  receipt: "Receipt",
  inspection_report: "Inspection",
  other: "Document",
};

const CONDITION_LABEL: Record<number, string> = {
  5: "Like new",
  4: "Good",
  3: "Fair",
  2: "Worn",
  1: "Failing",
};

const SEVERITY_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  urgent: "Urgent",
};

// One system's full record, for the PRINTED report only.
//
// The printed report is the paid artifact, so it has to be the complete
// record, not a teaser: the slim summary table above it is an index, and this
// is the depth a buyer, an inspector, or an insurer actually needs. It shows
// the same facts the interactive card on screen shows (SystemRow), minus the
// things that only make sense on a screen:
//   - no edit / remove / "Find a pro" controls (a printed page can't act)
//   - no photo IMAGES, only a count: the images are on Hearth, and a dozen
//     full-bleed photos would bury the record they are supposed to support
//   - no generic maintenance tip: that is advice about this KIND of system,
//     not a fact about this home, and a record should only carry facts
// Status wording, the estimate exemption, and the life-left sentence come
// from the shared helpers in src/lib/health.ts, so this can never describe a
// system differently than the screen does.
function PrintSystemDetail({
  system: s,
  openIssue,
  photoCount,
}: {
  system: HomeSystem;
  openIssue: {
    category: string;
    description: string | null;
    severity: string | null;
  } | null;
  photoCount: number;
}) {
  const health = assessSystem(s);
  const status = systemStatus(s, openIssue);
  const cost = replacementInfoFor(s.system_type);
  const eff = effectiveYearsLeft(s);
  const yearsAway = eff != null ? Math.max(0, Math.round(eff)) : null;
  // filter_size is a migration 0042 column, absent from the generated types,
  // so it is read through a cast like everywhere else it appears. HVAC only.
  const filterSize =
    s.system_type === "hvac"
      ? ((s as any).filter_size as string | null | undefined) || null
      : null;
  // The onboarding placeholder note is not something the owner wrote, so it
  // never belongs in a record handed to someone else.
  const notes = s.notes && s.notes !== STARTER_SYSTEM_NOTE ? s.notes : null;

  // Every fact worth printing, in the order a reader scans for it. Anything
  // unknown is stated as "Not recorded" rather than dropped: a gap in the
  // record is itself information to a buyer, and a silently missing row reads
  // as if the question was never asked.
  const facts: { term: string; value: string }[] = [
    { term: "Status", value: status.label },
    { term: "Install year", value: s.install_year ? String(s.install_year) : "Not recorded" },
    { term: "Age", value: health.age != null ? `${health.age} years` : "Not recorded" },
    { term: "Typical life", value: `${health.lifespan} years` },
    { term: "Life left", value: lifeLeftText(s) },
    {
      term: "Condition",
      value: s.condition_rating
        ? `${CONDITION_LABEL[s.condition_rating] ?? s.condition_rating} (${s.condition_rating} of 5)`
        : "Not set",
    },
    { term: "Last serviced", value: fmtDate(s.last_serviced) ?? "Not recorded" },
    {
      term: materialLabel(s.system_type),
      value: s.material_or_model || "Not recorded",
    },
  ];
  if (s.model_number) facts.push({ term: "Model number", value: s.model_number });
  if (s.capacity) facts.push({ term: "Capacity / size", value: s.capacity });
  if (filterSize) facts.push({ term: "Filter size", value: filterSize });
  if (photoCount > 0) {
    facts.push({
      term: "Photos on file",
      value: `${photoCount} photo${photoCount === 1 ? "" : "s"} (in Hearth)`,
    });
  }

  return (
    <div className="mb-5 break-inside-avoid border-b border-stone-200 pb-4 last:border-b-0">
      <h3 className="text-base font-semibold text-stone-900">
        {labelFor(SYSTEM_TYPES, s.system_type)}
        <span className="ml-2 text-xs font-normal text-stone-500">
          {status.label}
        </span>
      </h3>

      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        {facts.map((f) => (
          <div key={f.term} className="flex justify-between gap-3 border-b border-stone-100 py-0.5">
            <dt className="text-stone-500">{f.term}</dt>
            <dd className="text-right text-stone-800">{f.value}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-2 text-sm text-stone-600">
        <span className="font-medium text-stone-800">Why this status: </span>
        {status.why}
      </p>

      {notes && (
        <p className="mt-1 text-sm text-stone-600">
          <span className="font-medium text-stone-800">Notes: </span>
          {notes}
        </p>
      )}

      {openIssue && (
        <p className="mt-1 text-sm text-stone-600">
          <span className="font-medium text-stone-800">Open issue: </span>
          {labelFor(ISSUE_CATEGORIES, openIssue.category)}
          {openIssue.severity
            ? ` (${SEVERITY_LABEL[openIssue.severity] ?? openIssue.severity})`
            : ""}
          {openIssue.description ? ` - ${openIssue.description}` : ""}
        </p>
      )}

      {cost && (
        // Marked as an estimate in the same breath as the number. This lands
        // in front of buyers and insurers, so it must never be mistakable for
        // a quote or an appraisal.
        <p className="mt-1 text-xs text-stone-500">
          Hearth estimate for replacement: ${cost.low.toLocaleString()} to $
          {cost.high.toLocaleString()}
          {yearsAway === 0 ? ", due now" : ""}. Based on this system&apos;s age
          and condition, not a quote.
        </p>
      )}
    </div>
  );
}

export default async function HomeReportPage() {
  // hasPlus and getActiveProperty don't depend on each other - run them
  // together instead of stacking two round trips before the redirect check.
  const [plus, propertyOrNull] = await Promise.all([
    hasPlus(),
    getActiveProperty(),
  ]);
  // Everyone reaches the report now, built from their own real data. The gate
  // moved to the EXPORT: non-members can read the whole thing on screen, but
  // printing or saving it as a PDF is what Plus buys (see PrintButton below
  // and the print-only watermark at the bottom of this file).
  if (!propertyOrNull) redirect("/onboarding");

  const property = propertyOrNull;
  const supabase = await createClient();

  const [
    { data: systems },
    { data: documents },
    { data: tasks },
    { data: issues },
    { data: pics },
  ] = await Promise.all([
    // Reads the exact same home_systems rows the home page reads and writes
    // (no snapshot copy), so an edit made here or there shows up everywhere:
    // dashboard tiles, forecast, maintenance plan.
    //
    // Kept as select(*) on purpose - see the matching comment in
    // dashboard/page.tsx. filter_size/filter_interval_months (migration
    // 0042) aren't in the generated Database type, so Supabase's typed
    // client rejects an explicit select string naming them (compile error),
    // and every other column here is genuinely read downstream, so trimming
    // would save zero bytes anyway.
    supabase
      .from("home_systems")
      .select("*")
      .eq("property_id", property.id)
      .order("system_type", { ascending: true }),
    supabase
      .from("documents")
      // brand/model/install_year were being fetched but this page never
      // reads them (only title, doc_type, warranty_expires, uploaded_at are
      // used below) - dropped.
      .select("id, title, doc_type, warranty_expires, uploaded_at")
      .eq("property_id", property.id)
      .order("uploaded_at", { ascending: false }),
    // select("*") rather than a fixed column list, so optional history columns
    // added by a later migration (cost_cents, performed_by - see 0061) show up
    // automatically once that migration runs, with no code change here.
    supabase
      .from("maintenance_tasks")
      .select("*")
      .eq("property_id", property.id)
      .order("due_date", { ascending: false }),
    supabase
      .from("issues")
      .select("id, category, severity, description, status, created_at")
      .eq("property_id", property.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("photos")
      .select("related_id, url")
      .eq("property_id", property.id)
      .eq("related_type", "system"),
  ]);

  const sys = systems ?? [];
  const docs = documents ?? [];
  const allTasks = tasks ?? [];
  const allIssues = issues ?? [];

  // Group system photos by system id, and map each system to its open issue
  // by category - the same shape SystemRow expects, matching the dashboard
  // (../dashboard/page.tsx) so the same edit UI behaves identically here.
  const photosBySystem = new Map<string, string[]>();
  for (const p of pics ?? []) {
    const list = photosBySystem.get(p.related_id) ?? [];
    list.push(p.url);
    photosBySystem.set(p.related_id, list);
  }
  const openIssueByCat = new Map<string, (typeof allIssues)[number]>();
  for (const i of allIssues) {
    if (i.status !== "open") continue;
    if (!openIssueByCat.has(i.category)) openIssueByCat.set(i.category, i);
  }
  const issueForSystem = (s: (typeof sys)[number]) =>
    openIssueByCat.get(categoryForSystem(s.system_type)) ?? null;

  // Collapse the issue log to one entry per category, showing only that
  // category's most recent row. This mirrors the dashboard, which dedupes
  // issues per category via a Map, so the two sides agree and the same roof
  // problem can't appear several times in contradictory states. The issues
  // query is already ordered created_at DESC (the only activity timestamp the
  // schema has), so the first row seen per category is the latest one, and
  // resolving updates a row in place, meaning each row is one logical issue.
  const latestIssueByCategory = new Map<string, (typeof allIssues)[number]>();
  for (const i of allIssues) {
    const seen = latestIssueByCategory.get(i.category);
    // An open issue always outranks a resolved one, matching the dashboard,
    // which surfaces open issues per category. Otherwise latest wins.
    if (!seen || (seen.status === "resolved" && i.status === "open")) {
      latestIssueByCategory.set(i.category, i);
    }
  }
  const issueLog = [...latestIssueByCategory.values()];

  // Completed tasks: most recently finished first. Upcoming tasks: soonest
  // due first, since that's the order that actually matters to a reader.
  const completedTasksRaw = allTasks
    .filter((t) => t.status === "done")
    .sort(
      (a, b) =>
        new Date(b.completed_at ?? b.created_at).getTime() -
        new Date(a.completed_at ?? a.created_at).getTime()
    );

  // The history list must never show the same real-world event twice. A
  // migration (0061) adds a DB-level unique index for new inserts, but that
  // only guards inserts made after it runs, and the data can still contain
  // older duplicates (e.g. a re-run maintenance plan). Dedupe defensively at
  // render on the same key the DB index uses: same title (case/space-
  // insensitive), same completed day. First occurrence wins, which is the
  // most recent one given the sort above.
  const seenHistoryKeys = new Set<string>();
  const completedTasks = completedTasksRaw.filter((t) => {
    const day = (t.completed_at ?? t.created_at).slice(0, 10);
    const key = `${t.title.trim().toLowerCase()}|${day}`;
    if (seenHistoryKeys.has(key)) return false;
    seenHistoryKeys.add(key);
    return true;
  });

  const upcomingTasks = allTasks
    .filter((t) => t.status !== "done")
    .sort((a, b) => {
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return a.due_date.localeCompare(b.due_date);
    });

  // cost_cents is a migration 0061 column, not yet in the generated types
  // (hence the cast) - undefined/null until that migration runs, which is
  // fine, the line just omits the cost. Whole-dollar entries show no
  // decimals; anything with real cents (e.g. $49.99) keeps them rather than
  // rounding to a misleading whole dollar.
  const money = (cents: number) => {
    const dollars = cents / 100;
    return (
      "$" +
      dollars.toLocaleString("en-US", {
        minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
        maximumFractionDigits: 2,
      })
    );
  };

  const reportDate = new Date(Date.now()).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const addressLine = [property.city, property.state].filter(Boolean).join(", ");

  // Basic house facts for the report header. Only what is actually on file:
  // a missing value is left out entirely rather than printed as a guess or a
  // placeholder, since this page is handed to people who will act on it.
  const propertyFacts = [
    property.sqft ? `${property.sqft.toLocaleString()} sq ft` : null,
    property.beds ? `${property.beds} bed${property.beds === 1 ? "" : "s"}` : null,
    property.baths ? `${property.baths} bath${property.baths === 1 ? "" : "s"}` : null,
  ].filter(Boolean) as string[];

  return (
    <div className="mx-auto max-w-3xl px-6 py-8 print:max-w-none print:p-0">
      {/* The export is the paid surface. Members get the real print button;
          everyone else gets a chipped door to /plus and one honest line about
          what they're looking at. The watermark at the bottom of this file is
          the other half: without it, Ctrl+P walks straight past this. */}
      <div className="mb-6 flex items-center justify-end gap-3 print:hidden">
        {plus ? (
          <PrintButton />
        ) : (
          <>
            <p className="text-sm text-stone-500 dark:text-stone-400">
              This report is ready - printing and sharing it is a Plus thing.
            </p>
            <Link href="/plus?reason=report" className="btn-primary">
              Print or save as PDF
              <span className="chip ml-1.5 bg-bark-100 text-bark-700 dark:bg-bark-700 dark:text-stone-300">
                Plus
              </span>
            </Link>
          </>
        )}
      </div>

      {/* Header */}
      <header className="mb-8 border-b border-stone-200 pb-6 print:border-black dark:border-stone-700">
        <h1 className="text-3xl font-semibold text-stone-900 dark:text-stone-100">Home report</h1>
        <p className="mt-2 text-lg text-stone-700 dark:text-stone-300">
          {property.address_line1}
          {addressLine ? `, ${addressLine}` : ""}
          {property.zip ? ` ${property.zip}` : ""}
        </p>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Built {property.year_built ?? "year unknown"} · Report generated{" "}
          {reportDate}
        </p>
        {/* The house facts a buyer or an insurer asks for in the first
            minute. Each one is omitted rather than guessed when it is not on
            file - a blank is honest, an invented number is not. */}
        {propertyFacts.length > 0 && (
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            {propertyFacts.join(" · ")}
          </p>
        )}
      </header>

      {/* Systems */}
      <section className="mb-8">
        <h2 className="mb-3 text-xl font-semibold text-stone-900 dark:text-stone-100">
          Home systems{sys.length > 0 ? ` (${sys.length})` : ""}
        </h2>

        {/* Printed report: a compact summary table as the INDEX, followed by
            the full per-system record below it. The table alone used to be
            the whole printed report, which meant the paid artifact carried
            less than the free screen - the export is what Plus sells, so it
            has to be the complete record. Both are print-only; the editable
            cards further down cover the screen. */}
        {sys.length === 0 ? (
          <p className="hidden text-sm text-stone-500 print:block">
            None recorded yet.
          </p>
        ) : (
          <div className="hidden print:block">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-stone-300 text-left text-stone-500">
                  <th className="py-2 pr-3 font-medium">System</th>
                  <th className="py-2 pr-3 font-medium">Brand / model</th>
                  <th className="py-2 pr-3 font-medium">Install year</th>
                  <th className="py-2 pr-3 font-medium">Age</th>
                  <th className="py-2 font-medium">Condition</th>
                </tr>
              </thead>
              <tbody>
                {sys.map((s) => {
                  const health = assessSystem(s);
                  return (
                    <tr key={s.id} className="border-b border-stone-100">
                      <td className="py-2 pr-3 text-stone-800">
                        {labelFor(SYSTEM_TYPES, s.system_type)}
                      </td>
                      <td className="py-2 pr-3 text-stone-600">
                        {s.material_or_model || "-"}
                      </td>
                      <td className="py-2 pr-3 text-stone-600">
                        {s.install_year ?? "-"}
                      </td>
                      <td className="py-2 pr-3 text-stone-600">
                        {health.age != null ? `${health.age} yrs` : "-"}
                      </td>
                      <td className="py-2 text-stone-600">
                        {s.condition_rating
                          ? CONDITION_LABEL[s.condition_rating] ?? "-"
                          : "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* The depth the table can't hold: every system's own record,
                one block each. break-inside-avoid keeps a system from being
                sliced across a page break. */}
            <div className="mt-6">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-stone-500">
                System details
              </h3>
              {sys.map((s) => (
                <PrintSystemDetail
                  key={s.id}
                  system={s}
                  openIssue={issueForSystem(s)}
                  photoCount={(photosBySystem.get(s.id) ?? []).length}
                />
              ))}
            </div>
          </div>
        )}

        {/* On-screen: the same editable system cards the home page uses (same
            component, same actions, same home_systems rows - not a snapshot),
            so an edit made here shows up on the home page and vice versa. */}
        <div className="print:hidden">
          {sys.length === 0 ? (
            <p className="text-sm text-stone-500 dark:text-stone-400">None recorded yet.</p>
          ) : (
            <ul className="space-y-3">
              {sys.map((s) => (
                <SystemRow
                  key={s.id}
                  system={s}
                  openIssue={issueForSystem(s)}
                  photos={photosBySystem.get(s.id) ?? []}
                />
              ))}
            </ul>
          )}
          <div className="mt-3">
            <SystemForm propertyId={property.id} />
          </div>
        </div>
      </section>

      {/* Documents */}
      <section className="mb-8">
        <h2 className="mb-3 text-xl font-semibold text-stone-900 dark:text-stone-100">
          Documents on file{docs.length > 0 ? ` (${docs.length})` : ""}
        </h2>
        {docs.length === 0 ? (
          <p className="text-sm text-stone-500 dark:text-stone-400">None recorded yet.</p>
        ) : (
          <ul className="divide-y divide-stone-100 dark:divide-white/10">
            {docs.map((d) => (
              <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                <span className="text-stone-800 dark:text-stone-200">
                  {d.title || "Home document"}
                  <span className="ml-2 text-xs text-stone-500 dark:text-stone-400">
                    {DOC_TYPE_LABEL[d.doc_type ?? "other"] ?? "Document"}
                  </span>
                </span>
                <span className="text-xs text-stone-500 dark:text-stone-400">
                  {d.warranty_expires
                    ? `Warranty to ${fmtDate(d.warranty_expires)} · `
                    : ""}
                  Added {fmtTimestamp(d.uploaded_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Maintenance history */}
      <section className="mb-8">
        <h2 className="mb-3 text-xl font-semibold text-stone-900 dark:text-stone-100">
          Maintenance history
        </h2>

        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          Completed{completedTasks.length > 0 ? ` (${completedTasks.length})` : ""}
        </h3>
        {/* Every row below is a real maintenance_tasks row the owner logged or
            checked off - this section never fabricates or infers entries. */}
        {completedTasks.length === 0 ? (
          <p className="mb-4 text-sm text-stone-500 dark:text-stone-400">
            No maintenance recorded yet.
          </p>
        ) : (
          <ul className="mb-4 divide-y divide-stone-100 dark:divide-white/10">
            {completedTasks.map((t) => {
              // cost_cents / performed_by are migration 0061 columns, not yet
              // in the generated types (hence the cast); absent until that
              // migration runs, which is fine - the line just omits them.
              const costCents = (t as any).cost_cents as number | null;
              const performedBy = (t as any).performed_by as string | null;
              const meta = [
                performedBy,
                costCents ? money(costCents) : null,
              ].filter(Boolean);
              return (
                <li key={t.id} className="flex justify-between gap-2 py-2 text-sm">
                  <span className="text-stone-800 dark:text-stone-200">
                    {t.title}
                    {meta.length > 0 && (
                      <span className="ml-2 text-xs text-stone-500 dark:text-stone-400">
                        {meta.join(" · ")}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-stone-500 dark:text-stone-400">
                    {fmtTimestamp(t.completed_at ?? t.created_at)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mb-4">
          <MaintenanceHistoryForm />
        </div>

        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          Upcoming{upcomingTasks.length > 0 ? ` (${upcomingTasks.length})` : ""}
        </h3>
        {upcomingTasks.length === 0 ? (
          <p className="text-sm text-stone-500 dark:text-stone-400">None recorded yet.</p>
        ) : (
          <ul className="divide-y divide-stone-100 dark:divide-white/10">
            {upcomingTasks.map((t) => (
              <li key={t.id} className="flex justify-between gap-2 py-2 text-sm">
                <span className="text-stone-800 dark:text-stone-200">{t.title}</span>
                <span className="text-xs text-stone-500 dark:text-stone-400">
                  {t.due_date ? fmtDate(t.due_date) : "No due date"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Repairs / issues log */}
      <section className="mb-8">
        <h2 className="mb-3 text-xl font-semibold text-stone-900 dark:text-stone-100">
          Repairs &amp; issue log
        </h2>
        {issueLog.length === 0 ? (
          <p className="text-sm text-stone-500 dark:text-stone-400">None recorded yet.</p>
        ) : (
          <ul className="divide-y divide-stone-100 dark:divide-white/10">
            {issueLog.map((i) => (
              <li key={i.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-stone-800 dark:text-stone-200">
                    {labelFor(ISSUE_CATEGORIES, i.category)}
                    {i.status === "resolved" ? (
                      // Resolved reads as a single, unambiguous state. Severity
                      // only describes an active problem, so we drop it here to
                      // avoid a "Low ... Resolved" contradiction.
                      <span className="ml-2 rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-500 print:border print:border-stone-300 print:bg-white dark:bg-stone-700 dark:text-stone-300">
                        Resolved
                      </span>
                    ) : (
                      <>
                        <span className="ml-2 rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-500 print:border print:border-stone-300 print:bg-white dark:bg-stone-700 dark:text-stone-300">
                          {SEVERITY_LABEL[i.severity] ?? i.severity}
                        </span>
                        <span className="ml-2 text-xs text-stone-500 dark:text-stone-400">Open</span>
                      </>
                    )}
                  </span>
                  <span className="text-xs text-stone-500 dark:text-stone-400">
                    {fmtTimestamp(i.created_at)}
                  </span>
                </div>
                {i.description && (
                  <p className="mt-1 text-stone-600 dark:text-stone-300">{i.description}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="mt-10 border-t border-stone-200 pt-4 text-xs text-stone-500 print:border-black dark:border-stone-700 dark:text-stone-400">
        {plus
          ? "Generated by Hearth. Share with buyers or your insurer."
          : "Generated by Hearth. Hearth Plus removes the preview watermark so you can hand this to a buyer or an insurer."}
      </footer>

      {/* Print-only watermark for non-members. The button above is a door, not
          a lock: Ctrl+P (or the browser menu) prints this page no matter what
          the button does, so the export gate only exists if the printed output
          says it is a preview. `hidden print:block` keeps it entirely off the
          screen; `fixed` makes the browser repaint it on every printed page
          rather than only the first. Light gray and semi-transparent on
          purpose - the report underneath stays readable, it just isn't
          something you would hand to an insurer. */}
      {!plus && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-50 hidden select-none overflow-hidden print:block"
        >
          {Array.from({ length: 8 }).map((_, row) => (
            <p
              key={row}
              className="whitespace-nowrap text-center text-4xl font-semibold uppercase tracking-widest text-stone-400/25"
              style={{
                position: "absolute",
                top: `${row * 13 + 4}%`,
                left: "-25%",
                width: "150%",
                transform: "rotate(-30deg)",
              }}
            >
              Hearth Plus preview &nbsp; Hearth Plus preview &nbsp; Hearth Plus
              preview
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
