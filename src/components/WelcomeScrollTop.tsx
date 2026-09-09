"use client";

import { useEffect } from "react";

// Renders nothing. Forces the dashboard back to the top of the page the
// instant the first-visit welcome view (?welcome=1, right after claiming a
// home in onboarding) mounts.
//
// A3: testers landed on this page scrolled to the very bottom instead of the
// top. The likely cause is the browser carrying over the onboarding form's
// own scroll position across the redirect (a tall address-lookup form can
// leave the page scrolled well down, and neither a server redirect() nor the
// client router is guaranteed to reset that here) plus SpotlightTour's own
// scrollIntoView({block:"center"}) on its first step - both are fighting for
// the same scroll position on the same paint. This runs first, synchronously
// on mount, before either of those has a chance to run, so the page always
// starts this view pinned to the top the way any fresh page load should.
export default function WelcomeScrollTop() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return null;
}
