import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentContractor, getRole } from "@/lib/contractor";
import Logo from "@/components/Logo";
import ProNav from "@/components/ProNav";
import NewMessageNotifier from "@/components/NewMessageNotifier";
import AskHearthDock from "@/components/AskHearthDock";
import { getOpenJobsForMe } from "@/lib/greeting";

// A warm one-liner for the pro copilot dock. If we can cheaply see how many
// open leads match their trades, reference it; otherwise fall back to a
// friendly generic. Wrapped so it can never throw and break the shell.
// Rendered inside a Suspense boundary below so the open_jobs_for_me RPC never
// blocks the rest of the shell from streaming - like the homeowner side's
// proactive greeting, this only feeds the dock's opening line, and the dock
// stays closed (so unread by the user) until clicked.
async function ProAskHearthDock({ contractorName }: { contractorName: string }) {
  let proGreeting = `Hi ${contractorName}. Ask me about winning leads, pricing a bid, your license badge, or growing your business.`;
  try {
    const openJobs = await getOpenJobsForMe();
    const openCount = openJobs.length;
    if (openCount > 0) {
      proGreeting = `Hi ${contractorName}. There ${
        openCount === 1 ? "is" : "are"
      } ${openCount} open ${
        openCount === 1 ? "lead" : "leads"
      } matching your trades right now. Ask me how to win them, price a bid, or grow your business.`;
    }
  } catch {
    /* keep the generic greeting */
  }

  return (
    <AskHearthDock
      endpoint="/api/pro-ask"
      storageKeyBase="hearth_pro_ask_chat"
      retentionKeyBase="hearth_pro_ask_retention"
      headingTitle="Ask Hearth for Pros"
      headingSubtitle="Your business copilot"
      greeting={proGreeting}
    />
  );
}

// Pro shell. Auth is enforced by middleware; company-setup is enforced per-page
// (so /pro/onboarding itself doesn't get caught in a redirect loop).
export default async function ProLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Keep homeowners off the contractor side (and prevent them from accidentally
  // creating a company at /pro/onboarding). Contractors without a company yet
  // still pass, so they can finish onboarding. The role check and the company
  // lookup don't depend on each other, so they go out together: the redirect
  // only reads the role, and a homeowner never renders the shell anyway.
  const [role, contractor] = await Promise.all([
    getRole(),
    getCurrentContractor(),
  ]);
  if (role === "homeowner") redirect("/dashboard");

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
                className="text-sm text-stone-500 underline hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
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
      <ProNav company={contractor.name} />
      {/* Extra bottom padding on phones keeps content clear of the fixed
          Ask Hearth dock. */}
      <main className="mx-auto max-w-5xl px-6 pb-24 pt-8 sm:pb-8">
        {children}
      </main>
      <footer className="mx-auto max-w-5xl px-6 pb-8 text-center text-xs text-stone-500 dark:text-stone-400">
        Need a hand?{" "}
        <Link href="/pro/help" className="underline hover:text-stone-600 dark:hover:text-stone-300">
          Help
        </Link>
      </footer>
      <Suspense fallback={null}>
        <ProAskHearthDock contractorName={contractor.name} />
      </Suspense>
      <NewMessageNotifier role="contractor" />
    </div>
  );
}
