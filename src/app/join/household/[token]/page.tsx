import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeNextPath } from "@/lib/safeNext";

export const metadata: Metadata = {
  title: "Join a home",
  description: "Join a household on Hearth.",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RedeemRow = {
  ok: boolean;
  property_id: string | null;
  member_id: string | null;
  already_member: boolean | null;
  reason: string | null;
};

// Public shell (added to the middleware's public-route list) so a signed-out
// scanner sees the sign-in-or-sign-up chooser below instead of the generic
// middleware bounce - the owner explicitly wants BOTH paths offered here,
// not just a redirect to /signin. Once signed in, this same route redeems
// the token via redeem_household_invite_token() (migration 0095) under the
// caller's own session. Every open of this page also stamps the one-time
// scan-grace extension (migration 0097) before any of that, signed in or
// not.
export default async function JoinHouseholdPage(
  props: {
    params: Promise<{ token: string }>;
  }
) {
  const params = await props.params;
  const token = params.token;
  const nextPath = safeNextPath(`/join/household/${token}`);
  const nextQuery = nextPath ? `?next=${encodeURIComponent(nextPath)}` : "";

  // Scan-grace stamp (migration 0097): runs on every open of this page,
  // BEFORE the signed-in/signed-out branch below, so a signed-out scanner's
  // 30 minute setup window starts the moment they open the link, not only
  // after they finish creating an account. Best-effort and silent either
  // way: whether this matches a row or not, the redeem step (or the
  // chooser, for a signed-out visitor) still runs the same either way, and
  // its own honest expired/invalid state is what the person actually sees
  // if the token turns out to be dead.
  if (UUID_RE.test(token)) {
    const admin = createAdminClient();
    const nowIso = new Date().toISOString();
    const graceExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    // Single conditional update: scanned_at is null AND expires_at > now()
    // must BOTH hold, so a repeat open (scanned_at already set) can never
    // re-extend the window, and an already-expired token can never be
    // revived by opening the link after the fact. See 0097's header for the
    // full threat model.
    await admin
      .from("household_invite_tokens")
      .update({ scanned_at: nowIso, expires_at: graceExpiresAt })
      .eq("token", token)
      .is("scanned_at", null)
      .gt("expires_at", nowIso);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
        <div className="card text-center">
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            Join a home on Hearth
          </h1>
          <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
            Someone shared a QR code inviting you to share day to day access
            to their home. Sign in or create a free account to continue -
            you&apos;ll land right back here afterward.
          </p>

          {/*
            Hearth is a web app with no installable app to "download", so the
            new-here path is account creation, not an app-store link.
            Opening this page already stamped the scan-grace extension above
            (migration 0097), so this visitor now has a 30 minute window to
            finish signup and onboarding, not just the code's original 5
            minutes. If they still take longer than that, they'll see the
            honest "ask for a fresh code" state below instead of a false
            success - that's fine and expected.
          */}
          <Link
            href={`/homeowner-signup${nextQuery}`}
            className="btn-primary mt-6 block w-full"
          >
            Create your account
          </Link>
          <Link
            href={`/signin${nextQuery}`}
            className="btn-secondary mt-3 block w-full"
          >
            Already have an account? Sign in
          </Link>
        </div>
      </main>
    );
  }

  if (!UUID_RE.test(token)) {
    return <InvalidState />;
  }

  const { data, error } = await supabase.rpc("redeem_household_invite_token", {
    p_token: token,
  });
  const row = (Array.isArray(data) ? data[0] : data) as RedeemRow | undefined;

  if (error || !row || !row.ok) {
    return <InvalidState reason={row?.reason ?? null} />;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <div className="card text-center">
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          You&apos;re in
        </h1>
        <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
          You&apos;re in. You now share this home.
        </p>
        <Link href="/dashboard" className="btn-primary mt-6 block w-full">
          Go to your home
        </Link>
      </div>
    </main>
  );
}

// Honest failure state. The heading and CTA stay the same regardless of
// cause (an expired code and an invalid one look identical to the person
// holding the phone), with a short, true subtext when we know more - a full
// home isn't fixed by a fresh code, so it gets its own line instead of
// promising a retry will help.
function InvalidState({ reason }: { reason?: string | null }) {
  const subtext =
    reason === "home_full"
      ? "This home already has its maximum number of members. Ask the owner to remove someone, or ask them for a fresh code once there's room."
      : reason === "rate_limited"
        ? "Too many attempts just now. Wait a minute, then ask for a fresh code."
        : "This code has expired or isn't valid anymore. QR codes on Hearth refresh every 5 minutes.";

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <div className="card text-center">
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          This code isn&apos;t working
        </h1>
        <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">{subtext}</p>
        <p className="mt-4 text-sm text-stone-500 dark:text-stone-400">
          Ask for a fresh code.
        </p>
      </div>
    </main>
  );
}
