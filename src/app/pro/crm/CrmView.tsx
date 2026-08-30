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

import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Bot, Clock, Star, FileText, Tag, BarChart3 } from "lucide-react";
import SubmitButton from "@/components/SubmitButton";
import ClientRow, { type ProClientRow } from "./ClientRow";
import { addClientAction, trackLeadAction } from "./actions";
import { reviewAskMessage } from "./reviewAskMessage";
import { PRO_PLAN } from "@/lib/constants";
import {
  readComposeDraft,
  saveComposeDraftDebounced,
  clearComposeDraft,
} from "@/lib/proComposeDraft";

// CR4#4: a copy-paste "ask for a review" text, offered on every Won client
// with a linked job. This is the MANUAL fallback every pro can use (member
// or not) - separate from the automated in-app request Pro members already
// get on the Won transition (see PRO_CRM_FEATURES's "Automated review
// requests" card above, requestReviewForWonLead in src/lib/reviewRequest.ts).
// Never auto-sent: the pro's own phone does the sending, Hearth only builds
// the text. The link reuses the exact same /contractors?review=<leadId>
// path the automated request notifies with, so either path lands the
// homeowner on the same review row. Message-building itself lives in
// ./reviewAskMessage.ts (see that file for why: this module imports
// "./actions", which is unsafe to import outside a real server render).
function WonReviewAsk({
  clientName,
  leadId,
}: {
  clientName: string;
  leadId: string;
}) {
  const [copied, setCopied] = useState(false);
  // window is undefined during this client component's SSR pass - same
  // guard ReviewButton.tsx's and InviteNeighbor.tsx's own inviteUrl() use,
  // so the preview text and the copied text are always the same string.
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const message = reviewAskMessage(clientName, leadId, origin);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permissions, insecure origin): the text is
      // already shown on screen to select by hand, so nothing else to do.
    }
  }

  return (
    <li className="card space-y-2 border-dashed">
      <p className="text-xs font-medium text-stone-500 dark:text-stone-400">
        Ask {clientName} for a review
      </p>
      <p className="text-sm text-stone-600 dark:text-stone-300">{message}</p>
      <button type="button" onClick={handleCopy} className="btn-secondary text-sm">
        {copied ? "Copied" : "Copy"}
      </button>
    </li>
  );
}

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
  // CR5#7: the manual form starts collapsed behind an "Add someone else"
  // button whenever there is a one-tap suggestion to try first - typing a
  // name Hearth already knows from a job is the more effortful path, so it
  // no longer leads. With no suggestions (the common single-client case)
  // the form is just there, exactly as before.
  const [showAddForm, setShowAddForm] = useState(() => suggestions.length === 0);

  // CR5#4 autosave for the Add-a-client note: job sites have bad cell
  // coverage, and this field is a plain uncontrolled textarea (see the form
  // below, keyed on addedClientCount so a successful add blanks it) so the
  // draft is restored imperatively via the ref rather than through React
  // state. Restores whenever the form becomes visible with nothing already
  // typed into it; clears once addedClientCount actually goes up, which only
  // happens after a real, saved client - never on a Track tap for a
  // suggestion, which posts its own hidden fields and does not touch this
  // form's key.
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const prevAddedCountRef = useRef(addedClientCount);
  useEffect(() => {
    if (addedClientCount > prevAddedCountRef.current) {
      clearComposeDraft("crm_note", "add-client");
      prevAddedCountRef.current = addedClientCount;
      return;
    }
    prevAddedCountRef.current = addedClientCount;
    if (!showAddForm) return;
    const draft = readComposeDraft("crm_note", "add-client");
    if (draft && noteRef.current && !noteRef.current.value) {
      noteRef.current.value = draft;
    }
  }, [addedClientCount, showAddForm]);

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

      {/* CR5#7: suggestions from jobs Hearth already knows about come first,
          above the manual form - one tap beats retyping a name. */}
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
                <div className="flex shrink-0 items-center gap-2">
                  {/* CR5#1: the tools link from a lead/CRM row. Ownership is
                      re-checked server side in src/app/pro/tools/page.tsx
                      before anything is prefilled - this id is just client
                      input off the URL. */}
                  <Link
                    href={`/pro/tools?lead=${l.id}`}
                    className="btn-secondary text-sm"
                  >
                    Estimate
                  </Link>
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
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          Add a client
        </h2>
        {/* Collapsed behind a button once there is a suggestion to try
            first (CR5#7); with none, the form is just here as before. */}
        {suggestions.length > 0 && !showAddForm ? (
          <button
            type="button"
            onClick={() => setShowAddForm(true)}
            className="btn-secondary"
          >
            Add someone else
          </button>
        ) : (
          /* Keyed on addedClientCount, not clients.length: a successful add
             changes that number, so React remounts the form with blank
             uncontrolled inputs instead of leaving the just-submitted name and
             note sitting in the fields. A validation error (see ./actions.ts's
             addClientAction) leaves the count untouched, so the key stays put
             and whatever the pro typed is still there to fix and resubmit.
             Keying on the plain client count instead used to also remount (and
             blank) this form when a Track tap on a suggested job above added a
             client of its own - a half-typed name here would vanish on a tap
             that had nothing to do with this form. */
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
              {/* CR5#4 autosave: an uncontrolled field, so the draft is
                  restored onto the DOM node itself (the effect above) rather
                  than through a value prop - keeps the form's "blank on a
                  real add, keep it on a validation error" behavior exactly
                  as the comment above describes. */}
              <textarea
                ref={noteRef}
                name="note"
                maxLength={1000}
                rows={2}
                className="textarea"
                onChange={(e) =>
                  saveComposeDraftDebounced("crm_note", "add-client", e.target.value)
                }
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
        )}
      </section>

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
                  <Fragment key={c.client.id}>
                    <ClientRow
                      client={c.client}
                      todayStr={todayStr}
                      latestNote={c.latestNote}
                    />
                    {/* Won-stage review template (CR4#4): only when the
                        client is a real, linked job - a manually added
                        client with no lead_id has no review row to point
                        the link at. */}
                    {g.value === "won" && c.client.lead_id && (
                      <WonReviewAsk
                        clientName={c.client.client_name}
                        leadId={c.client.lead_id}
                      />
                    )}
                  </Fragment>
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
