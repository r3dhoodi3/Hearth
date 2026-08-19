import { redirect } from "next/navigation";
import { getCurrentContractor, getRole } from "@/lib/contractor";
import { getUser } from "@/lib/auth";
import OnboardingCompanyForm from "./OnboardingCompanyForm";

export default async function ProOnboardingPage({
  searchParams,
}: {
  searchParams?: { ref?: string | string[] };
}) {
  // Already set up? Go straight to the leads inbox.
  const contractor = await getCurrentContractor();
  if (contractor) redirect("/pro");

  // No role yet: ask before letting them build a company. Everyone who gets
  // here legitimately already carries one - contractor-signup stamps
  // role=contractor in signUp's options.data, /auth/callback backfills it for
  // that page's Google button, and /welcome/role stamps it before redirecting
  // here - so a null role means a signed-in user who never went through any
  // of those (a Google user who typed the URL, or a legacy account). Creating
  // a contractors row for them would make them a pro only via getRole()'s
  // legacy contractor-row fallback, with no pro_terms acceptance on record.
  // No ?next=: the picker sends a contractor straight back here, and threading
  // this path through would strand a homeowner at /onboarding?next=/pro/...
  if ((await getRole()) === null) redirect("/welcome/role");

  // Prefill the company email with the account email. They can change it.
  const user = await getUser();

  // Referral attribution: /pros?ref=CODE links land here with the code in the
  // query string. Prefill it; the pro can still edit or clear it.
  const ref = searchParams?.ref;
  const referralCode = typeof ref === "string" ? ref.slice(0, 100) : "";

  return (
    <div className="mx-auto max-w-3xl">
      <OnboardingCompanyForm
        defaultEmail={user?.email ?? ""}
        defaultReferralCode={referralCode}
      />
    </div>
  );
}
