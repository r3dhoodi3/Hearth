import type { Metadata } from "next";
import { getProactiveGreeting } from "@/lib/greeting";
import AskHearth from "@/components/AskHearth";

// The greeting is per-user, per-home, and reflects issues and tasks that
// change under the user's own hands. Never cached, at any layer.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Ask Hearth" };

// The full-screen Ask Hearth conversation, and the destination of the "Ask"
// tab in the phone bottom nav (see Nav.tsx). The floating dock is a desktop
// affordance now, so on a phone this page IS Ask Hearth: same component, same
// stored conversation (AskHearth namespaces its history by user id, not by
// screen), just given the whole viewport instead of a 22rem card.
//
// `?q=` prefills and sends one question, which is how an inline "ask about
// this" link elsewhere in the app reaches the assistant on a phone: the dock
// is hidden there, so it forwards the question here instead of answering into
// an invisible panel.
export default async function AskPage(props: {
  searchParams: Promise<{ q?: string }>;
}) {
  const [{ q }, greeting] = await Promise.all([
    props.searchParams,
    getProactiveGreeting(),
  ]);

  return (
    <div>
      {/* The chat pane carries its own visible "Ask Hearth" heading, so a
          second one on top would just be the same words twice and 3rem less
          conversation on a phone. The h1 stays for structure and screen
          readers. */}
      <h1 className="sr-only">Ask Hearth</h1>
      {/* Same frame the Messages screen puts its Ask Hearth pane in, so the
          two entry points look like one feature. dvh on phones so the browser
          chrome collapsing doesn't leave the composer under the fold. */}
      <div className="flex h-[calc(100dvh-12rem)] flex-col rounded-xl border border-stone-200 bg-white p-3 dark:border-white/10 dark:bg-stone-800 sm:h-[calc(100vh-12rem)]">
        <div className="min-h-0 flex-1">
          {/* replaceUrlAfterInitial drops the ?q= from the address bar once
              the question has been handled, so a reload or a Back into this
              page does not ask it a second time (and spend a second free
              question on an answer already on screen). */}
          <AskHearth
            fill
            greeting={greeting}
            initialQuestion={q}
            replaceUrlAfterInitial="/ask"
          />
        </div>
      </div>
    </div>
  );
}
