"use client";

// STREAMING FIX, not a behaviour change. Same treatment as
// src/app/pro/chats/ChatsView.tsx and src/app/pro/leads/LeadsBoard.tsx,
// investigated in scratchpad/debug-DBG3.md.
//
// React Flight defers any element it meets once the row it is serializing has
// passed a 3200-byte budget: it writes "$L<id>" in place and starts a fresh
// row for that element. Fizz then streams each of those rows as an
// out-of-order segment - a <template id="P:n"> hole nested inside the page's
// own markup plus a late $RS(...) script to fill it - and that hole chain is
// the shape that comes with the React #418 / "$RS ... parentNode" hydration
// failure reported on the pro pages.
//
// /pro/crm measured 11 deferrals on the page row, 4 nested holes and 5 $RS
// scripts for a pro with real jobs: the stage tiles, the client cards, the
// "Track from your jobs" rows and the Pro teaser cards are all lists, and each
// item past the budget was another deferral.
//
// As one client module the whole page body becomes a SINGLE client reference
// carrying plain data, so there is no element left in that row to defer. The
// two server actions (addClientAction, trackLeadAction) are imported straight
// from the "use server" module, which a client component may do - that keeps
// them out of the props entirely rather than adding two more serialized
// references to the row.
//
// Nothing here is newly interactive, and nothing is newly computed on the
// client: the follow-up dates and the "tracked on" line read the clock and the
// locale, so they are still resolved on the server and arrive as strings.

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Bot, Clock, Star, FileText, Tag, BarChart3 } from "lucide-react";
import SubmitButton from "@/components/SubmitButton";
import ClientRow, { type ProClientRow } from "./ClientRow";
import { addClientAction, trackLeadAction } from "./actions";
import { PRO_PLAN } from "@/lib/constants";

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

// One stage tile: the count and the estimated total, already formatted.
export type StageTileVM = {
  value: string;
  label: string;
  count: number;
  totalLabel: string;
};

// One client card plus the latest note the server already looked up.
export type ClientCardVM = {
  client: ProClientRow;
  latestNote: string | null;
};

// One "Track from your jobs" suggestion. metaLine carries the category and the
// locale-formatted date, resolved on the server so hydration cannot disagree
// with SSR about either.
export type SuggestionVM = {
  id: string;
  name: string;
  metaLine: string;
  stage: string;
};

// The grouped "Your clients" list, pre-grouped by stage on the server.
export type ClientGroupVM = {
  value: string;
  label: string;
  items: ClientCardVM[];
};

export default function CrmView({
  q,
  stageTiles,
  stageOptions,
  addedClientCount,
  todayStr,
  dueForFollowUp,
  suggestions,
  displayCount,
  groups,
  member,
  hasProSubscriptionRow,
}: {
  q: string;
  stageTiles: StageTileVM[];
  /** The four pipeline stages, for the Add-a-client picker. One source of
      truth, kept on the server side (STAGES in page.tsx) rather than copied
      here, because a server component cannot import a plain value back out of
      a "use client" module. */
  stageOptions: { value: string; label: string }[];
  /** Remount key for the Add-a-client form. See the comment beside it. */
  addedClientCount: number;
  todayStr: string;
  dueForFollowUp: ClientCardVM[];
  suggestions: SuggestionVM[];
  displayCount: number;
  groups: ClientGroupVM[];
  member: boolean;
  /** True when a pro-side subscriptions row exists, so no trial is offered. */
  hasProSubscriptionRow: boolean;
}) {
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Clients</h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Your pipeline: everyone you&apos;re doing business with, each with a
          stage, a value, contact info, and notes.
        </p>
      </div>

      <section className="grid gap-4 sm:grid-cols-4">
        {stageTiles.map((s) => (
          <div key={s.value} className="card">
            <p className="stat-label">{s.label}</p>
            <p className="stat-number mt-1 text-2xl">
              {s.count}
            </p>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              {s.totalLabel} estimated
            </p>
          </div>
        ))}
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
                key={c.client.id}
                client={c.client}
                todayStr={todayStr}
                latestNote={c.latestNote}
              />
            ))}
          </ul>
        </section>
      )}

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          Add a client
        </h2>
        {/* Keyed on addedClientCount, not clients.length: a successful add
            changes that number, so React remounts the form with blank
            uncontrolled inputs instead of leaving the just-submitted name and
            note sitting in the fields. A validation error (see ./actions.ts's
            addClientAction) leaves the count untouched, so the key stays put
            and whatever the pro typed is still there to fix and resubmit.
            Keying on the plain client count instead used to also remount (and
            blank) this form when a Track tap on a suggested job below added a
            client of its own - a half-typed name here would vanish on a tap
            that had nothing to do with this form. */}
        <form
          key={addedClientCount}
          action={addClientAction}
          className="grid gap-3 sm:grid-cols-2"
        >
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
              {stageOptions.map((s) => (
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
            {suggestions.map((l) => (
              <li
                key={l.id}
                className="card flex items-center justify-between gap-3"
              >
                <div>
                  <span className="flex items-center gap-2 font-medium text-stone-900 dark:text-stone-100">
                    {l.name}
                  </span>
                  <p className="text-xs text-stone-500 dark:text-stone-400">
                    {l.metaLine}
                  </p>
                </div>
                <form action={trackLeadAction}>
                  <input type="hidden" name="lead_id" value={l.id} />
                  <input type="hidden" name="client_name" value={l.name} />
                  <input type="hidden" name="stage" value={l.stage} />
                  <SubmitButton
                    className="btn-secondary shrink-0 text-sm"
                    pendingLabel="Tracking…"
                  >
                    Track
                  </SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-6">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          Your clients{" "}
          <span className="text-stone-500 dark:text-stone-400">({displayCount})</span>
        </h2>
        {displayCount === 0 ? (
          <p className="rounded-xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
            {q
              ? "No clients match that search."
              : "No clients tracked yet. Add one above, or track a job you were already chosen for."}
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.value} className="space-y-2">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
                {g.label}{" "}
                <span className="normal-case text-stone-300 dark:text-stone-600">
                  ({g.items.length})
                </span>
              </h3>
              <ul className="space-y-2">
                {g.items.map((c) => (
                  <ClientRow
                    key={c.client.id}
                    client={c.client}
                    todayStr={todayStr}
                    latestNote={c.latestNote}
                  />
                ))}
              </ul>
            </div>
          ))
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
              {hasProSubscriptionRow
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
    </>
  );
}
