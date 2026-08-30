import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentContractor, isEstablishedPro } from "@/lib/contractor";
import { proGreeting } from "@/lib/proGreeting";
import AskHearth from "@/components/AskHearth";
import PhoneChatFrame from "@/components/PhoneChatFrame";

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

  const [{ q }, greeting, established] = await Promise.all([
    props.searchParams,
    proGreeting(contractor.name),
    // The same helper /api/pro-ask asks (src/lib/contractor.ts). Read here so a
    // pro whose business is not verified yet never gets a composer to type
    // into: the route would only refuse them, and a dead box is a worse answer
    // than a sentence saying how to open it.
    isEstablishedPro(contractor.id),
  ]);

  return (
    <div>
      {/* The chat pane carries its own visible heading, so a second one on top
          would be the same words twice and 3rem less conversation on a phone.
          The h1 stays for structure and screen readers. */}
      <h1 className="sr-only">Ask Hearth for Pros</h1>
      {/* Same frame the homeowner /ask page uses, so the two sides look like
          one feature. The sm: height is the desktop box, unchanged; below sm
          PhoneChatFrame pins the panel between the header and the keyboard
          (see .hearth-chat-frame in globals.css) so the composer stays on
          screen while you type. */}
      <PhoneChatFrame className="flex h-[calc(100dvh-14rem)] flex-col rounded-xl border border-stone-200 bg-white p-3 sm:h-[calc(100vh-12rem)] dark:border-white/10 dark:bg-stone-800">
        {/* Phone-only way back, mirroring the homeowner /ask page. This screen
            is opened from the pinned copilot row at the top of /pro/chats and
            the bottom bar keeps Messages lit while you're here, so the trip
            back is one tap. Inside the panel because on a phone the panel
            covers everything under the header; hidden on desktop, as before. */}
        <Link
          href="/pro/chats"
          // Already sm:hidden, so these sizes are phone-only: 44px tall
          // and 16px, matching the homeowner /ask back link.
          className="mb-2 -ml-2 inline-flex min-h-11 w-fit shrink-0 items-center gap-1 px-2 text-base font-medium text-hearth-700 hover:underline sm:hidden dark:text-hearth-300"
        >
          <span aria-hidden="true">←</span> All conversations
        </Link>
        <div className="min-h-0 flex-1">
          {!established ? (
            // Locked: the same words the route answers with, so the two can
            // never say different things. No composer, because there is
            // nothing to send yet.
            <div
              data-testid="pro-ask-locked"
              className="flex h-full flex-col justify-center gap-3 px-2 text-sm text-stone-700 dark:text-stone-300"
            >
              <p className="font-medium text-stone-900 dark:text-stone-100">
                Ask Hearth opens once your business is verified
              </p>
              <p className="leading-relaxed">
                Add a California license number we can confirm, or place your
                first lead. Hearth Pro members get it right away.
              </p>
              <p className="flex flex-wrap gap-4">
                <Link
                  href="/pro/profile"
                  className="font-medium text-hearth-700 hover:underline dark:text-hearth-300"
                >
                  Add your license
                </Link>
                <Link
                  // ?reason=ask so /pro/plus opens on the Ask pitch rather
                  // than the general page: the pro tapped THIS door.
                  href="/pro/plus?reason=ask"
                  className="font-medium text-hearth-700 hover:underline dark:text-hearth-300"
                >
                  See Hearth Pro
                </Link>
              </p>
            </div>
          ) : (
          /* The endpoint and storage keys are the pro copilot's, matching the
              dock in pro/layout.tsx exactly: one brain, one saved
              conversation, two ways in. replaceUrlAfterInitial drops the ?q=
              once the question has been handled, so a reload or a Back into
              this page doesn't ask it a second time. */
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
          )}
        </div>
      </PhoneChatFrame>
    </div>
  );
}
