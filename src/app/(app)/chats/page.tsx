import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { labelFor, JOB_CATEGORIES } from "@/lib/constants";
import { extractQuote, formatUSDCents } from "@/lib/quotes";
import LeadChat from "@/components/LeadChat";
import MarkChatSeen from "@/components/MarkChatSeen";
import MarkChatsSeen from "@/components/MarkChatsSeen";
import AskHearth from "@/components/AskHearth";
import { getProactiveGreeting } from "@/lib/greeting";
import ReviewButton from "@/app/(app)/contractors/ReviewButton";
import { saveReviewAction } from "@/app/(app)/contractors/actions";
import {
  acceptQuoteAction,
  declineQuoteAction,
  signInvoiceAction,
} from "./actions";

// Homeowner-side "seen" cookie (kept separate from the contractor's).
const SEEN_COOKIE = "hearth_ho_chat_seen";

// The plain companion message sendQuoteAction posts alongside every structured
// quote ("Sent a quote: $X total"). Mirrors isQuoteCompanionBody in
// LeadChat.tsx (a "use client" module, so it can't be imported here). The
// regex fallback below must skip it: its "$X" is just an echo of the
// structured quote, and reading it as a standing price would keep showing the
// amount even after the quote itself is withdrawn.
const isQuoteCompanionBody = (body: string) => body.startsWith("Sent a quote:");

async function readSeenMap(): Promise<Record<string, string>> {
  try {
    return JSON.parse((await cookies()).get(SEEN_COOKIE)?.value || "{}");
  } catch {
    return {};
  }
}

async function markChatSeenAction(leadId: string) {
  "use server";
  const jar = await cookies();
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(jar.get(SEEN_COOKIE)?.value || "{}");
  } catch {
    map = {};
  }
  map[leadId] = new Date().toISOString();
  jar.set(SEEN_COOKIE, JSON.stringify(map), { path: "/" });
  revalidatePath("/chats");
}

// Fires when the inbox is opened, so the nav badge clears even on the default
// Ask Hearth pane where no single thread is selected. The badge clear itself
// happens client-side: MarkChatsSeen stamps `hearth:seen:<id>` in localStorage
// for every listed lead and LiveUnreadBadge takes the max of that and the seen
// cookie. This action deliberately does NOT write the per-thread seen cookie:
// stamping every lead id here wiped the per-thread "New" indicator on
// conversations the homeowner never opened. Only markChatSeenAction, fired for
// the thread actually on screen, may advance a thread's seen timestamp.
async function markAllChatsSeenAction(_leadIds: string[]) {
  "use server";
}

