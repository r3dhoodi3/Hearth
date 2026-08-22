import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getRole } from "@/lib/contractor";
import Link from "next/link";
import { safeNextPath } from "@/lib/safeNext";
import { Home, Hammer } from "lucide-react";

export const metadata: Metadata = {
  // The root layout's title template appends "| Hearth"; don't repeat it here.
  title: "Get started",
  description:
    "Tell Hearth who you are: homeowners get a home that's looked after, pros get leads with the fee shown up front. Free to start, no card needed.",
};

// Role chooser for NEW users. After "Get started" they pick homeowner or
// contractor and we send them to the matching sign-up (which tags the account's
// role). Already-signed-in users with a known role skip straight into their
// side of the app; a signed-in user with no role yet still gets the chooser.
//
// ?next=: carried in from /signin (a signed-out visitor who hit a gated CTA,
// bounced to sign-in, then chose to sign up instead) and threaded through to
// whichever sign-up page they pick, so their original destination survives
// the "who are you?" fork instead of being dropped here.
export default async function GetStarted(
  props: {
    searchParams?: Promise<{ next?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const next = safeNextPath(
    typeof searchParams?.next === "string" ? searchParams.next : null
  );
  const nextQuery = next ? `?next=${encodeURIComponent(next)}` : "";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const role = await getRole();
    if (role) redirect(next ?? (role === "contractor" ? "/pro" : "/dashboard"));
    // Signed in, but no role yet: this is the same fork /welcome/role asks,
    // except the tiles below link to the two SIGN-UP pages, which would show
    // someone a create-an-account form for the account they are already
    // signed into. That is the dead end a Google user hits when /pro sends a
    // role-less account here. /welcome/role asks the same question, stamps the
    // role, records the right terms acceptance, and routes into the matching
    // complete-your-profile step, so send them there instead.
    redirect(`/welcome/role${nextQuery}`);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6 text-center">
      <h1 className="text-3xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
        Who are you?
      </h1>
      <p className="mt-3 text-stone-600 dark:text-stone-300">
        Choose how you&apos;d like to use Hearth.
      </p>
      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
        Free, about 30 seconds, no card needed.
      </p>

      <div className="mt-10 grid w-full grid-cols-1 gap-4 sm:grid-cols-2">
        <Link
          href={`/homeowner-signup${nextQuery}`}
          className="flex flex-col items-center justify-center rounded-2xl border border-stone-200 bg-white px-6 py-12 shadow-sm transition hover:border-bark-500 hover:shadow-md dark:border-white/10 dark:bg-stone-800"
        >
          <Home className="h-9 w-9 text-bark-700 dark:text-stone-400" aria-hidden="true" />
          <div className="mt-4 text-lg font-medium text-stone-900 dark:text-stone-100">
            I&apos;m a homeowner
          </div>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            Track your home and find a pro.
          </p>
        </Link>

        <Link
          href={`/contractor-signup${nextQuery}`}
          className="flex flex-col items-center justify-center rounded-2xl border border-stone-200 bg-white px-6 py-12 shadow-sm transition hover:border-bark-500 hover:shadow-md dark:border-white/10 dark:bg-stone-800"
        >
          <Hammer className="h-9 w-9 text-bark-700 dark:text-stone-400" aria-hidden="true" />
          <div className="mt-4 text-lg font-medium text-stone-900 dark:text-stone-100">
            I&apos;m a contractor
          </div>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            Get matched with homeowner leads.
          </p>
        </Link>
      </div>

      <p className="mt-8 text-sm text-stone-500 dark:text-stone-400">
        Already have an account?{" "}
        <Link
          href={`/signin${nextQuery}`}
          className="font-medium text-bark-700 hover:underline dark:text-stone-300"
        >
          Sign in
        </Link>
      </p>
      <Link href="/" className="mt-3 text-sm text-stone-500 hover:underline dark:text-stone-400">
        ← Back
      </Link>
    </main>
  );
}
