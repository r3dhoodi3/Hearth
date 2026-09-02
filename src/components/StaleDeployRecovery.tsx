"use client";

import { useEffect } from "react";
import { isStaleDeployError, recoverFromStaleDeploy } from "@/lib/staleDeploy";

// Global safety net for deploy-skew failures (src/lib/staleDeploy.ts): a page
// that was open across a deploy throws "Failed to find Server Action" on its
// next form submit and ChunkLoadError on its next navigation. Errors a
// component catches locally never reach these listeners (the onboarding wizard
// and the error boundaries handle their own), but a form action awaited
// without a try/catch surfaces as an unhandled rejection, and a failed chunk
// request as a window error - this component turns both into one quiet reload
// instead of a dead page.
//
// Mounted once in the root layout. Renders nothing, reads no cookies, so the
// layout's static-generation rule (see src/app/layout.tsx) is preserved.
export default function StaleDeployRecovery() {
  useEffect(() => {
    function onRejection(e: PromiseRejectionEvent) {
      if (isStaleDeployError(e.reason) && recoverFromStaleDeploy()) {
        // The reload is handling it; keep the console clear of a scary
        // unhandled-rejection line for a failure that is already resolved.
        e.preventDefault();
      }
    }
    function onError(e: ErrorEvent) {
      if (isStaleDeployError(e.error ?? e.message) && recoverFromStaleDeploy()) {
        e.preventDefault();
      }
    }
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, []);

  return null;
}
