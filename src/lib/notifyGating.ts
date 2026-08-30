// Which notification kinds are a Hearth Plus perk on the email/SMS channels.
//
// Kept as a standalone, dependency-free module (no server-only, no Supabase)
// so the decision is a pure function that can be unit tested and so every
// sender shares one list instead of each cron remembering the rule. The
// enforcement itself lives in sendNotification (src/lib/notify.ts), the single
// door every send goes through, so a new cron cannot forget the gate.
//
// The rule: the in-app notification row is ALWAYS written, for everyone. What
// Plus buys a homeowner is having those same alerts and reminders pushed to
// them - email and SMS - instead of waiting in the bell. That is exactly what
// the /plus comparison table sells ("Proactive alerts: free = In-app, plus =
// All alerts, every channel").
//
// GATED (homeowner alerts and reminders - proactive nudges Hearth generates on
// its own schedule, nobody asked for them just now):
//   freeze / heat / high_wind / heavy_rain  weather alerts cron
//   maintenance_upcoming / maintenance_overdue  maintenance reminders cron
//   filter_reminder                          HVAC filter cron
//   seasonal_check                           seasonal triggers cron
//   insurance_renewal                        home-insurance renewal nudge cron
//   home_digest                              periodic home digest cron
//
// NOT GATED, on purpose:
//   - Transactional homeowner messages: a reply in a chat, a quote or invoice
//     arriving, an application update, a review request, a receipt, anything
//     security or money related. Someone acted and the other side needs to
//     know; that is not a perk.
//   - applicant_waiting: a pro paid real money to apply to a job this
//     homeowner posted, and ghost protection refunds them after silence. That
//     is an update on the homeowner's own posting, not a proactive nudge.
//   - renewal_reminder / annual_notice / renewal_acknowledgment: auto-renewal
//     billing notices. These exist to satisfy the auto-renewal disclosure
//     laws, they are sent to people who are already paying (on either side of
//     the marketplace), and withholding one to sell an upgrade would be both
//     unlawful and indefensible. Never gate a billing notice.
//   - Every PRO-side kind (new_lead, apply_receipt, aging_deal,
//     applicant/weekly digests, winback credit, first-apply guarantee...).
//     Pro alerts have their own cold-start story (COLD_START_FREE_ALERTS) and
//     their own membership; this gate is the homeowner Plus gate only.
export const PLUS_GATED_NOTIFICATION_KINDS: ReadonlySet<string> = new Set([
  "freeze",
  "heat",
  "high_wind",
  "heavy_rain",
  "maintenance_upcoming",
  "maintenance_overdue",
  "filter_reminder",
  "seasonal_check",
  "insurance_renewal",
  "home_digest",
]);

// Whether this kind's email/SMS channels are a Plus perk.
export function isPlusGatedKind(kind: string): boolean {
  return PLUS_GATED_NOTIFICATION_KINDS.has(kind);
}

// The one decision sendNotification makes about the outbound channels.
//
// `plusStatus` is deliberately three-valued rather than a boolean:
//   "plus"    - the recipient (or the owner of the home they're on) is a
//               member. Send on every channel.
//   "free"    - positively confirmed no live membership. In-app only for a
//               gated kind.
//   "unknown" - the lookup itself failed.
//
// FAILS CLOSED on "unknown", which is the opposite of how this file's
// neighbours treat a broken lookup. The email opt-out check in notify.ts
// falls OPEN because that gate protects against spamming someone, and the
// safest thing to do when unsure is still to deliver a message with an
// unsubscribe link in it. This gate is different: it is a PAID gate, and
// falling open here hands out the exact perk the /plus page charges for every
// time a subscriptions read hiccups - a bug that gets more generous the worse
// the outage. The recipient loses nothing that matters, because the in-app
// notification row is written either way and the bell is the product's
// authoritative channel; they just don't get the push.
export function shouldSendOutboundChannels(
  kind: string,
  plusStatus: "plus" | "free" | "unknown"
): boolean {
  if (!isPlusGatedKind(kind)) return true;
  return plusStatus === "plus";
}

