"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getSupabase } from "@/lib/lazySupabase";

// The session-aware CTA for the PUBLIC marketing pages, resolved in the
// browser instead of on the server.
//
// WHY THIS EXISTS. /guides (the index plus 12 guide pages), /fountain-valley
// and /huntington-beach are the pages Google actually sends traffic to, and
// every one of them was rendered per-request purely because a server component
// read the session to decide whether the header said "Get started free" or
// "Open your dashboard". A layout's dynamic read opts its whole subtree out of
// static generation, so one auth round trip in src/app/guides/layout.tsx cost
// 13 pages their prerender and put a network hop to Supabase's auth server in
// front of the guide's own content. Both files' comments already named this
// component as the fix and asked for it in its own pass. This is that pass.
//
// WHAT IT COSTS, HONESTLY. A signed-in reader sees the signed-out CTA for the
// few milliseconds between paint and hydration, then it swaps. That is the
// trade the old comments were unwilling to make while the swap was the only
// change; it is worth making now that the whole page ships from the CDN
// instead of a cold serverless invocation. The swap is contained: the header
// button is the last item in a `justify-between` row, so only its own width
// changes and nothing else on the page moves.
//
// HOW IT READS THE SESSION. The browser Supabase client
// (@supabase/ssr's createBrowserClient) reads the same auth cookie the server
// client writes, so getSession() answers locally with no request of its own -
// no /api/session route, no fetch waterfall, nothing for the CDN to vary on.
// If it cannot answer (cleared storage, a cookie the browser refused), the
// answer is "signed out", which is the same thing every anonymous visitor
// sees. That is the right way to be wrong here: the worst case is showing a
// signed-in reader the sign-up link, which still works for them.
//
// This is presentation only. It decides which of two public links to render
// and reads nothing sensitive. No page gate, no data access, and no server
// route trusts it.
export function useSignedIn(): boolean {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let alive = true;
    // Lazily loaded: this hook only ever runs after hydration, so supabase-js
    // does not belong in the first payload (src/lib/lazySupabase.ts).
    getSupabase()
      .then((supabase) => supabase.auth.getSession())
      .then(({ data }) => {
        if (alive) setSignedIn(data.session != null);
      })
      .catch(() => {
        // Stay on the signed-out CTA. See the note above.
      });
    return () => {
      alive = false;
    };
  }, []);

  return signedIn;
}

// The header button shared by the guides layout and the city landing pages.
// signedOutHref differs between them (/get-started vs /homeowner-signup), so
// it is a prop; every class name is identical to what the two server versions
// rendered, character for character, so the pages look the same as before.
export default function SessionCta({
  signedOutHref,
  className = "rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:border-bark-500 hover:text-bark-700 dark:border-white/10 dark:text-stone-300 dark:hover:text-stone-300",
  // "/" rather than "/dashboard": the root already routes a signed-in account
  // to whichever side it belongs on, so a contractor reading a guide is not
  // sent to a homeowner dashboard they do not have.
  signedInHref = "/",
  signedInLabel = "Open your dashboard",
  signedOutLabel = "Get started free",
}: {
  signedOutHref: string;
  className?: string;
  signedInHref?: string;
  signedInLabel?: string;
  signedOutLabel?: string;
}) {
  const signedIn = useSignedIn();

  return (
    <Link href={signedIn ? signedInHref : signedOutHref} className={className}>
      {signedIn ? signedInLabel : signedOutLabel}
    </Link>
  );
}
