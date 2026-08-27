import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { riskSaltIsConfigured, type SignalKind } from "./hash";
import {
  emptyFacts,
  scoreFromFacts,
  type RiskFacts,
  type RiskResult,
} from "./score";

// The database half of the trial-abuse score. Kept in its own file so
// src/lib/risk/score.ts stays pure and importable from a unit test: this module
// pulls in the service-role Supabase client, which is "server-only" and throws
// the moment anything outside a server context imports it.
//
// Everything here is BEST EFFORT. Each lookup that fails leaves its own fact at
// the harmless default rather than throwing, so a database hiccup - or a live
// database that has not run migration 0130 yet - degrades to "this account
// looks clean" rather than blocking a sale. See the fail-open note in
// src/lib/risk/decision.ts for why that is the right direction.

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Module-load health check. "We are running with no salt, so nothing is being
// recorded and every account scores clean" is exactly the kind of degradation
// that is invisible until somebody goes looking for a number that was never
// there. Say it once, at boot, in the place an operator will actually see it.
if (!riskSaltIsConfigured()) {
  console.error(
    "[risk] RISK_HASH_SALT is not configured. No trial-abuse signals will be " +
      "recorded and every account will score as clean. This is a go-live " +
      "blocker - see docs/GO-LIVE-WIRING.md."
  );
}

// Every read in this file is best-effort, and every one of them USED to swallow
// its error in silence. That is how a live database that never ran migration
// 0130 produces a score of 0 for everybody, forever, with nothing in the logs
// to say why. Failing open is still the right behaviour; failing open quietly
// is not.
function readRows(label: string, query: any): Promise<any[]> {
  return query
    .then((r: any) => {
      if (r.error) {
        console.error(`[risk] ${label} read failed:`, r.error.message ?? r.error);
        return [];
      }
      return r.data ?? [];
    })
    .catch((err: unknown) => {
      console.error(`[risk] ${label} read threw:`, err);
      return [];
    });
}

// The other accounts that share a HOUSEHOLD with this one (migration 0051):
// people who were invited to a property and accepted, plus whoever invited
// them. They are subtracted from the parcel and device links before either is
// scored.
//
// The reason is the most common false positive this system has: two adults, one
// house, one iPad, one wifi. The second one signs up, joins the household or
// claims the same address, and buys in the same sitting. Nothing about that is
// abuse - it is the flow the product asks people to follow - and household
// membership is the one piece of evidence we hold that says so positively.
async function householdPeerIds(
  admin: any,
  userId: string
): Promise<Set<string>> {
  const peers = new Set<string>();
  // The id is interpolated into a PostgREST filter string below, so refuse
  // anything that is not a bare UUID before it can reach that sink.
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return peers;
  try {
    // Rows where this user is either side of an accepted household membership.
    const mine = await readRows(
      "household_members (self)",
      admin
        .from("household_members")
        .select("property_id, member_user_id, invited_by")
        .eq("status", "active")
        .or(`member_user_id.eq.${userId},invited_by.eq.${userId}`)
        .limit(200)
    );
    const propertyIds = Array.from(
      new Set(
        mine
          .map((r: any) => r.property_id)
          .filter((id: unknown): id is string => typeof id === "string")
      )
    ).slice(0, 100);
    for (const row of mine) {
      if (row.member_user_id) peers.add(row.member_user_id);
      if (row.invited_by) peers.add(row.invited_by);
    }

    // Everybody else on those same properties: two adults invited to one home
    // are each other's household, not just the owner's.
    if (propertyIds.length > 0) {
      const siblings = await readRows(
        "household_members (siblings)",
        admin
          .from("household_members")
          .select("member_user_id, invited_by")
          .eq("status", "active")
          .in("property_id", propertyIds)
          .limit(500)
      );
      for (const row of siblings) {
        if (row.member_user_id) peers.add(row.member_user_id);
        if (row.invited_by) peers.add(row.invited_by);
      }
    }
  } catch (err) {
    console.error("[risk] householdPeerIds failed:", err);
  }
  peers.delete(userId);
  return peers;
}

