import { Suspense } from "react";
import Link from "next/link";
import { getCurrentContractor, getSides } from "@/lib/contractor";
import Logo from "@/components/Logo";
import ProNav from "@/components/ProNav";
import NewMessageNotifier from "@/components/NewMessageNotifier";
import AppGuideMount from "@/components/AppGuideMount";

// Pro shell. Auth is enforced by middleware; company-setup is enforced per-page
// (so /pro/onboarding itself doesn't get caught in a redirect loop).
export default async function ProLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // A company row is what makes this shell yours, and nothing else. No role
  // check: user_metadata.role is only the side an account LANDS on, and an
  // account can hold both sides at once, so bouncing a "homeowner" out of here
  // would lock a homeowner who is also a pro out of his own company. Someone
  // with no company row gets the bare shell below (and each page inside sends
  // them to /pro/onboarding), which is the same door they had before.
  //
  // getSides() only feeds the profile menu's "Switch to your home" vs "Add
  // your home" item; it shares getCurrentContractor()'s per-request cache, so
  // the pair costs one company query plus one home count.
  const [contractor, sides] = await Promise.all([
    getCurrentContractor(),
    getSides(),
  ]);

  // No company yet → the user is still onboarding. Show a bare top bar with no
  // app links, so they can't navigate into pages that assume a set-up company
  // exists. Sign-out stays: without it, an account stuck at company setup had
  // no way out of this shell at all (same trap the homeowner /onboarding page
  // had before its escape hatch).
  if (!contractor) {
    return (
      <div className="min-h-screen">
        <header className="border-b border-stone-200 bg-white dark:border-white/10 dark:bg-stone-900">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
            <span className="flex items-center gap-2 text-lg font-semibold text-stone-900 dark:text-stone-100">
              <Logo className="h-6 w-6 text-hearth-700 dark:text-hearth-400" />
              <span>
                Hearth{" "}
                <span className="font-normal text-stone-500 dark:text-stone-400">for Pros</span>
              </span>
            </span>
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                className="text-sm text-stone-500 underline hover:text-stone-700 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-stone-400 dark:hover:text-stone-200"
              >
                Sign out
              </button>
            </form>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <ProNav company={contractor.name} hasHome={sides.hasHome} />
      {/* Extra bottom padding on phones keeps content clear of the fixed
          bottom tab bar. */}
      <main className="mx-auto max-w-5xl px-6 pb-24 pt-8 sm:pb-8">
        {children}
      </main>
      {/* The footer sits outside <main>, so main's pb-24 does not cover it and
          on phones "Need a hand? Help" landed under the fixed bottom tab bar
          (3.5rem of content plus the safe-area inset, see ProNav's nav
          classes). Clear the bar plus a 1rem gap, phones only: the bar is
          sm:hidden, so sm and up keep exactly today's pb-8. */}
      <footer className="mx-auto max-w-5xl px-6 pb-8 text-center text-xs text-stone-500 max-sm:pb-[calc(3.5rem_+_env(safe-area-inset-bottom)_+_1rem)] dark:text-stone-400">
        Need a hand?{" "}
        <Link
          href="/pro/help"
          className="underline hover:text-stone-600 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:py-2 dark:hover:text-stone-300"
        >
          Help
        </Link>
      </footer>
      {/* The floating copilot dock used to mount here on every pro screen. It
          is gone on purpose: the copilot lives in Messages now (the pinned Ask
          Hearth row at the top of /pro/chats, and /pro/ask behind it), so a
          pill floating over every other page was a second door to the same
          room - and on a phone it landed on top of the content. */}
      <NewMessageNotifier role="contractor" />
      {/* First sign-in only, the pro set of cards. Inside this branch on
          purpose: the bare no-company shell above is somebody still setting up
          their business, and a tour of leads and reviews there would be a
          takeover in the middle of onboarding. Renders null once the account
          has been through it. See src/lib/appGuide.ts.
          Behind Suspense like the dock above: its one users-row read is not on
          the path to anything visible, so it must not hold up the shell. (The
          homeowner layout needs no boundary - it already awaits
          getUserProfile() at the top, so the same call there is a
          request-cache hit.) */}
      <Suspense fallback={null}>
        <AppGuideMount side="pro" />
      </Suspense>
    </div>
  );
}
