import { redirect } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { ClipboardList, ReceiptText, Mail, Lock } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentContractor, isEstablishedPro } from "@/lib/contractor";
import { hasProPlan, getProSubscription } from "@/lib/subscription";
import { PRO_DEPOSIT_BOOST_PTS, COLD_START_FREE_ALERTS } from "@/lib/constants";
import ProUpgradeCta from "@/components/pro/ProUpgradeCta";
import { PRO_TOOLS_PAYWALL } from "@/lib/freeAiTaste";
import { proDraftsLeft } from "@/lib/freeAiTasteServer";
import ProToolsClient, { type Tool } from "./ProToolsClient";

// AI back office (Hearth Pro membership perk): writing tools that turn a pro's
// plain-words notes into paperwork they can send: an estimate, an invoice, a
// follow-up message, a review response, an overdue reminder.
//
// Every contractor gets FREE_PRO_DRAFTS real drafts first (migration 0145),
// then the wall and a path to /pro/plus. It used to be members-only from the
// first tap, which meant a pro was asked to pay for the idea of a draft with
// nothing to judge it by. Lead access is never involved here: this is
// perks-only surface, and the wall only ever stands between a pro and a DRAFT,
// never between a pro and their own work.

// Prefill data resolved server-side from an owned lead/CRM row (CR5#1). See
// the ownership check where this is built, below.
export type PrefilledLead = {
  category: string | null;
  homeownerFirstName: string | null;
  description: string | null;
  amount: string | null;
};

// Valid ?tool= values, so a link from a lead card or a CRM row can also open
// the right tab (e.g. straight to Invoice) instead of always landing on
// Estimate. Anything else is ignored, same "never trust the URL" spirit as
// the lead ownership check below - just for a tab choice instead of data.
const TOOL_VALUES = new Set([
  "estimate",
  "invoice",
  "followup",
  "review_response",
  "overdue",
]);

const TOOLS: Array<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: ClipboardList,
    title: "Estimate builder",
    body: "Describe the job in your own words and get back a clean written estimate: scope, line items, and terms, ready to send.",
  },
  {
    icon: ReceiptText,
    title: "Invoice writer",
    body: "Turn 'replaced the water heater, $1,450' into professional invoice text with a work summary and payment note.",
  },
  {
    icon: Mail,
    title: "Follow-up writer",
    body: "The message you keep meaning to send: nudge a quiet quote, ask a happy customer for a review, or check in on past work.",
  },
];

