"use client";

import { useEffect } from "react";

// Forwards the launch shell to the real app the moment the client boots.
// location.replace, not router.push: the shell must leave no back-stack entry,
// or the installed app's back gesture would land on a page whose only job is
// to immediately leave again. Kept as its own tiny client component so the
// page around it stays a static server component with no client bundle of its
// own beyond this effect.
export default function OpenRedirect() {
  useEffect(() => {
    window.location.replace("/dashboard?source=pwa");
  }, []);
  return null;
}
