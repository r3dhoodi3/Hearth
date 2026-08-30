// Pure decision helpers for the batched job-post fan-out in
// src/lib/proAlerts.ts.
//
// They live in their own dependency-free module (no server-only, no Supabase,
// no next/*) for the same reason src/lib/notifyGating.ts does: the rules that
// decide who gets what are exactly the part worth unit testing, and importing
// proAlerts.ts from a test would drag in the service-role client and the
// "server-only" guard.
//
// THE SEMANTICS THESE MUST MATCH: sendNotification() in src/lib/notify.ts, on
// the single-recipient path. The fan-out replaces only its INSERT (one bulk
// insert for every recipient, instead of one query per recipient inside a
// server action the homeowner is waiting on); the email/SMS half still runs
// through notify.ts's own sendOutboundChannels(). What is restated here is the
// caller-side contact/opt-out shaping that proAlerts used to do inline, one
// user at a time, against a per-user read.

// The subset of a users row the fan-out reads for a recipient. All optional:
// a row can be missing entirely (deleted user, read that came back short), and
// notification_prefs is a jsonb column that may be null or shaped differently
// on an older database.
export type AlertRecipientRow = {
  email?: string | null;
  phone?: string | null;
  sms_consent?: boolean | null;
  notification_prefs?: { email_opt_out?: boolean | null } | null;
};

// One recipient's resolved outbound plan: what sendOutboundChannels should be
// handed for them.
export type AlertOutbound = {
  userId: string;
  email: string | null;
  phone: string | null;
  // Must be exactly true for the SMS channel to fire. See the TCPA note atop
  // src/lib/notify.ts: anything else is "no consent on file".
  smsConsent: boolean;
  // The recipient's own CAN-SPAM opt-out, already read in the batch so
  // sendEmail does not have to query for it per user. undefined means we had
  // no row for them at all, which sendEmail treats as unknown and falls open
  // on - the same outcome as its own lookup failing, which is what happened
  // before this was batched.
  emailOptOut: boolean | undefined;
};

// Turns the batched users read into per-recipient outbound plans.
//
// Recipients with nothing to send on are dropped rather than returned with two
// nulls, mirroring sendOutboundChannels' own "no email and no phone, nothing to
// do" early return. The in-app notification row is written for EVERY target
// regardless - that happens in the bulk insert, not here - so being dropped
// from this list never costs anyone their notification.
export function buildAlertOutbound(
  userIds: readonly string[],
  opts: {
    // The fan-out-cannon gate (migration 0093). When false, no contact details
    // are handed over at all, which is how proAlerts has always held email and
    // SMS back without teaching this file anything about Resend or Twilio.
    externalChannels: boolean;
    rowByUser: ReadonlyMap<string, AlertRecipientRow>;
    // contractors.contact_phone, which is the number a pro actually gave us
    // during onboarding; users.phone is only the fallback. Reading users.phone
    // alone would mean no pro ever gets a text.
    contactPhoneByUser: ReadonlyMap<string, string>;
  }
): AlertOutbound[] {
  if (!opts.externalChannels) return [];

  const out: AlertOutbound[] = [];
  for (const userId of userIds) {
    const row = opts.rowByUser.get(userId);
    const email = row?.email ?? null;
    const phone = opts.contactPhoneByUser.get(userId) ?? row?.phone ?? null;
    if (!email && !phone) continue;
    out.push({
      userId,
      email,
      phone,
      smsConsent: row?.sms_consent === true,
      emailOptOut: row ? row.notification_prefs?.email_opt_out === true : undefined,
    });
  }
  return out;
}

// The in-app notification rows for a bulk insert: one per target, identical
// payload apart from user_id. Same column set and same null handling as the
// single-row insert in sendNotification.
export function buildAlertNotificationRows(
  userIds: readonly string[],
  payload: { kind: string; title: string; body?: string | null; url?: string | null }
): {
  user_id: string;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
}[] {
  return userIds.map((userId) => ({
    user_id: userId,
    kind: payload.kind,
    title: payload.title,
    body: payload.body ?? null,
    url: payload.url ?? null,
  }));
}

// CR5#6: same-pro new-lead alerts posted close together collapse into one
// notification instead of a fresh ping per job - a pro who gets three
// separate "New X job" pushes in five minutes on a job site reads that as
// noise, not urgency. proAlerts.ts anchors the window to each pro's most
// recent "new_lead" row's own created_at (a fixed window from the FIRST
// alert, not a sliding one) so a slow trickle across a whole day still gets
// its own notification each time - only alerts landing close together
// collapse. This module never touches the clock or the database: it decides
// the fan-out shape from a plain title, given by the caller.

export const ALERT_COLLAPSE_WINDOW_MS = 10 * 60 * 1000;

// Turns a previous "new_lead" notification title into the next collapsed
// count: the very first collapse turns a single-job title into "2 new jobs
// in your trades"; a title already in that shape just increments.
export function nextCollapsedAlertTitle(previousTitle: string): string {
  const m = /^(\d+) new jobs in your trades$/.exec(previousTitle.trim());
  const count = m ? parseInt(m[1], 10) + 1 : 2;
  return `${count} new jobs in your trades`;
}

// The body that goes with a collapsed title, kept in lockstep with it (the
// count in one must always match the count in the other).
export function collapsedAlertBody(title: string): string {
  const m = /^(\d+) new jobs in your trades$/.exec(title);
  const count = m ? m[1] : "Multiple";
  return `${count} new jobs just posted in your trades. Check the board to apply.`;
}

export type CollapsedAlertUpdate = {
  userId: string;
  title: string;
  body: string;
};

export type AlertFanoutPlan = {
  // Targets with no recent "new_lead" row: get the normal bulk insert.
  freshTargets: string[];
  // Targets with one inside the collapse window: their existing row gets
  // updated in place instead of a second row going in.
  collapsedUpdates: CollapsedAlertUpdate[];
};

// Splits this posting's target ids into the fresh-insert group and the
// collapsed-update group, given which targets already have a recent
// "new_lead" row (proAlerts.ts queries that; this only decides what to do
// with the answer). recentTitleByUser should already be narrowed to at most
// one row per user - the newest one inside the window - before calling this.
export function planAlertFanout(
  targetIds: readonly string[],
  recentTitleByUser: ReadonlyMap<string, string>
): AlertFanoutPlan {
  const freshTargets: string[] = [];
  const collapsedUpdates: CollapsedAlertUpdate[] = [];
  for (const userId of targetIds) {
    const previousTitle = recentTitleByUser.get(userId);
    if (previousTitle === undefined) {
      freshTargets.push(userId);
      continue;
    }
    const title = nextCollapsedAlertTitle(previousTitle);
    collapsedUpdates.push({ userId, title, body: collapsedAlertBody(title) });
  }
  return { freshTargets, collapsedUpdates };
}
