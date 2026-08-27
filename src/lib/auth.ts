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

// The fallback for when the real read below can't run (a database where
// migration 0120 hasn't been applied, a missing EXECUTE grant, a network
// blip). It is now a flat "yes, assume there is a password", and both halves
// of that are deliberate.
//
// WHY NOT user_metadata.password_set ANY MORE. That term used to be part of
// this OR. user_metadata is writable by the account's own browser - one
// supabase.auth.updateUser({ data: ... }) call replaces the whole object - so
// it was a security answer read out of a field the caller controls. It could
// not be forged INTO a wrong yes that mattered, but it could be wiped, and
// wiping it is the dangerous direction: an OAuth-only account that set a
// password through the recovery flow has the password stored and NO "email"
// identity added, so with the flag gone every remaining signal here reads
// false. hasPassword false is what lets deleteAccountAction and
// updateEmailAction accept "type your email address" INSTEAD of the current
// password (src/app/(app)/account/actions.ts:335, src/app/pro/profile/
// actions.ts:405). A borrowed session that can clear one metadata field could
// then delete the account without ever proving it knew the password.
//
// WHY THE UNKNOWN CASE IS "YES". A wrong yes costs someone a confusing form
// (they are asked for a password they may not have, and the account page
// offers "change" where it should offer "set"). A wrong no drops the proof of
// identity in front of account deletion and email change. Those are not
// comparable, so the unknown case fails closed: require the password.
//
// The identity signals are gone rather than kept as an early "yes", because
// they can only ever agree with this answer - there is no input for which they
// would return false and this function would still return true. The real
// answer, when it can be had, comes from realHasPassword() below reading
// auth.users.encrypted_password.
function heuristicHasPassword(): boolean {
  return true;
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
  // ?? and not ||: realHasPassword returns a real `false` for an account that
  // genuinely has no password, and that answer must stand. Only null - "the
  // read could not answer" - falls through to the fail-closed default.
  const hasPassword = real ?? heuristicHasPassword();

  return { hasPassword, provider };
}

export const getPasswordStatus = cache(async (): Promise<PasswordStatus> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return passwordStatusFor(user);
});
