import Link from "next/link";
import { getCurrentContractor, getSides, isEstablishedPro } from "@/lib/contractor";
import { hasProPlan } from "@/lib/subscription";
import { proDraftsLeft } from "@/lib/freeAiTasteServer";
import { getUserProfile } from "@/lib/user";
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
  //
  // getUserProfile() rides along in the same Promise.all so it costs no extra
  // wall time, and so AppGuideMount below - which reads it - is a request-cache
  // hit rather than a fresh await. That is what lets the guide mount WITHOUT a
  // Suspense boundary; see the comment at its mount point for why the boundary
  // had to go.
  //
  // .catch here, not because the value is used (it is not - this call exists to
  // warm the per-request cache), but because that read CAN throw on a database
  // that has not had migration 0137 applied yet. AppGuideMount has always
  // swallowed that itself and fallen back to the localStorage mirror; an
  // unguarded await in the layout would have turned the same failure into a 500
  // for the whole pro shell, which is exactly the regression the Suspense
  // boundary used to hide.
  const [contractor, sides] = await Promise.all([
    getCurrentContractor(),
    getSides(),
    getUserProfile().catch(() => null),
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

  // Where the header's "Back office" button sends a tap. Mirrors the exact
  // rule the owner asked for: a member always gets in, and so does an
  // established non-member who still has free drafts on the meter
  // (mirrors /pro/tools' own paywall condition, see that page's comments);
  // everyone else goes straight to the pitch instead of tapping into
  // /pro/tools only to hit a locked reply there. draftsLeft === null covers
  // both "member" (no meter) and "counter unreadable" - the latter fails
  // open here the same way isEstablishedPro does, so an outage never looks
  // like a sale.
  //
  // The two reads after the membership check do not depend on each other
  // (proDraftsLeft is a plain counter read with no side effects), so they run
  // as one wave: the shell used to stack them serially on every pro route
  // (speed wave P2, 2026-08-30). A non-established pro's draftsLeft is read
  // and then ignored, exactly as before, because `established` still gates it.
  const member = await hasProPlan();
  const [establishedRead, draftsRead] = await Promise.all([
    member ? Promise.resolve(true) : isEstablishedPro(contractor.id),
    proDraftsLeft(contractor.id, member),
  ]);
  const established = member || establishedRead;
  const draftsLeft = established ? draftsRead : null;
  const canUseBackOffice =
    member || (established && (draftsLeft === null || draftsLeft > 0));
  const backOfficeHref = canUseBackOffice ? "/pro/tools" : "/pro/plus?reason=tools";

  return (
    <div className="min-h-screen">
      <ProNav company={contractor.name} hasHome={sides.hasHome} backOfficeHref={backOfficeHref} />
      {/* Extra bottom padding below lg keeps content clear of the fixed bottom
          tab bar. It was sm:pb-8; the bar now runs to lg (ProNav.tsx), so the
          padding follows it. Desktop at lg and up keeps today's pb-8. */}
      <main className="mx-auto max-w-5xl px-6 pb-24 pt-8 lg:pb-8">
        {children}
      </main>
      {/* The footer sits outside <main>, so main's pb-24 does not cover it and
          "Need a hand? Help" landed under the fixed bottom tab bar (3.5rem of
          content plus the safe-area inset, see ProNav's nav classes). Clear
          the bar plus a 1rem gap wherever the bar exists: it is lg:hidden now,
          not sm:hidden, so this is max-lg and lg+ keeps today's pb-8. */}
      <footer className="mx-auto max-w-5xl px-6 pb-8 text-center text-xs text-stone-500 max-lg:pb-[calc(3.5rem_+_env(safe-area-inset-bottom)_+_1rem)] dark:text-stone-400">
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

          NO <Suspense> AROUND THIS (removed 2026-08-30), and it must not come
          back. It used to sit behind `<Suspense fallback={null}>` so its
          users-row read could not hold up the shell. That boundary was the one
          thing the pro shell had that the homeowner shell (which mounts the
          same component bare) did not - and it was the cause of the
          intermittent `Minified React error #418` plus
          `Cannot read properties of null (reading 'parentNode') at $RS` that
          only ever showed on /pro pages.

          The mechanism: a Suspense boundary in the MIDDLE of the shell streams
          as `<!--$?--><template id="B:n"></template><!--/$-->`, and React's
          own reveal script rewrites those three nodes in place the moment the
          server resolves the boundary. On a pro page the shell flushes early
          (the layout's own reads are done) while this read is still in flight,
          so the rewrite lands in the same few milliseconds the client spends
          hydrating the shell around it. When it lands mid-hydration, React
          loses its place in the child list, throws the host-element mismatch
          (#418), client-renders the whole root, and the page-content fill
          script that runs after that has no `<template>` left to insert
          before - which is the `$RS` TypeError.

          BE HONEST ABOUT WHAT THIS BUYS. Measured on a local production build
          against a throwaway pro, hard-reloading the six pro routes: with the
          boundary, 3 failures in 36 loads; without it, 1 in 69 on the same
          build and 1 in 18 on the final one. It removes one of the two
          streamed boundaries the shell hydrates around, so the window shrinks,
          but it does NOT close it - the other boundary is the route segment's
          own (from pro/loading.tsx) and Next owns that one. The residual is a
          React 19.1.9 hydration-restart bug, captured by patching
          throwOnHydrationMismatch in the emitted React chunk: React re-enters
          <main> below with its module-level hydration cursor already pointing
          at <main>'s own first child, so the element cannot be re-claimed. The
          only app-level lever that removes the mechanism outright is to stop
          this shell flushing ahead of the page body at all (no pro
          loading.tsx anywhere, so there is no deferred boundary to reveal),
          and that is a product trade - skeleton now vs. a later first paint -
          that belongs to the owner, not to this file.

          Nothing is paid for removing it: getUserProfile() is React-cached per
          request and is already awaited in the Promise.all at the top of this
          layout, so the read here is a cache hit and the shell waits on
          nothing new. This is exactly how src/app/(app)/layout.tsx has always
          mounted it. */}
      <AppGuideMount side="pro" />
    </div>
  );
}
