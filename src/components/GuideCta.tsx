"use client";

import Link from "next/link";
import { useSignedIn } from "@/components/SessionCta";

// Shared closing CTA for the public /guides pages. Every guide page ends with
// the same pitch: the ranges above are national/typical, Hearth's answer is
// specific to the visitor's own home, and it's free to get. Keep this in
// lockstep across all guide pages rather than letting each page drift.
//
// Session-aware: a signed-in visitor with an account has already gotten
// past this pitch, so repeating "get started free" reads as a bug, not a
// nudge.
//
// NOW A CLIENT COMPONENT, and that is the whole point. This used to answer the
// session question on the server - first with its own supabase.auth.getUser()
// call, later through the request-cached getVerifiedUser() it shared with
// src/app/guides/layout.tsx. Either way it was a server-side session read
// sitting in the tree of 14 public, indexable pages, which is what kept every
// one of them off static generation. It now reads the session in the browser
// through useSignedIn() (see src/components/SessionCta.tsx for the full
// reasoning and the honest cost), so the guide BODY prerenders and only this
// closing card resolves after hydration - which is exactly the fix the old
// comment here and in the guides layout both asked for.
//
// It renders the signed-out pitch first and swaps, so a signed-in reader sees
// the sign-up card for a moment. It sits at the foot of a long article, well
// below the fold, so the swap is not something a reader watches happen.
//
// signedIn: pass it when the calling tree already knows the answer for its own
// reasons and wants to skip the client lookup entirely. Nothing passes it
// today; the /guides pages and the city pages all rely on the hook.
//
// signedInHref/signedInLabel let a page point a signed-in reader at the
// in-app screen that answers the same question for their own home. Callers
// that don't pass them get "/", which routes by side - a contractor reading a
// guide lands on their own shell instead of a homeowner dashboard they do not
// have.
export default function GuideCta({
  signedIn,
  signedInHref = "/",
  signedInLabel = "See this for your home",
}: {
  signedIn?: boolean;
  signedInHref?: string;
  signedInLabel?: string;
}) {
  const resolved = useSignedIn();
  const isSignedIn = signedIn ?? resolved;

  if (isSignedIn) {
    return (
      <section className="mt-12 rounded-2xl border border-bark-100 bg-bark-50 p-6 text-center shadow-sm dark:border-bark-700 dark:bg-bark-700/20">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          See this for YOUR home
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-stone-600 dark:text-stone-300">
          Everything above is a general, national range. Hearth already
          knows your home&apos;s actual age, size, and systems.
        </p>
        <Link
          href={signedInHref}
          className="btn-primary mt-5 inline-block px-6 py-2.5"
        >
          {signedInLabel}
        </Link>
      </section>
    );
  }

  return (
    <section className="mt-12 rounded-2xl border border-bark-100 bg-bark-50 p-6 text-center shadow-sm dark:border-bark-700 dark:bg-bark-700/20">
      <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
        Get the answer for YOUR home
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-stone-600 dark:text-stone-300">
        Everything above is a general, national range. Hearth knows your
        home&apos;s actual age, size, and systems, and turns that into a
        house-specific answer, free.
      </p>
      <Link
        href="/homeowner-signup"
        className="btn-primary mt-5 inline-block px-6 py-2.5"
      >
        Get started free
      </Link>
    </section>
  );
}