export default async function ProToolsPage(
  props: {
    searchParams: Promise<{ lead?: string; tool?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  const member = await hasProPlan();
  // The route refuses an unverified business before it spends anything, so
  // showing that pro a "2 of 2 free drafts left" meter above a locked button
  // promised something they cannot use (post-migration check, 2026-08-30).
  // Locked pros get no meter and no "being switched on" note; the button's
  // own locked reply says how to unlock.
  const established = member || (await isEstablishedPro(contractor.id));
  // How many free drafts are left, for the meter. Null for a member.
  const draftsLeft = established
    ? await proDraftsLeft(contractor.id, member)
    : null;

  // Out of free drafts and not a member: the pitch, led by the exact sentence
  // the route would have sent. Anyone with drafts still on the meter falls
  // through to the working tools below, member or not.
  if (!member && draftsLeft !== null && draftsLeft <= 0) {
    // The free trial is for first-time members only, and the pro-side
    // subscriptions row survives a cancellation, so a lapsed member gets the
    // plain "See Hearth Pro" button instead of a trial they cannot have.
    // Request-cached: hasProPlan() above already read the same rows.
    const trialEligible = !(await getProSubscription());

    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            AI back office
          </h1>
          <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
            The paperwork side of the job, handled in seconds instead of
            evenings.
          </p>
        </div>

        <div className="rounded-xl border border-hearth-200 bg-hearth-50 p-4 text-center ring-1 ring-hearth-200 dark:border-hearth-800 dark:bg-hearth-900/40 dark:ring-hearth-800">
          <div className="mb-2 flex justify-center">
            <span aria-hidden="true" className="icon-chip">
              <Lock className="h-5 w-5" />
            </span>
          </div>
          <p className="text-sm font-medium text-hearth-800 dark:text-hearth-200">
            Pro membership tool
          </p>
          <p className="mt-1 text-sm text-hearth-700 dark:text-hearth-300">
            {/* The same sentence /api/pro-tools sends on a 402, so the screen
                never says something the server would not have. */}
            {PRO_TOOLS_PAYWALL.message}{" "}
            {/* The real membership unlock here is the three tools. Two things
                must stay honest: instant alerts are free for every pro while
                COLD_START_FREE_ALERTS is on, so we don't sell them as a
                membership unlock (mirrors /pros and /pro/business); and the
                deposit match is the one perk that does NOT start during the
                free trial, so the trial line never promises it early. */}
            {trialEligible
              ? `Start your free trial to unlock all three tools.${
                  COLD_START_FREE_ALERTS
                    ? " Instant job alerts are already free for every pro while Hearth is new."
                    : " You also get instant job alerts."
                } Your +${PRO_DEPOSIT_BOOST_PTS}% deposit match starts when the trial converts.`
              : `Join to unlock all three tools.${
                  COLD_START_FREE_ALERTS
                    ? " Instant job alerts are already free for every pro while Hearth is new."
                    : " You also get instant job alerts."
                } Members earn +${PRO_DEPOSIT_BOOST_PTS}% on every deposit.`}
          </p>
          <ProUpgradeCta
            trialEligible={trialEligible}
            className="btn-primary mt-3 inline-block"
            sublineClassName="mt-2 text-xs text-hearth-700 dark:text-hearth-300"
          />
        </div>

        <section className="grid gap-4 sm:grid-cols-1">
          {TOOLS.map((t) => (
            <div key={t.title} className="card">
              <div className="flex items-start gap-3">
                <div className="icon-chip">
                  <t.icon className="h-5 w-5" aria-hidden="true" />
                </div>
                <div>
                  <h2 className="font-semibold text-stone-900 dark:text-stone-100">
                    {t.title}{" "}
                    <span className="chip ml-1 inline-flex items-center gap-1 border border-stone-200 bg-stone-50 text-stone-500 dark:border-white/10 dark:bg-stone-800 dark:text-stone-400">
                      <Lock className="h-3 w-3" aria-hidden="true" /> Members
                    </span>
                  </h2>
                  <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">{t.body}</p>
                </div>
              </div>
            </div>
          ))}
        </section>

        <p className="text-center text-xs text-stone-500 dark:text-stone-400">
          Membership never changes which jobs you can see or apply to. Leads
          stay pay-per-apply for everyone.
        </p>
      </div>
    );
  }

  // The estimate tool's "your past jobs" section, fed by uploads to
  // /api/pro-past-jobs. Fetched here (server side) and handed to the client
  // component as its starting list; ProToolsClient keeps its own copy in
  // state so an upload or a remove updates the screen immediately.
  const supabase = await createClient();
  const { data: pastJobRows } = await supabase
    .from("pro_past_jobs")
    .select("*")
    .eq("contractor_id", contractor.id)
    .order("created_at", { ascending: false });

  // This pro's own leads, for the "Send to a lead" picker on a generated
  // draft. Only "lost" (declined) leads are excluded: a "closed" (won) lead
  // still has a live chat thread, and is exactly where an invoice or an
  // overdue-payment reminder is most likely to be sent. Most-recent first.
  const { data: leadRows } = await supabase
    .from("contractor_leads")
    .select("id, homeowner_name, category, status, created_at")
    .eq("contractor_id", contractor.id)
    .neq("status", "lost")
    .order("created_at", { ascending: false });

  // Prefill from the lead a tool link was opened with (?lead=<id>, added to
  // the lead card and the CRM row). The id is client input off the URL, so it
  // never gets trusted on its own: both reads below filter on
  // contractor_id = contractor.id, the same ownership check
  // sendDraftToLeadAction (./actions.ts) already uses for this table. A
  // lead id that isn't this contractor's own - typed in, guessed, or copied
  // from another tab - just prefills nothing, no error shown.
  const leadParam =
    typeof searchParams.lead === "string" ? searchParams.lead.trim() : "";
  let initialLead: PrefilledLead | null = null;
  if (leadParam) {
    const [{ data: ownedLead }, { data: trackedClient }] = await Promise.all([
      supabase
        .from("contractor_leads")
        .select("id, category, homeowner_name, issue_description")
        .eq("id", leadParam)
        .eq("contractor_id", contractor.id)
        .maybeSingle(),
      // est_value_cents is the pro's OWN estimate of the job's worth, typed
      // in on the CRM. contractor_leads.payout_amount is deliberately never
      // used here even though it looks like "the amount": it is what the pro
      // pays HEARTH for the lead (see the NOTE in src/lib/proStats.ts), not
      // what the homeowner owes them, and prefilling an invoice with it
      // would quote a pro's own lead fee back to their customer.
      supabase
        .from("pro_clients")
        .select("est_value_cents")
        .eq("lead_id", leadParam)
        .eq("contractor_id", contractor.id)
        .maybeSingle(),
    ]);
    if (ownedLead) {
      const firstName = (ownedLead.homeowner_name || "").trim().split(/\s+/)[0];
      initialLead = {
        category: ownedLead.category ?? null,
        homeownerFirstName: firstName || null,
        description: ownedLead.issue_description ?? null,
        amount:
          trackedClient?.est_value_cents != null
            ? `$${Math.round(trackedClient.est_value_cents / 100).toLocaleString("en-US")}`
            : null,
      };
    }
  }
  const initialTool: Tool | null =
    typeof searchParams.tool === "string" &&
    TOOL_VALUES.has(searchParams.tool)
      ? (searchParams.tool as Tool)
      : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          AI back office
        </h1>
        <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
          Tell it about the job in plain words. It writes the paperwork, you
          look it over and send it.
        </p>
      </div>
      {/* Migration 0145 not on this database yet: proDraftsLeft is null for a
          non-member, and the route will answer 503 "being switched on". Say it
          here so nobody types a whole job description first (live check L3). */}
      {!member && established && draftsLeft === null && (
        <p className="rounded-lg bg-stone-50 p-3 text-sm text-stone-700 dark:bg-stone-800 dark:text-stone-300">
          Drafting is being switched on for your account. Check back later today.
        </p>
      )}

      <ProToolsClient
        initialPastJobs={pastJobRows ?? []}
        categories={contractor.categories ?? []}
        leads={leadRows ?? []}
        initialDraftsLeft={draftsLeft}
        initialLead={initialLead}
        initialTool={initialTool}
      />
      <p className="text-center text-xs text-stone-500 dark:text-stone-400">
        Drafts use only the details you type in. Always give them a quick read
        before sending.
      </p>
    </div>
  );
}
