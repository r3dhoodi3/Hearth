import { redirect } from "next/navigation";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Bot, Clock, Star, FileText, Tag, BarChart3 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentContractor } from "@/lib/contractor";
import { hasProPlan, getProSubscription } from "@/lib/subscription";
import { labelFor, JOB_CATEGORIES, PRO_PLAN } from "@/lib/constants";
import SubmitButton from "@/components/SubmitButton";
import ClientRow from "./ClientRow";
import { addClientAction, trackLeadAction } from "./actions";

// The premium CRM upgrades a Hearth Pro membership adds on top of the free
// pipeline. Honest framing: only things that actually work in the app today
// may appear here. Tapping a card sends a non-member to /pro/plus, and a
// member to the real tool (via `href`).
const PRO_CRM_FEATURES: Array<{
  icon: LucideIcon;
  title: string;
  body: string;
  href?: string;
}> = [
  {
    icon: Bot,
    title: "AI back office",
    body: "Draft estimates, invoices, follow-up messages, review responses, and overdue-invoice reminders in seconds, so evenings go back to being evenings.",
    href: "/pro/tools",
  },
  {
    icon: Star,
    title: "Automated review requests",
    // Real, shipped behavior: updateLeadStatusAction (src/app/pro/actions.ts)
    // fires requestReviewForWonLead automatically for Pro members on the
    // closed (Won) transition. Not a planned item, so it belongs here, not
    // in the "What's coming" list below.
    body: "Mark a job Won and we ask the homeowner for a review automatically. No extra step, no reminder to send yourself.",
  },
];

// On our roadmap for the CRM, clearly labeled as planned. Nothing in this
// list exists in the app yet, and nothing here is sold as if it does.
const PLANNED_CRM_FEATURES: Array<{ icon: LucideIcon; label: string }> = [
  { icon: Clock, label: "Automated follow-up reminders" },
  { icon: FileText, label: "Saved quote and estimate templates" },
  { icon: Tag, label: "Customer tags and filtering" },
  { icon: BarChart3, label: "Pipeline analytics and CSV export" },
];

