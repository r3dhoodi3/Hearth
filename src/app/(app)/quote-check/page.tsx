import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/auth";
import { hasPlus } from "@/lib/subscription";
import QuoteAnalyzer from "@/components/QuoteAnalyzer";

// Quote analyzer (Hearth Plus): the homeowner hands over a photo or
// the text of a contractor's quote, and Hearth reads it, checks the total and
// every line item against typical costs, flags anything padded or vague, and
// writes a negotiation message, all for a couple minutes of reading.
//
// Non-Plus homeowners get exactly one free check as a taste: if their credit
// (users.free_quote_used_at) is unused they see the page with a banner, and
// once it's spent they're back to the Plus pitch.
export default async function QuoteCheckPage() {
  const plus = await hasPlus();

  let freeTaste = false;
  if (!plus) {
    const supabase = await createClient();
    // getVerifiedUser(): the same live auth-server check, shared through
    // React's cache() with the (app) layout's own verification instead of
    // opening a second round trip for this one row.
    const user = await getVerifiedUser();
    if (user) {
      const { data: row, error } = await supabase
        .from("users")
        .select("free_quote_used_at")
        .eq("id", user.id)
        .maybeSingle();
      // FAIL OPEN if the column isn't live yet (migration 0027 not run):
      // a brand-new user must never be told "you've used your free check"
      // when they never did. Pre-migration the burn can't be recorded, so a
      // user could get more than one free check: that generous failure is
      // honest; the old fail-closed redirect was a lie.
      freeTaste = error ? true : !!row && row.free_quote_used_at === null;
    }
    if (!freeTaste) redirect("/plus?reason=quote");
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Quote analyzer
        </h1>
        <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
          Upload a photo of a quote, or paste the text. Hearth checks every
          line, flags anything padded or vague, and drafts a message you can
          send back. Takes a minute. Know where you stand before you sign.
        </p>
      </header>

      {freeTaste && (
        <div className="card border-bark-100 bg-bark-50 text-center dark:border-bark-700/40 dark:bg-bark-700/30">
          <p className="text-sm text-bark-700 dark:text-stone-300">
            This one&apos;s on us. Your first quote check is free, Hearth Plus
            makes it unlimited. It only counts as used once an analysis
            actually succeeds, so a failed upload never burns it.
          </p>
        </div>
      )}

      <QuoteAnalyzer freeTaste={freeTaste} />
    </div>
  );
}
