import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentContractor } from "@/lib/contractor";
import { proGreeting } from "@/lib/proGreeting";
import AskHearth from "@/components/AskHearth";

// The opening line reflects leads that change under other people's hands, so
// it is never cached, at any layer.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Ask Hearth for Pros" };

// The full-screen pro copilot, and the destination of the "Ask" tab in the
// phone bottom nav (see ProNav.tsx). The floating dock is a desktop affordance
// now, so on a phone this page IS the copilot: same component, same endpoint,
// same stored conversation (AskHearth namespaces its history by user id, not
// by screen), just given the whole viewport instead of a 22rem card.
//
// `?q=` prefills and sends one question, mirroring the homeowner /ask page, so
// an inline "ask about this" link can reach the copilot on a phone where the
// dock is not on screen.
export default async function ProAskPage(props: {
  searchParams: Promise<{ q?: string }>;
}) {
  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  const [{ q }, greeting] = await Promise.all([
    props.searchParams,
    proGreeting(contractor.name),
  ]);

  return (
    <div>
      {/* The chat pane carries its own visible heading, so a second one on top
          would be the same words twice and 3rem less conversation on a phone.
          The h1 stays for structure and screen readers. */}
      <h1 className="sr-only">Ask Hearth for Pros</h1>
      {/* Same frame the homeowner /ask page uses, so the two sides look like
          one feature. dvh on phones so collapsing browser chrome can't leave
          the composer under the fold. */}
      <div className="flex h-[calc(100dvh-12rem)] flex-col rounded-xl border border-stone-200 bg-white p-3 sm:h-[calc(100vh-12rem)] dark:border-white/10 dark:bg-stone-800">
        <div className="min-h-0 flex-1">
          {/* The endpoint and storage keys are the pro copilot's, matching the
              dock in pro/layout.tsx exactly: one brain, one saved
              conversation, two ways in. replaceUrlAfterInitial drops the ?q=
              once the question has been handled, so a reload or a Back into
              this page doesn't ask it a second time. */}
          <AskHearth
            fill
            greeting={greeting}
            initialQuestion={q}
            replaceUrlAfterInitial="/pro/ask"
            endpoint="/api/pro-ask"
            storageKeyBase="hearth_pro_ask_chat"
            retentionKeyBase="hearth_pro_ask_retention"
            headingTitle="Ask Hearth for Pros"
            headingSubtitle="Your business copilot"
          />
        </div>
      </div>
    </div>
  );
}
