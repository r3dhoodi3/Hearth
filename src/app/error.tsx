"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useEffect, useState } from "react";
import Logo from "@/components/Logo";
import {
  isStaleDeployError,
  recoverFromStaleDeploy,
  STALE_RELOAD_MESSAGE,
} from "@/lib/staleDeploy";

// Root error boundary. Renders outside the app shells, so it centers itself.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  // Deploy skew heals itself: a page left open across a deploy throws
  // stale-action / chunk-load errors that a reload fixes outright
  // (src/lib/staleDeploy.ts). When that is what landed here, reload once and
  // show a calm one-liner instead of the sideways card. The guard inside
  // recoverFromStaleDeploy makes sure a reload that DIDN'T fix it falls
  // through to the normal card rather than looping.
  const [reloading, setReloading] = useState(false);
  useEffect(() => {
    if (isStaleDeployError(error) && recoverFromStaleDeploy()) {
      setReloading(true);
    }
  }, [error]);

  // reset() alone only re-renders the client tree; if the error came from a
  // server component (the common case: Supabase down, server hiccup), the
  // failed server payload is still cached and the button would do nothing.
  // router.refresh() refetches the server data, and running both in one
  // transition retries the whole segment for real.
  function tryAgain() {
    startTransition(() => {
      router.refresh();
      reset();
    });
  }

  if (reloading) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <div className="card w-full max-w-md text-center">
          <Logo className="mx-auto h-10 w-10 text-bark-600 dark:text-stone-400" />
          <p className="mt-4 text-sm text-stone-600 dark:text-stone-400">
            {STALE_RELOAD_MESSAGE}
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="card w-full max-w-md text-center">
        <Logo className="mx-auto h-10 w-10 text-bark-600 dark:text-stone-400" />
        <h1 className="mt-4 text-xl font-semibold text-stone-900 dark:text-stone-100">
          Something went sideways
        </h1>
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">
          Your data is safe. Trying again usually clears it up; if it keeps
          happening, give it a minute and come back.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <button onClick={tryAgain} className="btn-primary">
            Try again
          </button>
          <Link href="/" className="btn-secondary">
            Go home
          </Link>
          {/* "/", not "/dashboard": this boundary catches errors from BOTH
              sides of the app (a failed Finish setup in the pro signup wizard
              renders it too), and a hard link to the homeowner dashboard sent a
              contractor with no company row yet into the claim-your-home
              wizard. The home page resolves the side on the server with the
              same landingFor() every other landing uses, so a pro mid-signup
              comes back to /pro/onboarding and a homeowner still lands on
              /dashboard (a signed-out visitor gets the landing page). */}
          <Link href="/" className="btn-secondary">
            Your dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
