import { cache } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

// The authenticated user, cached for the duration of a single server request.
// Uses getSession() (reads the validated session from the cookie, no network
// round-trip) instead of getUser() (which calls Supabase's auth server every
// time). The middleware already validates the session with getUser() on each
// request, and the database enforces real auth via RLS, so this is safe and
// much faster. React's cache() also dedupes it to once per render.
export const getUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.user ?? null;
});

// The user RE-VERIFIED against Supabase's auth server (a real network round
// trip), cached for the duration of a single server request. This is the
// getUser() above's stricter sibling: use it where the cookie's own claim is
// not good enough, and use it INSTEAD of calling supabase.auth.getUser()
// directly whenever more than one component in the same render needs the
// answer. Two components each calling supabase.auth.getUser() cost two
// sequential round trips, because the supabase client has no request cache of
// its own; React's cache() collapses them into one.
export const getVerifiedUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

export interface PasswordStatus {
  // False only when we're confident the account has no password at all: an
  // account created through Google (or any other OAuth provider) starts that
  // way, so the "change your password" form would be a dead end for them.
  //
  // Driven from the real auth.users.encrypted_password column via
  // current_user_has_password() (migration 0118) whenever that read succeeds -
  // NOT from the OAuth-identity guess below, which gets ghost-password
  // accounts wrong (a Google signup that later set a password through the
  // recovery flow keeps only its "google" identity, so the heuristic reads
  // hasPassword=false and wrongly offers the email-typed delete / no-reauth
  // email change). The heuristic is kept ONLY as a fallback for when that read
  // can't run, and only ever for the provider label.
  hasPassword: boolean;
  // The OAuth provider they actually signed up with ("google"), so the copy
  // can name it instead of guessing. Null when there isn't one.
  provider: string | null;
}

// Turn a raw provider slug into something we can put in a sentence.
const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  apple: "Apple",
  azure: "Microsoft",
  facebook: "Facebook",
  github: "GitHub",
};

export function providerLabel(provider: string | null): string {
  if (!provider) return "another service";
  return PROVIDER_LABELS[provider] ?? provider;
}

// The OAuth provider slug for the copy ("google"), read from the identity
// bookkeeping. Supabase keeps one identity row per sign-in method, so an
// account created with Google has a "google" identity. This is ONLY used to
// name the provider in a sentence - never to decide hasPassword, which now
// comes from the real column (see below). The email domain is deliberately
// ignored: it says nothing about how someone signed up.
function providerFor(user: User): string | null {
  const identities = user.identities ?? [];
  const providers = Array.isArray(user.app_metadata?.providers)
    ? (user.app_metadata.providers as string[])
    : [];
  return (
    identities.find((i) => i.provider !== "email")?.provider ??
    providers.find((p) => p !== "email") ??
    (user.app_metadata?.provider !== "email"
      ? (user.app_metadata?.provider as string | undefined) ?? null
      : null)
  );
}

// The old OAuth-identity guess, kept ONLY as a fallback for when the real
// read below can't run (e.g. migration 0118 not yet applied to this database).
// It errs toward "yes, they have one" - a wrong yes just shows today's form,
// while a wrong no would hide the password form from someone who needs it -
// EXCEPT for the ghost-password case (H3) it can't see: an OAuth-only user who
// set a password through the recovery flow gets the password stored but NO
// "email" identity added, so identities alone read false. The user_metadata
// .password_set flag was a partial patch (the reset page stamps it), but it
// only covers accounts that set a password AFTER that stamp existed, which is
// exactly why hasPassword has to come from the real column now.
function heuristicHasPassword(user: User): boolean {
  const identities = user.identities ?? [];
  const providers = Array.isArray(user.app_metadata?.providers)
    ? (user.app_metadata.providers as string[])
    : [];
  return (
    identities.some((i) => i.provider === "email") ||
    providers.includes("email") ||
    user.app_metadata?.provider === "email" ||
    user.user_metadata?.password_set === true
  );
}

// current_user_has_password() (migration 0118) isn't in the generated types,
// so the rpc name is passed through a narrow cast rather than any-typing the
// whole client.
type HasPasswordRpc = (
  fn: "current_user_has_password"
) => PromiseLike<{ data: unknown; error: unknown }>;

// The real answer: read auth.users.encrypted_password for THIS user through
// current_user_has_password() (SECURITY DEFINER, migration 0118). Returns null
// - never a guess - whenever the read can't produce a trustworthy answer, so
// the caller falls back to the heuristic instead of a confident wrong value.
//
// Called on the REQUEST-SCOPED client, not a bare createAdminClient(): the
// function keys off auth.uid(), and a bare service-role client carries NO user
// id (auth.uid() is null there), which would make the function return false
// for everyone - silently hiding the password form from real password users.
// The request-scoped client runs as the signed-in user, so auth.uid() resolves
// to them, and a missing EXECUTE grant (or a not-yet-applied 0118) comes back
// as an ERROR we can fall back on, never as a wrong `false`.
async function realHasPassword(): Promise<boolean | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await (supabase.rpc as unknown as HasPasswordRpc)(
      "current_user_has_password"
    );
    if (error || typeof data !== "boolean") return null;
    return data;
  } catch {
    return null;
  }
}

// Whether the signed-in account can sign in with a password today, plus which
// OAuth provider it uses for the copy. hasPassword comes from the real column
// (realHasPassword); the identity heuristic is only a fallback for when that
// read can't run, and only ever names the provider.
//
// Callers pass a user from supabase.auth.getUser(), never from getUser() above:
// the provider read has to be live. getPasswordStatus() below is the version
// for pages. Async now: the real read is a round trip.
export async function passwordStatusFor(
  user: User | null
): Promise<PasswordStatus> {
  if (!user) return { hasPassword: true, provider: null };

  const provider = providerFor(user);
  const real = await realHasPassword();
  const hasPassword = real ?? heuristicHasPassword(user);

  return { hasPassword, provider };
}

export const getPasswordStatus = cache(async (): Promise<PasswordStatus> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return passwordStatusFor(user);
});
