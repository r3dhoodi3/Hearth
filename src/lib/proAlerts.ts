import { createAdminClient } from "@/lib/supabase/admin";
import { sendNotification, sendOutboundChannels } from "@/lib/notify";
import {
  buildAlertOutbound,
  buildAlertNotificationRows,
  planAlertFanout,
  ALERT_COLLAPSE_WINDOW_MS,
  type AlertRecipientRow,
} from "@/lib/proAlertBatch";
import { isMissingSchemaError } from "@/lib/dbErrors";
import { launchCityForZip } from "@/lib/serviceArea";
import { redactContact } from "@/lib/redact";
import {
  labelFor,
  JOB_CATEGORIES,
  TIMING_OPTIONS,
  COLD_START_FREE_ALERTS,
  PRO_LEADS_HREF,
} from "@/lib/constants";

// Hearth Pro perk: instant new-job alerts. When a homeowner posts a job, every
// contractor whose categories cover it AND who holds a live Pro membership gets
// pinged right away through sendNotification (in-app now, email/SMS too once
// the provider env vars are set). Free pros lose nothing: the job board and
// its realtime updates are untouched; members just don't have to watch it.
//
// COLD START: while COLD_START_FREE_ALERTS is on, the membership filter is
// skipped and EVERY category-matched contractor is alerted (state-matched
// where both sides have a state, mirroring 0046's null-safe locality rules).
// Flip the constant to restore members-only alerts; the membership path below
// stays intact behind it.
//
// Everything here is best-effort: any failure (missing table, migration lag,
// no matches) is logged and swallowed. Alerting must never break or slow the
// homeowner's posting flow.
//
// STILL ON THE BLOCKING PATH. The right answer is to run this after the
// response is sent, but Next 14 server actions have no after() - unstable_after
// arrives in Next 15 - and every alternative (a queue, a cron drain, an
// internal fetch to a route handler) is new infrastructure for a best-effort
// notifier. So the fix for now is to make it cheap rather than to move it:
// the fan-out below is batched down to two queries flat. Revisit as a Next 15
// follow-up, where wrapping the alertProsForNewLead() call site in after() is
// a one-line change and this file needs no edits at all.

// Sanity cap on the fan-out so one posting can't queue an unbounded pile of
// notification writes inside a server action. Unchanged.
const MAX_ALERTS = 200;

// How many outbound (email/SMS) sends run at once. This used to chunk
// sendNotification calls, which meant the in-app rows were written 20 at a
// time in 10 sequential waves - up to 200 inserts (400 queries once Resend is
// configured and each send re-read the recipient's prefs) with the homeowner's
// posting action blocked on all of them. The rows now go in one bulk insert
// and this only paces the HTTP calls to the providers, which are dormant until
// those env vars exist.
const ALERT_BATCH_SIZE = 20;

export type NewLeadAlertInput = {
  category: string;
  timing?: string | null;
  issue_description?: string | null;
  // Property's two-letter state, for the cold-start path's null-safe locality
  // check. Missing data never hides a pro (0046's rule).
  property_state?: string | null;
  // Property's ZIP, for the launch-city filter (0124). Same null-safe rule as
  // the state above: a ZIP that is not in one of the launch cities, or a pro
  // whose launch_cities the database hasn't got yet, never hides anyone.
  property_zip?: string | null;
  // Fan-out-cannon gate (migration 0093): when false, every pro still gets
  // the in-app notification row below, but email/SMS are held back by
  // simply not handing sendNotification any contact details - its own
  // "no email/phone, nothing to send" guards do the rest, so this file
  // never needs to know Resend/Twilio's specifics. Required, not optional:
  // an implicit default here previously fell open (any caller that forgot
  // to pass it got full email/SMS), so every call site must now name its
  // choice explicitly.
  externalChannels: boolean;
};

