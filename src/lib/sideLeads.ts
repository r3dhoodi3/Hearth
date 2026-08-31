import type { getSupabase } from "@/lib/lazySupabase";

// The browser client's type, taken from the lazy loader rather than imported
// from supabase-js, so this module keeps no runtime dependency on it (the
// import above is type-only and erased at compile time).
export type Browser = Awaited<ReturnType<typeof getSupabase>>;

// The lead ids that belong to ONE side of the account, newest first.
//
// WHY this exists: `messages` RLS (can_access_lead in 0007_messages.sql) lets
// a dual-role account (homeowner + pro) read rows on BOTH its home's leads and
// its business's leads. So any `messages` query keyed on sender_role alone,
// with no lead_id scoping, picks up the user's own OUTGOING business messages
// (sender_role: "contractor") on their HOMEOWNER side, and vice versa on the
// pro side. That exact hole produced two real, reported fake-notification
// bugs: a permanently stuck unread badge (fixed in UnreadProvider) and "new
// message" toasts from the user's own other side (fixed in
// NewMessageNotifier). Both now resolve their lead universe through this ONE
// helper so the badge and the toast cannot drift apart again.
//
// `cachedUid` is an optional mutable holder the caller keeps alive across
// polls so a contractor-side caller is not re-resolving auth.getUser() on
// every tick; the helper fills it on first use and reads it after that.
export async function myLeadIdsForRole(
  supabase: Browser,
  role: "homeowner" | "contractor",
  cachedUid?: { uid: string | null }
): Promise<string[]> {
  if (role === "homeowner") {
    // RLS-scoped to household membership (see chats/page.tsx's identical
    // note), so this is already exactly the user's own-home universe.
    const { data: props } = await supabase.from("properties").select("id");
    const propertyIds = (props ?? []).map((p: { id: string }) => p.id);
    if (!propertyIds.length) return [];
    // Newest first so callers that cap the list (realtime filter length,
    // `.in()` list size) keep the conversations most likely to receive the
    // next message.
    const { data: leads } = await supabase
      .from("contractor_leads")
      .select("id")
      .in("property_id", propertyIds)
      .order("created_at", { ascending: false });
    return (leads ?? []).map((l: { id: string }) => l.id);
  }
  // contractor: "contractors" RLS also allows reading OTHER contractors'
  // rows (any contractor related to a lead on a property you own - see
  // contractor_related_to_me() in 0069_contractors_rls_hardening.sql),
  // so it must be filtered to this user's own row by user_id explicitly
  // rather than relied on to self-scope.
  let uid = cachedUid?.uid ?? null;
  if (!uid) {
    const { data } = await supabase.auth.getUser();
    uid = data.user?.id ?? null;
    if (cachedUid) cachedUid.uid = uid;
  }
  if (!uid) return [];
  const { data: mine } = await supabase
    .from("contractors")
    .select("id")
    .eq("user_id", uid)
    .maybeSingle();
  if (!mine) return [];
  const { data: leads } = await supabase
    .from("contractor_leads")
    .select("id")
    .eq("contractor_id", mine.id)
    .order("created_at", { ascending: false });
  return (leads ?? []).map((l: { id: string }) => l.id);
}
