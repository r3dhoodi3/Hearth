import { redirect } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { ClipboardList, ReceiptText, Mail, Lock } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentContractor } from "@/lib/contractor";
import { hasProPlan, getProSubscription } from "@/lib/subscription";
import { PRO_DEPOSIT_BOOST_PTS, COLD_START_FREE_ALERTS } from "@/lib/constants";
import ProUpgradeCta from "@/components/pro/ProUpgradeCta";
import ProToolsClient from "./ProToolsClient";

// AI back office (Hearth Pro membership perk): three writing tools that turn a
// pro's plain-words notes into paperwork they can send: an estimate, an
// invoice, and a follow-up message. Members get the working tools; everyone
// else gets a clear look at what's inside and a path to /pro/plus. Lead access
// is never involved here: this is perks-only surface.

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

export default async function ProToolsPage() {
  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  const member = await hasProPlan();

  if (!member) {
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
            The AI back office is part of the Hearth Pro membership.{" "}
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
  const supabase = createClient();
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
      <ProToolsClient
        initialPastJobs={pastJobRows ?? []}
        categories={contractor.categories ?? []}
        leads={leadRows ?? []}
      />
      <p className="text-center text-xs text-stone-500 dark:text-stone-400">
        Drafts use only the details you type in. Always give them a quick read
        before sending.
      </p>
    </div>
  );
}
