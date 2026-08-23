// Where the pro signup wizard's half-finished draft lives in localStorage, and
// the one way to remove it. Shared by the wizard itself
// (./OnboardingCompanyForm.tsx) and by the /pro dashboard, which drops the key
// the moment a contractors row exists (../ClearOnboardingDraft.tsx).
//
// SCOPED TO THE SIGNED-IN ACCOUNT. This used to be a single global key, which
// meant that on a machine more than one person signs in on - the front desk
// computer at a shop, a family laptop, a library terminal - the next pro to
// start a signup was handed the PREVIOUS pro's company name, phone number and
// license number already typed into the form. None of that is secret (it all
// lands on a public profile a minute later), but a stranger's license number
// sitting prefilled in someone else's application is exactly the kind of thing
// that gets submitted without being read.
const PREFIX = "hearth.pro-onboarding.v1";

export function proOnboardingDraftKey(
  userId: string | null | undefined
): string {
  const id = (userId ?? "").trim();
  // No account id in hand (a page that never had one) falls back to the bare
  // prefix. That is the old, unscoped behaviour, and it is the right fallback:
  // for the one person using their own browser it still saves their work, and
  // it is the only case where nothing better is available.
  return id ? `${PREFIX}.${id}` : PREFIX;
}

export function clearProOnboardingDraft(userId: string | null | undefined) {
  try {
    localStorage.removeItem(proOnboardingDraftKey(userId));
    // Also sweep the pre-scoping key. Anyone mid-signup when this shipped has
    // an unscoped draft sitting in their browser that nothing will ever read
    // again; clearing it here means it does not sit there until its own expiry.
    localStorage.removeItem(PREFIX);
  } catch {
    // Private mode, or storage disabled. The draft was only ever a convenience.
  }
}
