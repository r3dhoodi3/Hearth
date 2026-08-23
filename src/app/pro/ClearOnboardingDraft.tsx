"use client";

import { useEffect } from "react";
import { clearProOnboardingDraft } from "./onboarding/draftKey";

// Renders nothing. It exists because reaching /pro at all means a contractors
// row exists for this account, and that makes the signup draft in localStorage
// dead weight: the wizard will never be shown to this pro again, so nothing is
// ever going to restore it.
//
// The wizard deliberately does NOT clear its own draft on submit - a refused
// save (a CSLB timeout, a failed insert) re-renders that same form, and the
// draft is what the pro needs back when it does. So the clearing has to happen
// on the far side of a save that actually worked, which is here.
//
// A client component because /pro is a server component and localStorage only
// exists in the browser.
export default function ClearOnboardingDraft({ userId }: { userId: string }) {
  useEffect(() => {
    clearProOnboardingDraft(userId);
  }, [userId]);
  return null;
}
