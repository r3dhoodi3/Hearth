import { redirect } from "next/navigation";
import { getCurrentContractor } from "@/lib/contractor";
import { getUser } from "@/lib/auth";
import { hasProPlan, getProSubscription } from "@/lib/subscription";
import { variantForUser } from "@/lib/paywallExperiment";
import { readFeedbackState } from "@/lib/proFeedbackServer";
// The body is one client component. That is a streaming fix, not a behaviour
// change: as server markup this page's Flight row carried four deferrals past
// the 3200-byte budget (the "Blocked accounts" link and the whole tail of the
// page). See the long comment at the top of HelpView.tsx.
import HelpView from "./HelpView";

// Support for pros. Every contractor can reach the team from here; messages
// from active Pro members are flagged priority so they get answered first.
// Support itself is never gated: only the place in line is a membership perk.
export default async function ProHelpPage(props: {
  searchParams?: Promise<{ sent?: string }>;
}) {
  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  const member = await hasProPlan();
  // Only for the support form's email fallback when the company record has no
  // contact email of its own. Request-cached, so it costs nothing extra.
  const user = await getUser();
  // Trial-first wording only for a pro who will really get the trial: the
  // pro-side subscriptions row outlives a cancellation, so a lapsed member
  // sees the plain membership line. Request-cached, same rows hasProPlan read.
  // The paywall experiment's "hard" arm takes the same trial-less copy branch
  // (src/lib/paywallExperiment.ts).
  const trialEligible =
    !member &&
    !(await getProSubscription()) &&
    variantForUser(contractor.user_id ?? null) === "soft";
  // Whether the one-time $5 has been collected: the bug-report card swaps its
  // headline once it has, so the credit is never offered twice. Two indexed
  // reads; fails soft to "not claimed", which only ever means the offer copy
  // shows again and the grant itself refuses a second time.
  const { claimed: feedbackClaimed } = await readFeedbackState(
    contractor.id,
    contractor.user_id ?? ""
  );
  // Set by sendProSupportMessageAction's post-success redirect (./actions.ts)
  // so ProSupportForm can swap itself for a confirmation card instead of the
  // plain form on the reload.
  const searchParams = await props.searchParams;
  const sent = searchParams?.sent === "1";

  return (
    <HelpView
      member={member}
      trialEligible={trialEligible}
      feedbackClaimed={feedbackClaimed}
      name={contractor.owner_name || contractor.name || ""}
      email={contractor.contact_email || user?.email || ""}
      phone={contractor.contact_phone || ""}
      sent={sent}
    />
  );
}