// Gather the facts for one account.
export async function loadRiskFacts(
  userId: string,
  opts: { accountCreatedAt?: string | null } = {}
): Promise<RiskFacts> {
  const facts = emptyFacts();
  const admin = createAdminClient() as any;

  // Account age, from the caller's already-verified auth user. Not looked up
  // here: every call site (both checkout actions) has the User object in hand.
  if (opts.accountCreatedAt) {
    const created = Date.parse(opts.accountCreatedAt);
    if (Number.isFinite(created)) {
      facts.accountAgeMinutes = Math.max(
        0,
        Math.floor((Date.now() - created) / 60000)
      );
    }
  }

  // This account's own signals, and the accounts linked to it. Both are needed
  // for almost every fact below, so they run together.
  const [ownSignals, linked] = await Promise.all([
    readRows(
      "account_signals",
      admin
        .from("account_signals")
        .select("kind, value_hash, context")
        .eq("user_id", userId)
    ),
    readRows("linked_accounts", admin.rpc("linked_accounts", { p_user: userId })),
  ]);

  const own = ownSignals as Array<{
    kind: SignalKind;
    value_hash: string;
    context: string | null;
  }>;
  const links = linked as Array<{ user_id: string; kind: SignalKind }>;

  // Disposable inbox. The domain is stored hashed, so its disposability cannot
  // be re-derived from the row - it is stamped into `context` at capture time
  // by recordEmailSignals (src/lib/risk/signals.ts) instead.
  facts.disposableEmailDomain = own.some(
    (s) => s.kind === "email_domain" && (s.context ?? "").includes("disposable")
  );

  // Everything that is simply "does another account share this kind of value".
  const linkedIdsByKind = new Map<SignalKind, Set<string>>();
  for (const link of links) {
    if (!link?.user_id || !link?.kind) continue;
    const set = linkedIdsByKind.get(link.kind) ?? new Set<string>();
    set.add(link.user_id);
    linkedIdsByKind.set(link.kind, set);
  }
  const linkedOf = (kind: SignalKind): Set<string> =>
    linkedIdsByKind.get(kind) ?? new Set<string>();

  facts.emailNormCollision = linkedOf("email_norm").size > 0;
  facts.samePhoneAsOtherAccount = linkedOf("phone").size > 0;
  facts.sameCompanyNameAsOtherAccount = linkedOf("company_name").size > 0;
  facts.cardSharedWithOtherAccount = linkedOf("card").size > 0;

  // Household co-members are subtracted from the two links a family shares by
  // definition: the house and the device in the kitchen. Only looked up when one
  // of those links actually exists, so the ordinary account pays nothing for it.
  const householdSensitive =
    linkedOf("parcel").size > 0 || linkedOf("device").size > 0;
  const household = householdSensitive
    ? await householdPeerIds(admin, userId)
    : new Set<string>();
  const withoutHousehold = (ids: Set<string>): Set<string> =>
    new Set(Array.from(ids).filter((id) => !household.has(id)));

  // Two accounts on one parcel means something only when they are NOT a
  // household. When they are, it means the product worked.
  facts.sameParcelAsOtherAccount = withoutHousehold(linkedOf("parcel")).size > 0;

  // Device count is a TOTAL including this account, so the bands read the way
  // they are written ("5 accounts on one device", not "this one plus five").
  //
  // COOKIE ONLY. The fingerprint used to be unioned in here, which quietly
  // turned a cohort into a device: DeviceFingerprint.tsx hashes user agent,
  // screen size, timezone offset, language and core count, and on one popular
  // phone model in one metro area that is the SAME hash for thousands of
  // strangers. Five of them landing on Hearth in a week read as a five-account
  // device farm. The fingerprint now has its own much smaller weight below.
  const deviceLinked = withoutHousehold(linkedOf("device"));
  facts.accountsOnSameDevice = deviceLinked.size + 1;

  // IP is the one signal with a time window, because a residential address
  // recycles: the person on this IP three months ago is very likely somebody
  // else entirely. 7 days is short enough that a DHCP lease or a coffee shop
  // has not turned over, and long enough to catch a farm run over a weekend.
  const ipHashes = own
    .filter((s) => s.kind === "ip")
    .map((s) => s.value_hash)
    .slice(0, 25);
  if (ipHashes.length > 0) {
    const since = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
    const rows = await readRows(
      "account_signals (ip window)",
      admin
        .from("account_signals")
        .select("user_id")
        .eq("kind", "ip")
        .in("value_hash", ipHashes)
        .gte("last_seen", since)
        .limit(500)
    );
    if (rows.length > 0) {
      const recent = new Set<string>(rows.map((r: any) => r.user_id));
      recent.add(userId); // the count includes this account
      facts.accountsOnSameIpRecently = recent.size;
    }
  }

  // The fingerprint, on its own weak footing: it counts only when the SAME other
  // account also shows up on one of this account's recent IP addresses. One
  // coarse-attribute match is a cohort; a coarse-attribute match that is also on
  // your network is worth 10 points of corroboration. It never feeds the device
  // count and never feeds the flagged-neighbour check below.
  const fingerprintLinked = linkedOf("fingerprint");
  facts.fingerprintAndIpMatch = Array.from(fingerprintLinked).some((id) =>
    linkedOf("ip").has(id)
  );

  // Everything that depends on what the LINKED accounts have done. The cap
  // matches the LIMIT inside linked_accounts(uuid) so the two cannot disagree:
  // the RPC already returns at most 500 rows, ordered strongest link kind
  // first, so slicing lower here would silently drop evidence the database
  // deliberately kept.
  const allLinkedIds = Array.from(new Set(links.map((l) => l.user_id))).slice(
    0,
    500
  );
  if (allLinkedIds.length > 0) {
    const [flagRows, subRows] = await Promise.all([
      readRows(
        "abuse_flags",
        // Only flags nobody has resolved. cleared_at (migration 0130) is how a
        // dispute that was won, withdrawn, or filed by mistake stops counting
        // without the row being deleted, which is what keeps the history for
        // support. A cleared flag that still dragged a neighbour's score down
        // would make "resolved" mean nothing.
        admin
          .from("abuse_flags")
          .select("user_id, kind")
          .in("user_id", allLinkedIds)
          .is("cleared_at", null)
      ),
      readRows(
        "subscriptions",
        admin.from("subscriptions").select("user_id").in("user_id", allLinkedIds)
      ),
    ]);

    const flags = flagRows as Array<{ user_id: string; kind: string }>;
    const chargebackIds = new Set(
      flags.filter((f) => f.kind === "chargeback").map((f) => f.user_id)
    );
    // The +40 flagged-neighbour weight reads CHARGEBACK and MANUAL flags only.
    //
    // 'trial_abuse' is deliberately excluded. It is written when somebody
    // cancels inside their free trial, which is precisely what the product tells
    // people they may do ("cancelling before then costs nothing"), and it used
    // to be read into TWO separate facts off one row: this +40 and the
    // linkedToTrialCanceller +25. One honest person deciding Hearth was not for
    // them cost their spouse 65 points. A cancelled trial is not a chargeback,
    // and it is certainly not evidence about the neighbours.
    const flaggedIds = new Set(
      flags
        .filter((f) => f.kind === "chargeback" || f.kind === "manual")
        .map((f) => f.user_id)
    );
    // "Has held a membership" is read off the existence of a subscriptions row,
    // not off its status. That row survives cancellation on purpose (see
    // isProTrialEligible), which is exactly what makes it the right marker for
    // "this card has already had its free trial somewhere".
    const subscribedIds = new Set(
      (subRows as Array<{ user_id: string }>).map((s) => s.user_id)
    );

    // A linked trial-canceller counts only through a STRONG link: the same card,
    // the same device cookie, the same normalized email, the same phone number.
    // Not through a shared IP, where on carrier NAT the "link" is one of several
    // thousand strangers behind one egress address, and not through a shared
    // parcel or trade name, where the innocent explanation is the usual one.
    const STRONG_LINKS: SignalKind[] = ["card", "device", "email_norm", "phone"];
    const stronglyLinked = new Set<string>();
    for (const kind of STRONG_LINKS) {
      for (const id of linkedOf(kind)) stronglyLinked.add(id);
    }
    const trialCancellerIds = new Set(
      flags.filter((f) => f.kind === "trial_abuse").map((f) => f.user_id)
    );
    facts.linkedToTrialCanceller = Array.from(stronglyLinked).some((id) =>
      trialCancellerIds.has(id)
    );

    const cardLinked = linkedOf("card");
    facts.cardSharedWithUsedOrChargebackAccount = Array.from(cardLinked).some(
      (id) => subscribedIds.has(id) || chargebackIds.has(id)
    );

    // Fingerprint links are NOT in this set. hearth_fp is client-writable, so
    // letting it alone create a link to a flagged account would hand an attacker
    // a 40-point weapon to point at any visitor whose fingerprint they can
    // compute. deviceLinked is the httpOnly cookie only, and household
    // co-members have already been subtracted from it.
    facts.sharesIpOrDeviceWithFlaggedAccount = Array.from(
      new Set([...linkedOf("ip"), ...deviceLinked])
    ).some((id) => flaggedIds.has(id));
  }

  // How fast onboarding was finished. Only meaningful when we know when the
  // account was created, so the queries are skipped entirely otherwise.
  if (opts.accountCreatedAt) {
    const created = Date.parse(opts.accountCreatedAt);
    if (Number.isFinite(created)) {
      const [propertyRows, contractorRows] = await Promise.all([
        readRows(
          "properties (onboarding time)",
          admin
            .from("properties")
            .select("created_at")
            .eq("user_id", userId)
            .order("created_at", { ascending: true })
            .limit(1)
        ),
        readRows(
          "contractors (onboarding time)",
          admin
            .from("contractors")
            .select("created_at")
            .eq("user_id", userId)
            .order("created_at", { ascending: true })
            .limit(1)
        ),
      ]);
      const propertyAt = propertyRows[0]?.created_at ?? null;
      const contractorAt = contractorRows[0]?.created_at ?? null;
      const stamps = [propertyAt, contractorAt]
        .map((s) => (s ? Date.parse(s) : NaN))
        .filter((n) => Number.isFinite(n)) as number[];
      if (stamps.length > 0) {
        const first = Math.min(...stamps);
        facts.onboardingMinutesAfterSignup = Math.max(
          0,
          (first - created) / 60000
        );
      }
    }
  }

  return facts;
}

