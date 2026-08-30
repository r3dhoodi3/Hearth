import type { Metadata } from "next";
import Link from "next/link";
import { getProactiveGreeting } from "@/lib/greeting";
import AskHearth from "@/components/AskHearth";
import PhoneChatFrame from "@/components/PhoneChatFrame";

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
          two entry points look like one feature. The sm: height is the desktop
          box, unchanged; below sm PhoneChatFrame takes over and pins the panel
          between the header and the keyboard (see .hearth-chat-frame in
          globals.css), which is what keeps the composer on screen while you
          type. */}
      <PhoneChatFrame className="flex h-[calc(100dvh-14rem)] flex-col rounded-xl border border-stone-200 bg-white p-3 dark:border-white/10 dark:bg-stone-800 sm:h-[calc(100vh-12rem)]">
        {/* Phone-only way back. This screen is opened from the pinned Ask
            Hearth row at the top of Messages, and the bottom bar shows
            Messages as the active tab while you're here, so the trip back has
            to be one tap - the same "All conversations" link every open thread
            in /chats carries. It sits INSIDE the panel because on a phone the
            panel covers everything under the header. Desktop hides it, exactly
            as before. */}
        <Link
          href="/chats"
          // Already sm:hidden, so these sizes are phone-only: 20px tall was
          // below the touch floor for the only way back.
          className="mb-2 -ml-2 inline-flex min-h-11 w-fit shrink-0 items-center gap-1 px-2 text-base font-medium text-bark-700 hover:underline sm:hidden dark:text-stone-300"
        >
          <span aria-hidden="true">←</span> All conversations
        </Link>
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
      </PhoneChatFrame>
    </div>
  );
}
