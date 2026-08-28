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

// NO UNSCOPED FALLBACK. This used to return the bare PREFIX when it had no
// account id, so a render that could not read a user wrote its draft to a key
// EVERY account on the browser shares. That is both halves of the bug testers
// hit: the next account to open the wizard reads a stranger's answers out of
// it, and one round trip through a signed-out render was enough to split a
// pro's own work across two keys - written to the shared one, looked for under
// the scoped one, gone.
//
// So an id-less caller now gets null and does nothing at all: no read, no
// write, no delete. Losing the draft for a render with no user behind it is a
// lost convenience; the shared key was a leak and a loss at once.
export function proOnboardingDraftKey(
  userId: string | null | undefined
): string | null {
  const id = (userId ?? "").trim();
  return id ? `${PREFIX}.${id}` : null;
}

export function clearProOnboardingDraft(userId: string | null | undefined) {
  const key = proOnboardingDraftKey(userId);
  if (!key) return;
  try {
    localStorage.removeItem(key);
    // Also sweep the pre-scoping key. Anyone mid-signup when scoping shipped
    // has an unscoped draft sitting in their browser that nothing will ever
    // read again; clearing it here means it does not sit there until its own
    // expiry. Only ever on behalf of a real account, so a signed-out render
    // can no longer wipe anything.
    localStorage.removeItem(PREFIX);
  } catch {
    // Private mode, or storage disabled. The draft was only ever a convenience.
  }
}