// Returns the user ids that were alerted (empty on any failure), so the caller
// can skip them in its own non-member nudge and nobody gets pinged twice.
export async function alertProsForNewLead(
  lead: NewLeadAlertInput
): Promise<Set<string>> {
  const alerted = new Set<string>();
  try {
    // The category lands inside a PostgREST .or() filter below, so only plain
    // slugs (every JOB_CATEGORIES value is one) may pass. Anything else would
    // corrupt the filter grammar, and no contractor lists it anyway.
    if (!/^[a-z0-9_-]+$/i.test(lead.category)) return alerted;

    const admin = createAdminClient();
    const externalChannels = lead.externalChannels;

    // COLD START: the same null-safe state predicate the JS filter below
    // applies, computed once up front so it can be pushed into the query
    // itself instead of pulling every category match nationwide just to
    // throw most of them away in JS.
    const propState =
      COLD_START_FREE_ALERTS
        ? (lead.property_state ?? "").trim().toUpperCase()
        : "";
    // Only a clean two-letter code is safe to splice into the raw .or()
    // filter string below (same reasoning as the category regex check
    // above: unvalidated text landing in PostgREST filter grammar can break
    // or redefine the filter). service_state itself is only ever written as
    // NULL or /^[A-Z]{2}$/ (see pro/actions.ts), so this also guarantees an
    // exact-match .eq behaves identically to the JS comparison it stands in
    // for. Anything else (property.state wasn't a clean code) just skips the
    // server-side narrowing - the unchanged JS filter below still runs on
    // the full category-matched set, so behavior stays identical either way.
    const propStateForQuery = /^[A-Z]{2}$/.test(propState) ? propState : "";

    // Pros whose services cover this job. Null categories means "takes
    // anything", matching how open_jobs_for_me() treats them. service_state is
    // fetched for the cold-start locality check, but the column ships in
    // migration 0046 and may not exist on this database yet: on the
    // missing-column fingerprint, retry without it and treat every pro's state
    // as unknown (which, per the null-safe rule, includes them all).
    // isMissingSchemaError, not a hand-rolled regex: PostgREST reports a
    // missing SELECT column as PGRST204 "schema cache" just as often as it
    // reports 42703, and the old code-42703-or-literal-name pattern here
    // missed that, silently swallowing the whole query (and every alert with
    // it) on a live DB without 0046 instead of falling back cleanly.
    // Which launch city this job actually sits in (0124), or null when the ZIP
    // is in none of them - null means "don't filter", exactly like an unknown
    // state above.
    const leadCity = launchCityForZip(lead.property_zip ?? "");

    type ContractorRow = {
      user_id: string | null;
      contact_phone?: string | null;
      service_state?: string | null;
      launch_cities?: string[] | null;
    };
    let contractors: ContractorRow[] = [];
    {
      let query = (admin as any)
        .from("contractors")
        .select("user_id, contact_phone, service_state, launch_cities")
        .not("user_id", "is", null)
        .or(`categories.is.null,categories.cs.{${lead.category}}`);
      // Server-side version of the COLD_START state filter below (the
      // membership path applies no state filter, same as before, so this
      // only ever runs alongside COLD_START_FREE_ALERTS). Only narrows the
      // result set - the unchanged JS filter further down still re-checks
      // every row, so this can only ever be a superset-safe prefilter, never
      // a source of a different outcome.
      if (propStateForQuery) {
        query = query.or(
          `service_state.is.null,service_state.eq.${propStateForQuery}`
        );
      }
      const res = await query.limit(1000);
      if (res.error) {
        if (!isMissingSchemaError(res.error)) throw res.error;
        // Retry without service_state OR launch_cities: either column may not
        // exist yet (pre-0046 / pre-0124 database), so neither selecting them
        // nor filtering on them is safe here. Every pro's state and city pick
        // is then treated as unknown, which the null-safe rules below already
        // include rather than exclude.
        const retry = await admin
          .from("contractors")
          .select("user_id, contact_phone")
          .not("user_id", "is", null)
          .or(`categories.is.null,categories.cs.{${lead.category}}`)
          .limit(1000);
        if (retry.error) throw retry.error;
        contractors = (retry.data ?? []) as ContractorRow[];
      } else {
        contractors = (res.data ?? []) as ContractorRow[];
      }
    }

    // SMS goes to the number the pro actually gave us: contractor onboarding
    // writes contractors.contact_phone and never touches users.phone, so
    // reading only users.phone below would mean no pro ever gets a text.
    // users.phone stays as the fallback for anyone who has one.
    const contactPhoneByUser = new Map<string, string>();
    for (const c of contractors) {
      if (c.user_id && c.contact_phone && !contactPhoneByUser.has(c.user_id)) {
        contactPhoneByUser.set(c.user_id, c.contact_phone);
      }
    }

    // COLD START: state-level locality, mirroring 0046's null-safe rules in
    // code: a pro is excluded ONLY when both the pro's service_state and the
    // property's state exist and differ. Missing data never hides anyone.
    // (The membership path keeps its original behavior: no state filter.)
    if (COLD_START_FREE_ALERTS) {
      contractors = contractors.filter((c) => {
        const svcState = (c.service_state ?? "").trim().toUpperCase();
        return !svcState || !propState || svcState === propState;
      });
    }

    // Launch-city locality (0124), mirroring in code the gate
    // open_jobs_for_me() and apply_to_lead() apply in SQL: don't text a pro
    // about a job they cannot see on the board or apply to. Applied on both
    // the cold-start and membership paths, because an alert for an
    // unappliable job is pure noise either way.
    //
    // Deliberately PERMISSIVE where the SQL gate is strict, exactly like the
    // state filter above: a pro is excluded ONLY when the job's ZIP resolves
    // to a launch city AND the row actually carries a launch_cities array that
    // omits it. A null/missing column (pre-0124 database, or the retry path
    // that dropped the column) or a ZIP that maps to no launch city excludes
    // nobody. This is a best-effort notifier, so the failure mode has to be an
    // extra alert, never a silently missed one.
    if (leadCity) {
      contractors = contractors.filter((c) => {
        const cities = c.launch_cities;
        if (!Array.isArray(cities)) return true;
        return cities.includes(leadCity);
      });
    }

    const candidateIds = Array.from(
      new Set(
        contractors
          .map((c) => c.user_id)
          .filter((id): id is string => Boolean(id))
      )
    );
    if (candidateIds.length === 0) return alerted;

    let targetIds: string[];
    if (COLD_START_FREE_ALERTS) {
      // COLD START: every category-matched (and state-compatible) pro gets the
      // alert, member or not, still under the fan-out sanity cap.
      targetIds = candidateIds.slice(0, MAX_ALERTS);
    } else {
      // Live Pro memberships among the candidates. Same liveness rules as
      // hasProPlan(): a pro_ plan, active or trialing, and not past a known
      // period end. The like() is only a coarse server-side prefilter (in SQL
      // LIKE the underscore is a single-character wildcard), so the real
      // startsWith check and the date check happen in code below.
      const { data: subs, error: subsError } = await (admin as any)
        .from("subscriptions")
        .select("user_id, plan, status, current_period_end")
        .in("user_id", candidateIds)
        .in("status", ["active", "trialing"])
        .like("plan", "pro_%");
      if (subsError) throw subsError;

      const now = Date.now();
      const memberIds: string[] = [];
      for (const sub of (subs ?? []) as {
        user_id: string;
        plan: string | null;
        current_period_end: string | null;
      }[]) {
        if (!sub.plan?.startsWith("pro_")) continue;
        if (
          sub.current_period_end &&
          new Date(sub.current_period_end).getTime() <= now
        )
          continue;
        if (!memberIds.includes(sub.user_id)) memberIds.push(sub.user_id);
        if (memberIds.length >= MAX_ALERTS) break;
      }
      targetIds = memberIds;
    }
    if (targetIds.length === 0) return alerted;

    // Contact details so the email/SMS channels can fire once their providers
    // are configured. There is no prefs toggle for these alerts today (the
    // notification_prefs keys are homeowner-facing), so recipients get them all
    // - but notification_prefs is selected here anyway because it carries the
    // CAN-SPAM email_opt_out flag that sendEmail otherwise re-reads once per
    // recipient. One .in() query for every recipient's row replaces up to
    // MAX_ALERTS of those single-row reads.
    const { data: users } = await admin
      .from("users")
      .select("id, email, phone, sms_consent, notification_prefs")
      .in("id", targetIds);
    const rowByUser = new Map<string, AlertRecipientRow>(
      ((users ?? []) as ({ id: string } & AlertRecipientRow)[]).map((u) => [
        u.id,
        u,
      ])
    );

    const categoryLabel = labelFor(JOB_CATEGORIES, lead.category);
    const timingLabel = lead.timing
      ? labelFor(TIMING_OPTIONS, lead.timing)
      : null;
    // Belt-and-suspenders: postJobAction already stores a redacted
    // description, but redact again here so this snippet is scrubbed of
    // contact info even if a future caller passes an unredacted description.
    const description = redactContact((lead.issue_description ?? "").trim());
    const snippet =
      description.length > 120 ? `${description.slice(0, 117)}...` : description;
    // CR5 remove #1: every alert used to end with "Heads up: the first pro to
    // reply usually wins the job." True, but stamping it on every single ping
    // manufactures exactly the response-speed anxiety pros repeatedly cite as
    // burning them out on Thumbtack/Angi (research-convenience-CR5.md). Worth
    // saying once, during onboarding - not here, on every job that posts.
    const body =
      [
        timingLabel ? `Timing: ${timingLabel}.` : null,
        snippet ? `"${snippet}"` : null,
      ]
        .filter(Boolean)
        .join(" ") || "A homeowner just posted a job that matches your services.";

    // ---- BATCHED FAN-OUT ----------------------------------------------------
    //
    // THIS IS THE BATCHED TWIN OF sendNotification() (src/lib/notify.ts). Its
    // per-recipient semantics must stay in lockstep with that function's:
    // the same notifications row is written for every target, and the same
    // opt-out rules decide the outbound channels. The ONLY thing restated here
    // is the insert. Everything after it - the Hearth Plus gate, the CAN-SPAM
    // email opt-out, the TCPA consent and quiet-hours checks - still runs
    // inside notify.ts, through sendOutboundChannels, so there is one copy of
    // those rules and not two. If you add a step to sendNotification, put it in
    // sendOutboundChannels or it will silently skip every job-post alert.
    //
    // Why: this runs inside the homeowner's posting server action, which waits
    // on it. Per-recipient it was 1 insert (plus a prefs read per recipient
    // once Resend is configured), so a 200-pro fan-out cost 200-400 queries in
    // 10 sequential waves. It is now 1 users read + 1 insert, flat.
    const payload = {
      kind: "new_lead",
      title: `New ${categoryLabel} job just posted`,
      body,
      url: PRO_LEADS_HREF,
    };

    // CR5#6: split the targets into a fresh-insert group and a
    // collapsed-update group before writing anything. Anchored to each pro's
    // most recent "new_lead" row's own created_at (a fixed window from the
    // FIRST alert, not a sliding one), so a slow trickle of postings across a
    // whole day still gets its own notification each time - only alerts
    // landing within ALERT_COLLAPSE_WINDOW_MS of each other collapse. The
    // decision itself (planAlertFanout) is pure and unit-tested in
    // proAlertBatch.test.ts; only the query and the writes live here.
    const collapseCutoff = new Date(
      Date.now() - ALERT_COLLAPSE_WINDOW_MS
    ).toISOString();
    const { data: recentRows } = await admin
      .from("notifications")
      .select("id, user_id, title, created_at")
      .eq("kind", "new_lead")
      .in("user_id", targetIds)
      .gte("created_at", collapseCutoff)
      .order("created_at", { ascending: false });
    // Newest row per user only: a pro can only be mid-window for one
    // collapsed notification at a time.
    const recentRowIdByUser = new Map<string, string>();
    const recentTitleByUser = new Map<string, string>();
    for (const row of (recentRows ?? []) as {
      id: string;
      user_id: string;
      title: string;
    }[]) {
      if (!recentTitleByUser.has(row.user_id)) {
        recentTitleByUser.set(row.user_id, row.title);
        recentRowIdByUser.set(row.user_id, row.id);
      }
    }
    const { freshTargets, collapsedUpdates } = planAlertFanout(
      targetIds,
      recentTitleByUser
    );

    // One insert for every FRESH in-app row. Postgres applies a multi-row
    // INSERT atomically, so this is all-or-nothing: on failure nobody has a
    // row yet, which is why the fallback below can safely re-send one at a
    // time. That fallback matters for the realistic failure - a single bad
    // user_id (a pro deleted between the two queries) failing the whole
    // statement - where per-row writes still deliver to everyone else,
    // exactly as before.
    if (freshTargets.length > 0) {
      const { error: insertError } = await admin
        .from("notifications")
        .insert(buildAlertNotificationRows(freshTargets, payload));

      if (insertError) {
        console.error(
          "pro new-lead alerts: bulk insert failed, falling back to per-recipient:",
          insertError.message ?? insertError
        );
        for (let i = 0; i < freshTargets.length; i += ALERT_BATCH_SIZE) {
          const batch = freshTargets.slice(i, i + ALERT_BATCH_SIZE);
          await Promise.all(
            batch.map(async (userId) => {
              const contact = rowByUser.get(userId);
              const sent = await sendNotification(admin, {
                ...payload,
                userId,
                // Withholding email/phone (rather than skipping the call) is
                // what keeps the in-app row firing even when
                // externalChannels is false - sendNotification always writes
                // it, and only reaches for email/SMS when it actually has
                // contact details to use.
                email: externalChannels ? contact?.email ?? null : null,
                phone: externalChannels
                  ? contactPhoneByUser.get(userId) ?? contact?.phone ?? null
                  : null,
                smsConsent: externalChannels && contact?.sms_consent === true,
              });
              if (sent) alerted.add(userId);
            })
          );
        }
      } else {
        for (const userId of freshTargets) alerted.add(userId);

        // Email and SMS stay per-recipient (each is its own provider HTTP
        // call), but they now run off the contact details and opt-out flags
        // already read in the batch above instead of a query per recipient.
        // Both channels are dormant until RESEND_API_KEY / TWILIO_* are set,
        // so today this loop is a handful of no-op returns. Still paced in
        // waves of ALERT_BATCH_SIZE so a configured provider isn't hit with
        // 200 concurrent requests.
        const outbound = buildAlertOutbound(freshTargets, {
          externalChannels,
          rowByUser,
          contactPhoneByUser,
        });
        for (let i = 0; i < outbound.length; i += ALERT_BATCH_SIZE) {
          const wave = outbound.slice(i, i + ALERT_BATCH_SIZE);
          await Promise.all(
            wave.map((r) =>
              sendOutboundChannels(
                {
                  ...payload,
                  userId: r.userId,
                  email: r.email,
                  phone: r.phone,
                  smsConsent: r.smsConsent,
                },
                { emailOptOut: r.emailOptOut }
              )
            )
          );
        }
      }
    }

    // Collapsed targets: update their existing row in place instead of
    // adding a second one, and mark it unread again (read_at: null) so "3
    // new jobs" actually surfaces even if the pro had already read the
    // first one. No outbound channel here on purpose: they were already
    // pinged by email/SMS inside this same window for an earlier job in
    // their trades - the etiquette this collapses toward is one ping per
    // window, not a second text a few minutes later for the update.
    for (let i = 0; i < collapsedUpdates.length; i += ALERT_BATCH_SIZE) {
      const wave = collapsedUpdates.slice(i, i + ALERT_BATCH_SIZE);
      await Promise.all(
        wave.map(async (u) => {
          const rowId = recentRowIdByUser.get(u.userId);
          if (!rowId) return;
          const { error } = await admin
            .from("notifications")
            .update({ title: u.title, body: u.body, read_at: null })
            .eq("id", rowId);
          if (!error) alerted.add(u.userId);
        })
      );
    }
  } catch (err) {
    console.error(
      "pro new-lead alerts:",
      err instanceof Error ? err.message : err
    );
  }
  return alerted;
}