// ---------------------------------------------------------------------------
// Web push (the phone's lock screen)
// ---------------------------------------------------------------------------
//
// Push is a THIRD channel alongside email and SMS, and it plays by different
// rules on purpose:
//
//   - It is FREE for everyone, on both sides of the marketplace. It costs
//     Hearth nothing per message (the browser's own push service delivers it),
//     so there is no cost to gate behind Hearth Plus. What Plus sells on the
//     alerts is email and SMS, and that is untouched: isPlusGatedKind above
//     still governs those two and only those two.
//   - There is no TCPA equivalent for push. Permission is granted by the
//     person, in their own browser, on a tap, and the browser takes it away
//     again in one setting. The only preference layered on top of that is
//     users.notification_prefs.push_opt_out.
//
// An ALLOWLIST, not a denylist. A push notification interrupts someone: it
// lights up a lock screen and buzzes a pocket. The default for a NEW kind must
// therefore be "no push" until somebody decides it earns one, which is what an
// allowlist gives and a denylist does not.
//
// What earns a buzz: something a PERSON just did that the recipient is waiting
// on, plus the safety alerts that are time-critical by definition.
export const PUSH_NOTIFICATION_KINDS: ReadonlySet<string> = new Set([
  // Someone sent a message in a thread. The single most-asked-for one.
  "message",
  // A homeowner asked this pro for a quote directly, and the pro's answer.
  "direct_request",
  "direct_accepted",
  "direct_declined",
  // A quote or an invoice arrived, or an invoice got signed. Money moments.
  "quote",
  "quote_sent",
  "invoice",
  "invoice_sent",
  "invoice_signed",
  // A job matching this pro's trade and area was just posted. Speed to lead is
  // the whole pro-side product, so this is the pro equivalent of "message".
  "new_lead",
  // The homeowner closed the job out (the pro won or lost it).
  "job_closed",
  // A review landed on a pro's profile, or a homeowner was asked for one.
  "new_review",
  "review_request",
  // Weather and safety. These are the two cases where a few hours of delay is
  // the difference between "drip your faucets tonight" and a burst pipe.
  "freeze",
  "heat",
  "high_wind",
  "heavy_rain",
  "recall",
]);

// Everything else is in-app (and email/SMS) only. Named here rather than left
// implicit so the reasoning is written down somewhere: the digests
// (home_digest, weekly_digest, support_digest), the maintenance and seasonal
// reminders, the billing and renewal notices, the referral and winback
// credits, the compliance nudges. None of them is worth waking a phone for,
// and several of them fire from crons at whatever hour the scheduler runs.

// Should this kind be pushed to the person's device at all?
export function isPushKind(kind: string): boolean {
  return PUSH_NOTIFICATION_KINDS.has(kind);
}

// Quiet hours, but only for the kinds nobody asked for just now.
//
// The SMS path in src/lib/notify.ts refuses to text between 9pm and 8am,
// because TCPA says so. Push is not SMS and that statute does not reach it, so
// this is a product decision rather than a legal one, and it deliberately does
// NOT copy the SMS rule wholesale:
//
//   - A cron-generated alert at 3am is a buzz nobody asked for at an hour
//     nobody wants. Those are held.
//   - A MESSAGE from a real person at 9:05pm is the entire feature. Holding it
//     would mean building push notifications that do not notify, which is
//     exactly the complaint this was built to fix. Those go through.
//
// The in-app notification row is written either way, so a held push loses no
// information; the person sees it on the bell the next time they open Hearth.
export const PUSH_QUIET_HOURS_KINDS: ReadonlySet<string> = new Set([
  "freeze",
  "heat",
  "high_wind",
  "heavy_rain",
  "recall",
]);

// Same window and the same single-metro hardcoded timezone as sendSms: every
// launch-area home is in Orange County. When Hearth launches a second metro
// this needs to become per-recipient, in both places at once.
export const PUSH_QUIET_START_HOUR = 21;
export const PUSH_QUIET_END_HOUR = 8;

// `hour` is the recipient's local hour, 0-23. Passed in rather than read here
// so this stays a pure function the tests can drive; src/lib/push.ts computes
// it with the same Intl.DateTimeFormat call sendSms uses.
export function isPushHeldForQuietHours(kind: string, hour: number): boolean {
  if (!PUSH_QUIET_HOURS_KINDS.has(kind)) return false;
  if (!Number.isFinite(hour)) return true;
  return hour < PUSH_QUIET_END_HOUR || hour >= PUSH_QUIET_START_HOUR;
}
