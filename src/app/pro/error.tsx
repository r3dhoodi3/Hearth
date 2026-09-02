"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useEffect, useState } from "react";
import {
  isStaleDeployError,
  recoverFromStaleDeploy,
  STALE_RELOAD_MESSAGE,
} from "@/lib/staleDeploy";

// Error boundary for contractor screens. Renders inside the pro shell, so the
// nav stays up and the layout container is already provided.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  // Deploy skew heals itself: stale-action / chunk-load errors from a page
  // left open across a deploy get one automatic reload with a calm line
  // instead of the sideways card (src/lib/staleDeploy.ts; the root
  // error.tsx carries the full note).
  const [reloading, setReloading] = useState(false);
  useEffect(() => {
    if (isStaleDeployError(error) && recoverFromStaleDeploy()) {
      setReloading(true);
    }
  }, [error]);

  // reset() alone only re-renders the client tree; if the error came from a
  // server component (Supabase down, server hiccup), the failed payload is
  // still cached and the button would do nothing. router.refresh() refetches
  // the server data, so both together retry the segment for real.
  function tryAgain() {
    startTransition(() => {
      router.refresh();
      reset();
    });
  }

  if (reloading) {
    return (
      <div className="card mx-auto max-w-md text-center">
        <p className="text-sm text-stone-600 dark:text-stone-400">
          {STALE_RELOAD_MESSAGE}
        </p>
      </div>
    );
  }

  return (
    <div className="card mx-auto max-w-md text-center">
      <h1 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
        Something went sideways
      </h1>
      <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">
        Your data is safe. Trying again usually clears it up.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <button onClick={tryAgain} className="btn-primary">
          Try again
        </button>
        <Link href="/pro" className="btn-secondary">
          Back to your dashboard
        </Link>
      </div>
    </div>
  );
}
