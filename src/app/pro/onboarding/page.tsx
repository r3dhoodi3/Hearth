import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentContractor, getSides } from "@/lib/contractor";
import { getUser } from "@/lib/auth";
import { chooseRoleAction } from "@/app/welcome/role/actions";
import OnboardingCompanyForm from "./OnboardingCompanyForm";

// Quiet, same weight for every way out, and a real 44px row on a phone.
const ESCAPE_LINK =
  "underline underline-offset-2 hover:text-stone-700 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:hover:text-stone-200";

export default async function ProOnboardingPage(
  props: {
    searchParams?: Promise<{ ref?: string | string[] }>;
  }
) {
  const searchParams = await props.searchParams;
  // Already set up? Go straight to the leads inbox.
  const contractor = await getCurrentContractor();
  if (contractor) redirect("/pro");

  // No role gate. Building a company IS the choice to have a pro side, and any
  // signed-in account may make it - a homeowner adding a business, a Google
  // user who typed the URL, a legacy account with no stamp at all. The two
  // things the old /welcome/role detour was protecting are now handled by the
  // action that actually creates the row (saveCompanyAction): it records the
  // pro_terms acceptance, and it stamps role=contractor when the account had
  // no preferred side yet.

  // Prefill the company email with the account email. They can change it.
  // sides only decides whether the way out below is worth showing.
  const [user, sides] = await Promise.all([getUser(), getSides()]);

  // Referral attribution: /pros?ref=CODE links land here with the code in the
  // query string. Prefill it; the pro can still edit or clear it.
  const ref = searchParams?.ref;
  const referralCode = typeof ref === "string" ? ref.slice(0, 100) : "";

  // One phone-width column on every screen: the form is a four-step wizard now
  // (OnboardingCompanyForm), not a two-column sheet, so a wider container would
  // only stretch a card that holds one question at a time.
  return (
    <div className="mx-auto max-w-lg">
      <OnboardingCompanyForm
        // The wizard's localStorage draft key is scoped to this id, so a
        // machine two pros share never prefills one with the other's answers.
        userId={user?.id ?? ""}
        defaultEmail={user?.email ?? ""}
        defaultReferralCode={referralCode}
      />
      {/* WAYS OUT. This page is a dead end for an account with a contractor
          stamp and no company row: every landing in the app resolves to it,
          and until Finish setup succeeds there is no row to resolve anywhere
          else. A save that keeps failing (a schema constraint, a CSLB timeout)
          therefore trapped a tester behind this one form, sign-out and back in
          included. So the two real answers sit under it, quietly:

          - a home to go back to, for someone who only wandered onto the pro
            side and has one already;
          - otherwise the honest question. It posts to the same guarded
            chooseRoleAction /welcome/role uses, which stamps homeowner and
            lands them on the claim-a-home wizard - and which still refuses to
            move an account that HAS a side, so this can only ever help
            someone who has built nothing yet.

          Sign out is repeated from the bare shell's header on purpose: this is
          where someone looks when they are stuck, and the header bar is off
          screen by the time they have scrolled to the end of the wizard. */}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-center text-sm text-stone-500 dark:text-stone-400">
        {sides.hasHome ? (
          <Link href="/dashboard" className={ESCAPE_LINK}>
            Back to your home
          </Link>
        ) : (
          <form action={chooseRoleAction}>
            <input type="hidden" name="role" value="homeowner" />
            <button type="submit" className={ESCAPE_LINK}>
              Not a contractor? Set up as a homeowner instead
            </button>
          </form>
        )}
        <form action="/auth/signout" method="post">
          <button type="submit" className={ESCAPE_LINK}>
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
