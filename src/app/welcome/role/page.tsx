import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getRole } from "@/lib/contractor";
import { safeNextPath } from "@/lib/safeNext";
import { chooseRoleAction } from "./actions";

export const metadata: Metadata = {
  // The root layout's title template appends "| Hearth"; don't repeat it here.
  title: "Welcome to Hearth",
  description: "Tell Hearth how you'll be using it to finish setting up.",
};

// Role picker for a brand-new OAuth user who arrived with no role - i.e. they
// signed in with Google from the plain /signin page rather than one of the two
// signup pages, so we never learned whether they're a homeowner or a
// contractor (see src/app/auth/callback/route.ts, which sends them here). The
// two signup doors already stamp a role, so their users never see this page.
//
// ?next=: the destination they were originally headed for, threaded through to
// the action so it survives the "who are you?" fork. Validated with the same
// open-redirect guard used everywhere else the param is read.
export default async function WelcomeRolePage(
  props: {
    searchParams?: Promise<{ next?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const next = safeNextPath(
    typeof searchParams?.next === "string" ? searchParams.next : null
  );

  // Signed-out visitors have no choice to make here; the middleware already
  // bounces them, but guard directly too so the page never renders role
  // controls for a request with no user behind it.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  // Anyone who ALREADY has a role should never see the picker: send them
  // straight to their side of the app. This makes revisiting the URL harmless
  // - it can never flip an established account's role (the action enforces the
  // same guard on submit).
  const role = await getRole();
  if (role) redirect(role === "contractor" ? "/pro" : "/dashboard");

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <div className="card">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            Welcome to Hearth
          </h1>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            One last thing: how will you be using it?
          </p>
        </div>

        <div className="space-y-3">
          <form action={chooseRoleAction}>
            <input type="hidden" name="role" value="homeowner" />
            {next && <input type="hidden" name="next" value={next} />}
            <button className="w-full rounded-2xl border border-stone-200 bg-white px-5 py-4 text-left transition hover:border-bark-500 hover:shadow-md dark:border-white/10 dark:bg-stone-800">
              <span className="block font-medium text-stone-900 dark:text-stone-100">
                I&apos;m a homeowner
              </span>
              <span className="mt-1 block text-sm text-stone-500 dark:text-stone-400">
                Keep up your home and find trusted local pros.
              </span>
            </button>
          </form>

          <form action={chooseRoleAction}>
            <input type="hidden" name="role" value="contractor" />
            {next && <input type="hidden" name="next" value={next} />}
            <button className="w-full rounded-2xl border border-stone-200 bg-white px-5 py-4 text-left transition hover:border-bark-500 hover:shadow-md dark:border-white/10 dark:bg-stone-800">
              <span className="block font-medium text-stone-900 dark:text-stone-100">
                I&apos;m a contractor
              </span>
              <span className="mt-1 block text-sm text-stone-500 dark:text-stone-400">
                Browse local jobs and win work near you.
              </span>
            </button>
          </form>
        </div>

        {/* OAuth users never saw a signup checkbox, so the agreement is
            restated here, split by role since each side agrees to different
            terms (homeowner: /terms, contractor: /pro-terms). Follows the
            "By continuing you agree to the ..." phrasing on the signup pages. */}
        <p className="mt-6 border-t border-stone-100 pt-4 text-center text-xs text-stone-500 dark:border-white/10 dark:text-stone-400">
          By choosing homeowner you agree to the{" "}
          <Link href="/terms" className="text-bark-700 hover:underline dark:text-stone-300">
            Terms
          </Link>
          ; by choosing contractor you agree to the{" "}
          <Link href="/pro-terms" className="text-bark-700 hover:underline dark:text-stone-300">
            Contractor Terms
          </Link>
          . Either way you agree to the{" "}
          <Link href="/privacy" className="text-bark-700 hover:underline dark:text-stone-300">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
