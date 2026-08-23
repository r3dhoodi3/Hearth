import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProperties } from "@/lib/property";
import { getCurrentContractor } from "@/lib/contractor";
import { ownsPlus } from "@/lib/subscription";
import { safeNextPath } from "@/lib/safeNext";
import OnboardingForm from "./OnboardingForm";

// ?next=: the tail end of the sign-up funnel's redirect chain (see
// homeowner-signup/page.tsx). Handed to OnboardingForm as a hidden field so
// claimPropertyAction (./actions.ts) can honor it once the home is claimed -
// the claimed-home gate in (app)/layout.tsx sends every new homeowner through
// here regardless of ?next=, which is expected; this just keeps their
// original destination alive across that detour instead of dropping it.
export default async function OnboardingPage(
  props: {
    searchParams?: Promise<{ next?: string; ref?: string; add?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const next = safeNextPath(
    typeof searchParams?.next === "string" ? searchParams.next : null
  );

  // Household invite (QR scan) escape hatch. A signed-out scanner is sent
  // through /homeowner-signup?next=/join/household/<token>, and with email
  // confirmation ON the signup builds its confirmation link as
  // /auth/callback?next=/onboarding?next=/join/household/<token> - so after
  // confirming they land HERE, on the claim-your-home step. But an invited
  // housemate (a spouse, an adult child) has no property of their own to
  // claim; forcing them through this form would strand them, and they'd only
  // reach the invite after claiming a home they don't have. When next points
  // at a /join/ redemption page, skip onboarding entirely and hand them
  // straight there, where the token is redeemed under their new session. This
  // does NOT consume the QR scan grace: the 30-minute window was already
  // stamped when they first opened the invite link (migration 0097), and this
  // redirect just delivers them back to it. The ordinary onboarding flow (no
  // next, or any non-/join destination) is untouched.
  //
  // Checked before the pro bounce below so a pro who was invited into someone
  // else's household still redeems the invite instead of being sent to /pro.
  if (next && next.startsWith("/join/")) {
    redirect(next);
  }

  // A pro is welcome to own a home - plenty do - so a contractors row no
  // longer bars this page. What it still does is catch the pro who WANDERED
  // in: a company, no home at all, and no explicit "I'm adding a home" intent.
  // For them this page is a wrong turn (it used to be the tail of a redirect
  // loop), so send them back to their leads.
  //
  // ?add=home is that explicit intent, and it comes from the one link that
  // offers it - "Add your home" in the pro profile menu (ProNav.tsx).
  const [contractor, homes] = await Promise.all([
    getCurrentContractor(),
    getProperties(),
  ]);
  const hasPro = contractor !== null;
  if (hasPro && homes.length === 0 && searchParams?.add !== "home") {
    redirect("/pro");
  }

  // Who is signed in, for the escape hatch below. Before this existed, an
  // account with no claimed home was hard-stuck here: the (app) layout
  // bounces every page back to /onboarding, this page had no sign-out, and
  // an account with contractor role metadata but no contractors row (pro
  // signup never finished) failed the contractors-row redirect above too.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // ?ref=: the inviter's referral code (migration 0099), carried here from
  // /homeowner-signup. Handed to OnboardingForm as a hidden field so
  // claimPropertyAction can attribute a first home claim to the neighbor who
  // shared the link. Passed through as-is; the action resolves it by exact
  // match, so a junk or expired value simply never resolves and is ignored.
  const ref =
    typeof searchParams?.ref === "string" && searchParams.ref.trim()
      ? searchParams.ref.trim()
      : null;

  // First home vs. adding another - onboarding stays reachable either way.
  const isFirst = homes.length === 0;

  // Free plan covers 1 owned home (shared homes don't count - same tally as
  // claimPropertyAction in ./actions.ts, incl. ownsPlus over hasPlus: the cap
  // is on homes you own, so household Plus doesn't raise it). Surface the cap
  // HERE, before the form, instead of letting someone fill it all in only to
  // be bounced to /plus at the very end.
  if (!isFirst) {
    const plus = await ownsPlus();
    const ownedHomes = homes.filter((h) => !h.isShared);
    if (!plus && ownedHomes.length >= 1) {
      return (
        <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-12">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
              Add another home
            </h1>
          </div>
          <div className="card text-center">
            <p className="text-sm text-stone-600 dark:text-stone-300">
              Your first home is free. Adding another home is part of Hearth
              Plus.
            </p>
            <Link
              href="/plus?reason=home_limit"
              className="btn-primary mt-4 inline-block"
            >
              See Hearth Plus
            </Link>
          </div>
          <Link
            href="/dashboard"
            className="mt-4 text-center text-sm text-stone-500 hover:underline dark:text-stone-400"
          >
            Back to dashboard
          </Link>
          {hasPro && (
            <Link
              href="/pro"
              className="mt-2 text-center text-sm text-stone-500 hover:underline dark:text-stone-400"
            >
              Go to Hearth Pro
            </Link>
          )}
        </main>
      );
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-12">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          {isFirst ? "Let's set up your home" : "Add another home"}
        </h1>
        {!isFirst && (
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            Switch between your homes anytime from the top bar.
          </p>
        )}
      </div>

      <OnboardingForm
        next={next}
        referralCode={ref}
        existingName={
          (user?.user_metadata?.full_name as string | undefined)?.trim() ?? ""
        }
      />

      {!isFirst && (
        <Link
          href="/dashboard"
          className="mt-4 text-center text-sm text-stone-500 hover:underline dark:text-stone-400"
        >
          Cancel
        </Link>
      )}

      {/* Escape hatch: nobody should be trapped on this page. Signed-in
          users with no home land here from every app URL, so this is the
          only place they can change course. */}
      <div className="mt-8 text-center text-sm text-stone-500 dark:text-stone-400">
        {hasPro && (
          <p>
            Here for the pro side?{" "}
            <Link href="/pro" className="underline hover:text-stone-700 dark:hover:text-stone-200">
              Go to Hearth Pro
            </Link>
          </p>
        )}
        <div className={hasPro ? "mt-2" : undefined}>
          <span className="break-words">Signed in as {user?.email ?? "unknown"}. Wrong account? </span>
          <form action="/auth/signout" method="post" className="inline">
            <button
              type="submit"
              className="underline hover:text-stone-700 dark:hover:text-stone-200"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