// Compute the score for one account, and by default store it. Returns the
// result either way; a failed write is logged and ignored, because account_risk
// is a record of a decision, not the decision itself.
//
// `persist: false` is for the two /plus pages, which run this only to decide
// which sentence to render. A page render is a GET, and a GET should not be
// writing rows on every refresh - the checkout action re-runs the same
// computation with persist on at the moment the decision actually costs
// somebody something, which is the moment worth having a record of.
export async function computeRisk(
  userId: string,
  opts: { accountCreatedAt?: string | null; persist?: boolean } = {}
): Promise<RiskResult> {
  const facts = await loadRiskFacts(userId, opts);
  const result = scoreFromFacts(facts);
  if (opts.persist === false) return result;

  try {
    const admin = createAdminClient() as any;
    const { error } = await admin.from("account_risk").upsert(
      {
        user_id: userId,
        score: result.score,
        level: result.level,
        reasons: result.reasons,
        computed_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
    if (error) {
      console.error("account_risk upsert failed:", error.message ?? error);
    }
  } catch (err) {
    console.error("account_risk upsert threw:", err);
  }

  return result;
}

// The two things trialDecision needs that are not part of the score itself.
//
//   override    a hand-written public.risk_overrides row, which wins outright in
//               both directions and short-circuits the whole computation. This
//               is the entire "admin surface": one insert from the Supabase SQL
//               editor (the statement is written out in the PASTE-ME file).
//
//   manualBlock a 'manual' abuse flag on THIS account, the only thing in the
//               system that refuses a sale. The score never does that on its
//               own - see the decision table in src/lib/risk/decision.ts.
//
// Best-effort like everything else here: an unreadable table means no override
// and no block, which is the permissive answer.
export async function loadEnforcementState(userId: string): Promise<{
  overrideAllowTrial: boolean | null;
  manualBlock: boolean;
}> {
  const none = { overrideAllowTrial: null, manualBlock: false };
  if (!userId) return none;

  try {
    const admin = createAdminClient() as any;
    const [overrideRows, flagRows] = await Promise.all([
      readRows(
        "risk_overrides",
        admin
          .from("risk_overrides")
          .select("allow_trial")
          .eq("user_id", userId)
          .limit(1)
      ),
      readRows(
        "abuse_flags (self)",
        // Same cleared_at rule as the neighbour read above, and it matters
        // more here: this one is a HARD BLOCK on checkout. A manual flag that
        // somebody has since resolved must stop blocking, or the only way to
        // un-block an account would be to delete the record that it was ever
        // blocked.
        admin
          .from("abuse_flags")
          .select("kind")
          .eq("user_id", userId)
          .eq("kind", "manual")
          .is("cleared_at", null)
          .limit(1)
      ),
    ]);

    const allowTrial = overrideRows[0]?.allow_trial;
    return {
      overrideAllowTrial: typeof allowTrial === "boolean" ? allowTrial : null,
      manualBlock: flagRows.length > 0,
    };
  } catch (err) {
    console.error("[risk] loadEnforcementState failed:", err);
    return none;
  }
}
