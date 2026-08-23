import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentContractor, getSides } from "@/lib/contractor";
import { getUser } from "@/lib/auth";
import OnboardingCompanyForm from "./OnboardingCompanyForm";

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
      {/* Way out for someone who already has a home here and only wandered
          onto the pro side. The bare pro shell has nothing but sign-out, and
          this page is now reachable by any signed-in account, so without this
          a homeowner who clicked the wrong thing would have to sign out. */}
      {sides.hasHome && (
        <p className="mt-6 text-center text-sm text-stone-500 dark:text-stone-400">
          <Link
            href="/dashboard"
            className="underline hover:text-stone-700 dark:hover:text-stone-200"
          >
            Back to your home
          </Link>
        </p>
      )}
    </div>
  );
}
