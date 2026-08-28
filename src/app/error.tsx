"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition } from "react";
import Logo from "@/components/Logo";

// Root error boundary. Renders outside the app shells, so it centers itself.
export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

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
          {/* /get-started, not /dashboard: this boundary catches errors from
              BOTH sides of the app (a failed Finish setup in the pro signup
              wizard renders it too), and a hard link to the homeowner
              dashboard sent a contractor with no company row yet into the
              claim-your-home wizard. /get-started resolves the side on the
              server with the same landingFor() every other landing uses, so a
              pro mid-signup comes back to /pro/onboarding and a homeowner
              still lands on /dashboard. */}
          <Link href="/get-started" className="btn-secondary">
            Your dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