const STAGES: { value: string; label: string }[] = [
  { value: "lead", label: "Lead" },
  { value: "quoted", label: "Quoted" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

// Maps a lead's own pipeline status to a starting CRM stage: closed is this
// app's "Won" (see STATUS_LABEL on /pro/business and /pro), lost stays lost,
// and anything still in progress (new, accepted) starts as a plain lead.
function stageForLeadStatus(status: string): string {
  if (status === "closed") return "won";
  if (status === "lost") return "lost";
  return "lead";
}

function dollarsFromCents(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

// A pipeline CRM for pros: a stage, an estimated value, contact info the pro
// types in themselves, a notes timeline, and an optional follow up date. It
// never stores or joins to a homeowner's own email or phone: contact fields
// and notes are typed in by the pro, and lead_id only links back to a job or
// chat the pro can already open.
export default async function ProCrmPage(
  props: {
    searchParams: Promise<{ q?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const contractor = await getCurrentContractor();
  // No company yet: company setup is the only way in, whatever the account's
  // preferred-side stamp says (see /pro/page.tsx).
  if (!contractor) redirect("/pro/onboarding");

  const supabase = await createClient();
  const q = (searchParams.q ?? "").trim();

  const [{ data: clientRows }, { data: leadRows }, member, proSub] = await Promise.all([
    supabase
      .from("pro_clients")
      .select("*")
      .eq("contractor_id", contractor.id)
      .order("created_at", { ascending: false }),
    // Only the fields the pipeline already shows for a job a homeowner chose
    // this pro for. Deliberately never homeowner_email or homeowner_phone.
    supabase
      .from("contractor_leads")
      .select("id, category, status, homeowner_name, created_at")
      .eq("contractor_id", contractor.id)
      .order("created_at", { ascending: false }),
    // Paying Pro-member check: drives the locked upgrade teaser below only. It
    // never gates any of the CRM functionality above.
    hasProPlan(),
    // The Pro-side row itself, for the teaser's CTA copy: the free trial is
    // for brand-new members only, and the row survives cancellation, so a pro
    // who churned and came back must not be offered a trial they won't get.
    // Free to ask for - hasProPlan() reads the same request-cached rows.
    getProSubscription(),
  ]);

  const clients = clientRows ?? [];
  const leads = leadRows ?? [];

  // The search box narrows the grouped list below; the stage tiles, the
  // follow up digest, and the job suggestions all stay based on every client
  // so the pipeline overview never shifts just because someone is searching.
  let displayClients = clients;
  if (q) {
    const { data: filteredRows } = await supabase
      .from("pro_clients")
      .select("*")
      .eq("contractor_id", contractor.id)
      .ilike("client_name", `%${q}%`)
      .order("created_at", { ascending: false });
    displayClients = filteredRows ?? [];
  }

  const clientIds = clients.map((c) => c.id);
  const { data: noteRows } =
    clientIds.length > 0
      ? await supabase
          .from("pro_client_notes")
          .select("client_id, body, created_at")
          .in("client_id", clientIds)
          .order("created_at", { ascending: false })
      : { data: [] };
  const latestNoteByClient = new Map<string, string>();
  for (const n of noteRows ?? []) {
    if (!latestNoteByClient.has(n.client_id)) {
      latestNoteByClient.set(n.client_id, n.body);
    }
  }

  const trackedLeadIds = new Set(
    clients.map((c) => c.lead_id).filter((id): id is string => Boolean(id))
  );
  const suggestions = leads.filter((l) => !trackedLeadIds.has(l.id));

  const todayStr = new Date().toISOString().slice(0, 10);
  const dueForFollowUp = clients
    .filter((c) => c.follow_up_on && c.follow_up_on <= todayStr)
    .sort((a, b) =>
      (a.follow_up_on ?? "").localeCompare(b.follow_up_on ?? "")
    );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Clients</h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Your pipeline: a stage, an estimated value, contact info, and a
          notes timeline for everyone you&apos;re doing business with.
        </p>
      </div>

      <section className="grid gap-4 sm:grid-cols-4">
        {STAGES.map((s) => {
          const items = clients.filter((c) => c.stage === s.value);
          const total = items.reduce(
            (sum, c) => sum + (c.est_value_cents ?? 0),
            0
          );
          return (
            <div key={s.value} className="card">
              <p className="stat-label">{s.label}</p>
              <p className="stat-number mt-1 text-2xl">
                {items.length}
              </p>
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                {dollarsFromCents(total)} estimated
              </p>
            </div>
          );
        })}
      </section>

      <form action="/pro/crm" method="get" className="flex gap-2">
        <input
          type="text"
          name="q"
          defaultValue={q}
          placeholder="Search clients by name"
          className="input"
        />
        <button type="submit" className="btn-secondary shrink-0">
          Search
        </button>
        {q && (
          <Link href="/pro/crm" className="btn-secondary shrink-0">
            Clear
          </Link>
        )}
      </form>

      {dueForFollowUp.length > 0 && (
        <section className="card-hero space-y-3">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Follow up today{" "}
            <span className="text-stone-500 dark:text-stone-400">({dueForFollowUp.length})</span>
          </h2>
          <ul className="space-y-2">
            {dueForFollowUp.map((c) => (
              <ClientRow
                key={c.id}
                client={c}
                todayStr={todayStr}
                latestNote={latestNoteByClient.get(c.id) ?? null}
              />
            ))}
          </ul>
        </section>
      )}

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          Add a client
        </h2>
        <form action={addClientAction} className="grid gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="label">Client name</span>
            <input
              type="text"
              name="client_name"
              maxLength={80}
              required
              className="input"
            />
          </label>
          <label className="block">
            <span className="label">Stage</span>
            <select name="stage" defaultValue="lead" className="select">
              {STAGES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Follow up on (optional)</span>
            <input type="date" name="follow_up_on" className="input" />
          </label>
          <label className="block sm:col-span-2">
            <span className="label">Note (optional)</span>
            <textarea
              name="note"
              maxLength={1000}
              rows={2}
              className="textarea"
            />
          </label>
          <div className="sm:col-span-2">
            {/* The server action ends in a redirect back here, and Next serves
                that redirected page inside the action's own response - so
                loading.tsx never gets a turn and the screen just sat there,
                unchanged and unresponsive, for as long as the insert plus the
                re-read took. This says "Adding…" for exactly that window, and
                blocks a second tap that would add the client twice. */}
            <SubmitButton className="btn-primary" pendingLabel="Adding…">
              Add client
            </SubmitButton>
          </div>
        </form>
      </section>

      {suggestions.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
              Track from your jobs
            </h2>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              Jobs a homeowner already chose you for. One tap adds them to
              your client list.
            </p>
          </div>
          <ul className="space-y-2">
            {suggestions.map((l) => {
              const suggestedStage = stageForLeadStatus(l.status);
              const suggestedName =
                l.homeowner_name || labelFor(JOB_CATEGORIES, l.category);
              return (
                <li
                  key={l.id}
                  className="card flex items-center justify-between gap-3"
                >
                  <div>
                    <span className="flex items-center gap-2 font-medium text-stone-900 dark:text-stone-100">
                      {suggestedName}
                    </span>
                    <p className="text-xs text-stone-500 dark:text-stone-400">
                      {labelFor(JOB_CATEGORIES, l.category)} ·{" "}
                      {new Date(l.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <form action={trackLeadAction}>
                    <input type="hidden" name="lead_id" value={l.id} />
                    <input
                      type="hidden"
                      name="client_name"
                      value={suggestedName}
                    />
                    <input type="hidden" name="stage" value={suggestedStage} />
                    <SubmitButton
                      className="btn-secondary shrink-0 text-sm"
                      pendingLabel="Tracking…"
                    >
                      Track
                    </SubmitButton>
                  </form>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="space-y-6">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          Your clients{" "}
          <span className="text-stone-500 dark:text-stone-400">({displayClients.length})</span>
        </h2>
        {displayClients.length === 0 ? (
          <p className="rounded-xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
            {q
              ? "No clients match that search."
              : "No clients tracked yet. Add one above, or track a job you were already chosen for."}
          </p>
        ) : (
          STAGES.map((s) => {
            const items = displayClients.filter((c) => c.stage === s.value);
            if (items.length === 0) return null;
            return (
              <div key={s.value} className="space-y-2">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
                  {s.label}{" "}
                  <span className="normal-case text-stone-300 dark:text-stone-600">
                    ({items.length})
                  </span>
                </h3>
                <ul className="space-y-2">
                  {items.map((c) => (
                    <ClientRow
                      key={c.id}
                      client={c}
                      todayStr={todayStr}
                      latestNote={latestNoteByClient.get(c.id) ?? null}
                    />
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </section>

      {/* More with Pro: only the upgrades that really work today. A
          non-member who taps one is sent to /pro/plus to unlock it; a member
          is sent to the real tool (href). Everything still on the roadmap
          lives in the clearly-labeled "What's coming" list below, never
          dressed up as a working feature. */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
              More with Pro{" "}
              <span className="chip ml-1 bg-hearth-100 align-middle text-hearth-800 dark:bg-hearth-900 dark:text-hearth-200">
                Pro
              </span>
            </h2>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              {member
                ? "Included with your membership."
                : "Tap to see how Pro unlocks it."}
            </p>
          </div>
          {/* Leads with the free trial, not the price, and only for a pro who
              will actually get one: /pro/plus is where the full auto-renewal
              disclosure and the actual checkout live, and this button must not
              out-promise it. */}
          {!member && (
            <Link href="/pro/plus" className="btn-primary shrink-0">
              {proSub
                ? "See Hearth Pro"
                : `Try Pro free for ${PRO_PLAN.trialDays} days`}
            </Link>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {PRO_CRM_FEATURES.map((f) => {
            const href = member && f.href ? f.href : "/pro/plus";
            return (
              <Link
                key={f.title}
                href={href}
                className="card group ring-1 ring-transparent transition hover:ring-hearth-300 dark:hover:ring-hearth-400"
              >
                <div className="flex items-center justify-between">
                  <span className="icon-chip">
                    <f.icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  {!member && (
                    <span className="chip bg-hearth-100 text-hearth-800 dark:bg-hearth-900 dark:text-hearth-200">
                      Pro
                    </span>
                  )}
                </div>
                <p className="mt-2 font-semibold text-stone-900 group-hover:text-hearth-800 dark:text-stone-100 dark:group-hover:text-hearth-300">
                  {f.title}
                </p>
                <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">{f.body}</p>
              </Link>
            );
          })}
        </div>

        <div className="rounded-xl border border-dashed border-stone-300 p-4 dark:border-stone-700">
          <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            What&apos;s coming
          </h3>
          <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
            On our roadmap for the CRM. These are planned, not in the app yet,
            so we won&apos;t charge you for them or pretend they work today.
          </p>
          <ul className="mt-2 space-y-1.5">
            {PLANNED_CRM_FEATURES.map((f) => (
              <li
                key={f.label}
                className="flex items-start gap-2 text-sm text-stone-600 dark:text-stone-300"
              >
                <f.icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{f.label}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