export default async function HomeownerChatsPage(
  props: {
    searchParams: Promise<{ lead?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  // getProactiveGreeting doesn't depend on the property lookup (or anything
  // else on this page) - run it alongside getActiveProperty instead of
  // stacking a round trip after the redirect check.
  const [property, greeting] = await Promise.all([
    getActiveProperty(),
    getProactiveGreeting(),
  ]);
  if (!property) redirect("/onboarding");
  const supabase = await createClient();

  // The homeowner's conversations are jobs where they've PICKED a pro. Open
  // postings with no chosen pro yet aren't chats - there's no one to message.
  //
  // contractor_leads has grown wide (budget/CRM/invoicing/wallet columns from
  // later migrations) but this page only ever reads id/category/
  // contractor_id/created_at plus the joined contractor name - everything
  // else (status, payout_amount, homeowner_*, issue_*, timing, paid, paid_at,
  // budget_range, property_id, ...) is unused here.
  const { data: leads } = await supabase
    .from("contractor_leads")
    .select("id, category, contractor_id, created_at, contractors(name)")
    .eq("property_id", property.id)
    .not("contractor_id", "is", null)
    .order("created_at", { ascending: false });

  const convos = leads ?? [];
  const seen = await readSeenMap();
  const nameOf = (l: any) => l.contractors?.name ?? "Sourcing a pro";

  // Latest message per conversation, for preview + unread.
  const ids = convos.map((l) => l.id);
  const lastByLead = new Map<string, any>();
  // The latest price each pro has quoted, in cents, so the homeowner can
  // compare. A structured quote (lead_quotes) is preferred when one exists;
  // the regex guess off plain chat text is only a fallback for threads that
  // never got one.
  const quoteByLead = new Map<string, number>();

  // "Ask Hearth" is a pinned assistant conversation, always available. It's the
  // default when there are no real (chosen-pro) conversations yet.
  const askSelected =
    !searchParams.lead || searchParams.lead === "ask-hearth";
  // Candidate pick from the active home's own conversation list. Finding it
  // here (before the messages/quotes fetch below) is safe: convos.sort()
  // further down only reorders the array, it never changes which lead
  // objects are in it, so the element `find` returns is identical either way.
  const selectedCandidate = askSelected
    ? null
    : (convos.find((l) => l.id === searchParams.lead) ?? null);
  // Notification deep links ("/chats?lead=X" from quote/message alerts) are
  // property-blind, but the list above only holds the ACTIVE home's
  // conversations. For a multi-home (Plus) user, a lead on another of their
  // homes would otherwise dead-end on the empty "Select a conversation" pane,
  // and its unread badge could never be cleared from the page the link opens.
  // Fall back to fetching the lead directly: RLS only returns leads on
  // properties this user can read, so a hit is safe to open even though it is
  // not in the active home's list.
  const needsCrossHomeLookup =
    !askSelected && !selectedCandidate && Boolean(searchParams.lead);

  // Previously unbounded: this pulled EVERY message ever sent across every
  // one of the owner's leads just to read off the newest one per lead (plus
  // the newest contractor price as a fallback below). A per-lead "give me
  // just the newest row" query needs a DISTINCT ON / lateral-join view or
  // RPC, which is out of lane for a page-level fix - see the note below.
  // Ordered created_at desc + a generous cap bounds the worst case (a user
  // with many long-running conversations) without truncating the realistic
  // case (a handful of leads, each with well under a thousand messages).
  // IDEAL FIX (cross-lane, needs a DB view/RPC): a
  // `select distinct on (lead_id) ...` view, or an RPC that returns one row
  // per lead_id ordered by created_at desc, so this is correct at any scale
  // instead of "generous enough in practice."
  const MESSAGES_SCAN_LIMIT = 2000;

  // None of these depend on each other - only on `ids` (already known)
  // and, for the cross-home lookup, on searchParams.lead - so they run as one
  // parallel wave instead of stacked round trips.
  const [msgs, structuredQuotes, crossHomeLead, allReadableLeads] = await Promise.all([
    ids.length
      ? supabase
          .from("messages")
          .select("lead_id, body, created_at, sender_role")
          .in("lead_id", ids)
          .order("created_at", { ascending: false })
          .limit(MESSAGES_SCAN_LIMIT)
          .then((r) => r.data)
      : Promise.resolve(null),
    // Structured quotes take priority: fetched alongside the plain-text scan
    // above, then overwrite any regex-based guess for that lead below.
    // Withdrawn quotes are excluded: the pro retracted that price, so it is
    // not their standing offer. Declined ones still count as the last price
    // the pro actually stated.
    // Same unbounded-fan-out shape as the messages query above, but far lower
    // volume in practice (one row per quote sent, not per chat message);
    // bounded for the same reason and with the same ideal-fix note.
    ids.length
      ? supabase
          .from("lead_quotes")
          .select("lead_id, total_cents, created_at")
          .in("lead_id", ids)
          .neq("status", "withdrawn")
          .order("created_at", { ascending: false })
          .limit(MESSAGES_SCAN_LIMIT)
          .then((r) => r.data)
      : Promise.resolve(null),
    needsCrossHomeLookup
      ? supabase
          .from("contractor_leads")
          .select("id, category, contractor_id, created_at, contractors(name)")
          // needsCrossHomeLookup already guarantees searchParams.lead is
          // truthy (Boolean(searchParams.lead) is part of that condition).
          .eq("id", searchParams.lead as string)
          .not("contractor_id", "is", null)
          .maybeSingle()
          .then((r) => r.data)
      : Promise.resolve(null),
    // Every lead id on this user's OWN homes, across ALL of them and
    // including leads with no pro currently assigned. The nav badge
    // (UnreadProvider) counts contractor messages on those leads, so the
    // badge clear on inbox open must stamp this same universe: stamping only
    // the active home's chosen-pro list left messages on other homes (or on
    // unassigned leads) permanently unread, a badge count the user could
    // never clear. Deliberately scoped to the user's readable properties
    // rather than every readable contractor_leads row: a dual-role
    // (homeowner + pro) account can also read leads where they are the
    // ASSIGNED CONTRACTOR, and stamping those from the homeowner inbox
    // silently cleared the contractor-side badge for threads they never
    // opened. The properties select is RLS-scoped (household membership
    // included), so its ids are exactly the owner-side universe; a user's
    // home count is small, so one .in() list is plenty. Note the Ask Hearth
    // assistant is not involved here at all: it lives in localStorage only
    // and never writes to the messages table.
    supabase
      .from("properties")
      .select("id")
      .then((r) => {
        const propertyIds = ((r.data ?? []) as { id: string }[]).map(
          (p) => p.id
        );
        if (!propertyIds.length) return null;
        return supabase
          .from("contractor_leads")
          .select("id")
          .in("property_id", propertyIds)
          .then((rr) => rr.data);
      }),
  ]);

  for (const m of msgs ?? []) {
    if (!lastByLead.has(m.lead_id)) lastByLead.set(m.lead_id, m);
    // Messages are newest first, so the first contractor price we see per lead
    // is that pro's most recent quote. Companion messages are skipped: their
    // amount belongs to a structured quote, which the pass below handles
    // (including excluding it once withdrawn).
    if (
      m.sender_role === "contractor" &&
      !isQuoteCompanionBody(m.body) &&
      !quoteByLead.has(m.lead_id)
    ) {
      const q = extractQuote(m.body);
      if (q != null) quoteByLead.set(m.lead_id, q * 100);
    }
  }
  const latestStructured = new Set<string>();
  for (const q of structuredQuotes ?? []) {
    if (latestStructured.has(q.lead_id)) continue;
    latestStructured.add(q.lead_id);
    quoteByLead.set(q.lead_id, q.total_cents);
  }

  // Pros who have sent a price, cheapest first, for the compare panel.
  const quoted = convos
    .filter((l) => quoteByLead.has(l.id))
    .map((l) => ({ id: l.id, name: nameOf(l), amount: quoteByLead.get(l.id)! }))
    .sort((a, b) => a.amount - b.amount);

  // Unread if the latest message is from the contractor and newer than last seen.
  const isUnread = (leadId: string) => {
    const last = lastByLead.get(leadId);
    if (!last || last.sender_role !== "contractor") return false;
    const seenAt = seen[leadId];
    // Compare as epoch millis so timestamp formats cannot skew the result.
    return (
      !seenAt ||
      new Date(seenAt).getTime() < new Date(last.created_at).getTime()
    );
  };

  convos.sort((a, b) => {
    const ta = lastByLead.get(a.id)?.created_at ?? a.created_at;
    const tb = lastByLead.get(b.id)?.created_at ?? b.created_at;
    return tb < ta ? -1 : tb > ta ? 1 : 0;
  });

  // askSelected/selectedCandidate/needsCrossHomeLookup and the cross-home
  // fetch itself were already resolved above (in parallel with the
  // messages/quotes queries); just fold the result in here.
  let selected = selectedCandidate;
  if (needsCrossHomeLookup && crossHomeLead) selected = crossHomeLead;

  // On phones the two-pane grid stacks, so tapping a conversation used to
  // render the thread below the list where it looked like nothing happened.
  // Instead we show one pane at a time: the list on the bare route, the thread
  // once ?lead= is in the URL. Desktop (md+) always shows both.
  const threadOpenOnMobile = Boolean(searchParams.lead);

  // The selected thread already has a pro assigned (accepted or closed; the
  // convos query above only includes leads with contractor_id set), so a
  // review is allowed here per leave_review() (0017) regardless of whether the
  // conversation itself has been closed yet. Look up any existing review so the
  // thread shows "Leave a review" or a quiet "You reviewed this pro" state.
  const { data: existingReview } = selected
    ? await supabase
        .from("reviews")
        .select("rating, comment")
        .eq("lead_id", selected.id)
        .maybeSingle()
    : { data: null };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Messages</h1>

      {/* Opening the inbox clears the nav badge, even on the Ask Hearth pane.
          The stamped set is the union of the listed conversations and every
          other lead on the user's own homes (other homes, unassigned leads;
          never pro-side leads a dual-role account is the assigned contractor
          on), so the clear covers the homeowner badge without touching the
          contractor one. localStorage-only: the server action stays a no-op
          and the per-thread "New" indicators (cookie based) are untouched. */}
      <MarkChatsSeen
        leadIds={Array.from(
          new Set([
            ...convos.map((l) => l.id),
            ...(allReadableLeads ?? []).map((l) => l.id),
          ])
        )}
        action={markAllChatsSeenAction}
      />

      {selected && (
        <MarkChatSeen leadId={selected.id} action={markChatSeenAction} />
      )}

      {/* Compare the prices pros have sent in chat, cheapest first. */}
      {quoted.length > 0 && (
        <div className="rounded-xl border border-stone-200 bg-white p-4 dark:border-white/10 dark:bg-stone-800">
          <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            Quotes from your pros
          </p>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            Prices your pros have sent in chat, lowest first.
          </p>
          <ul className="mt-2 space-y-1">
            {quoted.map((q) => (
              <li
                key={q.id}
                className="flex items-center justify-between gap-3"
              >
                <Link
                  href={`/chats?lead=${q.id}`}
                  className="truncate text-sm text-stone-700 hover:text-bark-700 hover:underline dark:text-stone-300"
                >
                  {q.name}
                </Link>
                <span className="flex shrink-0 items-center gap-2">
                  {quoted.length > 1 && q.amount === quoted[0].amount && (
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-green-700 dark:bg-green-950/40 dark:text-green-200">
                      Lowest
                    </span>
                  )}
                  <span className="font-semibold text-stone-900 dark:text-stone-100">
                    {formatUSDCents(q.amount)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-[280px_1fr]">
        {/* ---- Conversation list (hidden on phones while a thread is open) ---- */}
        <ul
          className={`${
            threadOpenOnMobile ? "hidden md:block" : ""
          } max-h-[40vh] divide-y divide-stone-100 overflow-y-auto rounded-xl border border-stone-200 bg-white dark:divide-white/10 dark:border-white/10 dark:bg-stone-800 md:h-[calc(100vh-13rem)] md:max-h-none`}
        >
          {/* Pinned assistant */}
          <li>
            <Link
              href="/chats?lead=ask-hearth"
              className={`block border-l-4 px-4 py-3 transition ${
                askSelected
                  ? "border-bark-600 bg-bark-50 dark:bg-bark-700/40"
                  : "border-transparent hover:bg-stone-50 dark:hover:bg-stone-700"
              }`}
            >
              <span className="truncate font-medium text-stone-900 dark:text-stone-100">
                Ask Hearth
              </span>
              <p className="truncate text-xs text-stone-500 dark:text-stone-400">
                Your home assistant
              </p>
            </Link>
          </li>

          {convos.map((l) => {
              const last = lastByLead.get(l.id);
              const isActive = selected?.id === l.id;
              const unread = isUnread(l.id);
              return (
                <li key={l.id}>
                  <Link
                    href={`/chats?lead=${l.id}`}
                    className={`block border-l-4 px-4 py-3 transition ${
                      isActive
                        ? "border-bark-600 bg-bark-50 dark:bg-bark-700/40"
                        : unread
                          ? "border-bark-500 bg-bark-50/60 hover:bg-bark-50 dark:bg-bark-700/30 dark:hover:bg-bark-700/40"
                          : "border-transparent hover:bg-stone-50 dark:hover:bg-stone-700"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`truncate ${
                          unread
                            ? "font-bold text-stone-900 dark:text-stone-100"
                            : "font-medium text-stone-900 dark:text-stone-100"
                        }`}
                      >
                        {nameOf(l)}
                      </span>
                      {unread ? (
                        <span className="shrink-0 rounded-full bg-bark-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                          New
                        </span>
                      ) : (
                        <span className="shrink-0 text-xs text-stone-500 dark:text-stone-400">
                          {labelFor(JOB_CATEGORIES, l.category)}
                        </span>
                      )}
                    </div>
                    <p
                      className={`truncate text-xs ${
                        unread ? "font-medium text-stone-800 dark:text-stone-200" : "text-stone-500 dark:text-stone-400"
                      }`}
                    >
                      {last
                        ? `${last.sender_role === "homeowner" ? "You: " : ""}${
                            last.body.startsWith("[img]")
                              ? "Photo"
                              : last.body
                          }`
                        : labelFor(JOB_CATEGORIES, l.category)}
                    </p>
                    {quoteByLead.has(l.id) && (
                      <span className="mt-1 inline-block rounded-full bg-bark-50 px-2 py-0.5 text-[10px] font-semibold text-bark-700 dark:bg-bark-700/40 dark:text-stone-300">
                        Quote {formatUSDCents(quoteByLead.get(l.id)!)}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>

          {/* ---- Open thread (the only pane on phones once one is picked) ---- */}
          {askSelected ? (
            <div
              className={`${
                threadOpenOnMobile ? "flex" : "hidden md:flex"
              } h-[calc(100dvh-13rem)] flex-col rounded-xl border border-stone-200 bg-white p-3 dark:border-white/10 dark:bg-stone-800 md:h-[calc(100vh-13rem)]`}
            >
              <Link
                href="/chats"
                className="mb-2 inline-flex w-fit shrink-0 items-center gap-1 text-sm font-medium text-bark-700 hover:underline md:hidden"
              >
                <span aria-hidden="true">←</span> All conversations
              </Link>
              <div className="min-h-0 flex-1">
                <AskHearth fill greeting={greeting} />
              </div>
            </div>
          ) : selected ? (
            <div
              className={`${
                threadOpenOnMobile ? "flex" : "hidden md:flex"
              } h-[calc(100dvh-13rem)] flex-col rounded-xl border border-stone-200 bg-white p-3 dark:border-white/10 dark:bg-stone-800 md:h-[calc(100vh-13rem)]`}
            >
              <Link
                href="/chats"
                className="mb-2 inline-flex w-fit shrink-0 items-center gap-1 text-sm font-medium text-bark-700 hover:underline md:hidden"
              >
                <span aria-hidden="true">←</span> All conversations
              </Link>
              {/* A pro is assigned on every thread here, so a review is always
                  allowed (leave_review only requires an assigned pro, not a
                  closed conversation): "Leave a review" while working
                  together, or a quiet "You reviewed this pro" once done. */}
              <div className="mb-2 flex flex-wrap shrink-0 items-center justify-between gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-white/10 dark:bg-stone-900">
                {existingReview ? (
                  <div className="flex items-center gap-2">
                    <span className="text-amber-500">
                      {"★".repeat(existingReview.rating)}
                      <span className="text-stone-300">
                        {"★".repeat(5 - existingReview.rating)}
                      </span>
                    </span>
                    <span className="text-xs text-stone-500 dark:text-stone-400">
                      You reviewed this pro
                    </span>
                  </div>
                ) : (
                  <span className="text-stone-500 dark:text-stone-400">
                    Worked with {nameOf(selected)}?
                  </span>
                )}
                <ReviewButton
                  leadId={selected.id}
                  contractorName={nameOf(selected)}
                  action={saveReviewAction}
                  existing={existingReview ?? undefined}
                  proProfilePath={`/p/${selected.contractor_id}`}
                  categoryLabel={labelFor(JOB_CATEGORIES, selected.category)}
                />
              </div>
              <div className="min-h-0 flex-1">
                <LeadChat
                  key={selected.id}
                  leadId={selected.id}
                  role="homeowner"
                  embedded
                  title={nameOf(selected)}
                  subtitle={labelFor(JOB_CATEGORIES, selected.category)}
                  jobTitle={labelFor(JOB_CATEGORIES, selected.category)}
                  contractorName={nameOf(selected)}
                  acceptQuoteAction={acceptQuoteAction}
                  declineQuoteAction={declineQuoteAction}
                  signInvoiceAction={signInvoiceAction}
                />
              </div>
            </div>
          ) : (
            <div
              className={`${
                threadOpenOnMobile ? "flex" : "hidden md:flex"
              } h-[60vh] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-stone-300 text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400 md:h-[calc(100vh-13rem)]`}
            >
              Select a conversation
              <Link
                href="/chats"
                className="text-sm font-medium text-bark-700 hover:underline md:hidden"
              >
                <span aria-hidden="true">←</span> All conversations
              </Link>
            </div>
          )}
        </div>
    </div>
  );
}
