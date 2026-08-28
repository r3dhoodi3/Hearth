import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendNotification, sendOutboundChannels } from "@/lib/notify";
import { isMissingSchemaError } from "@/lib/dbErrors";
import { FOUNDER } from "@/lib/constants";

export const runtime = "nodejs";

// Daily job (Vercel Cron, see vercel.json) that tells the owner support mail is
// waiting.
//
// THE GAP THIS CLOSES. `support_messages` is written from two places - the
// signed-in Help page (src/app/(app)/account/help/actions.ts) and the public
// contact form (src/app/contact/actions.ts) - and read back from exactly one:
// src/lib/privacy.ts, the GDPR export/delete path, which is not an inbox.
// Nothing in the app has ever listed these rows. "Checking support" meant
// opening the Supabase table editor from memory, so a message could sit unread
// for as long as nobody thought to look.
//
// WHY A CRON AND NOT AN /admin/support PAGE. There is no admin gate anywhere in
// this repo: no isAdmin, no ADMIN_EMAILS, no is_admin column, no role claim, no
// /admin route tree. Building a page would have meant inventing an
// authorization scheme, and a hand-rolled admin gate protecting a table of
// other people's names, emails, phone numbers and free text is exactly the
// thing not to invent in passing. Pushing the digest OUT to an address the
// owner already controls needs no new authorization surface at all. When a real
// admin gate exists, an /admin/support page can be added beside this and the
// two can share the same query.
//
// Nothing here is user-triggerable and nothing here writes: worst case on any
// failure is that the digest does not go out today and the next run picks up
// the same backlog, because the backlog is defined by the message rows
// themselves, not by anything this job records.
//
// WHERE OTHER PEOPLE'S WORDS ARE ALLOWED TO GO. Two bodies, deliberately:
//
//   in-app (notifications.body)  a COUNT and a shape - "7 support messages
//                                waiting, 2 from pros". No name, no email, no
//                                message text.
//   email (Resend, to the owner) the detail: who wrote, from where, and a
//                                240-char excerpt.
//
// The reason is retention, not access. The recipient is the same person either
// way and `notifications` is RLS-scoped to its own user, but a notifications
// row has no TTL and nothing ever deletes it, so a per-day digest carrying
// senders' emails and free text builds a permanent, growing copy of the
// support inbox in a second table - readable by anything that ever reads
// notifications more broadly, and by anyone who ever gets into that one
// account. The email is transient, goes to an address the owner already
// controls, and is where the detail is actually useful.
//
// sendNotification cannot take two bodies (it passes its input straight to the
// outbound channels), so this writes the short row through it with no email
// address attached, then calls sendOutboundChannels directly with the detailed
// body. Same code path the batched fan-out in src/lib/proAlerts.ts uses, so
// the opt-out and kill-switch rules still apply to the email.

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  // Vercel Cron automatically sends "Authorization: Bearer <CRON_SECRET>" when
  // the CRON_SECRET env var is set. Also accept an explicit x-cron-secret header
  // for manual runs / other schedulers.
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const provided = bearer ?? req.headers.get("x-cron-secret");
  if (!provided) return false;
  // Constant-time compare (mirrors every other cron in this folder): only call
  // timingSafeEqual once both buffers are a confirmed equal length, since it
  // throws on a length mismatch.
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) return false;
  try {
    return timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}

// "Unhandled" is `status = 'open'`, the column support_messages has carried
// since migration 0024 with 'open' as its default. Nothing in the app ever
// moves a row off 'open' yet, so today every message counts - which is the
// honest state of things and exactly what the owner needs told. The moment a
// reply flow exists and starts writing 'replied' / 'closed', this query narrows
// on its own with no change here.
const OPEN_STATUS = "open";

// How many messages are spelled out in the digest. The count is always exact;
// past this many, the body says how many more are waiting rather than growing
// without limit. A digest nobody can finish reading is a digest nobody reads.
const MAX_LISTED = 25;

// Per-message excerpt length. Enough to triage ("my water heater is leaking and
// nobody called back") without turning the notification into a mail client.
const EXCERPT_CHARS = 240;

const DIGEST_KIND = "support_digest";

type SupportRow = {
  id: string;
  user_id: string | null;
  name: string | null;
  email: string | null;
  message: string | null;
  priority: boolean | null;
  created_at: string | null;
};

function fmtWhen(iso: string | null): string {
  if (!iso) return "unknown date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown date";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

// One line per message. Newlines inside a message body would break the line
// structure of the digest, so they collapse to spaces; the body is otherwise
// left alone, because a support message paraphrased is a support message
// misread.
function summarize(row: SupportRow): string {
  const who =
    row.email?.trim() ||
    row.name?.trim() ||
    // user_id present but no contact fields: a signed-in sender whose message
    // came through the Help page. The id is not printed - it is not something
    // the owner can act on from an email, and it does not belong in one.
    (row.user_id ? "a signed-in member" : "no contact details given");
  const source = row.user_id ? "in-app" : "contact form";
  const flag = row.priority ? " [PRO]" : "";
  const text = (row.message ?? "").replace(/\s+/g, " ").trim();
  const excerpt =
    text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}...` : text;
  return `${fmtWhen(row.created_at)}${flag} - ${who} (${source}): ${excerpt}`;
}

async function runCron(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  // Newest first, capped: this is a nudge to go look, not a mailbox sync.
  // MAX_LISTED + 1 is fetched deliberately so "and N more" can be honest about
  // whether there IS more without a second COUNT query.
  const select = "id, user_id, name, email, message, priority, created_at";
  let { data, error } = await (supabase as any)
    .from("support_messages")
    .select(select)
    .eq("status", OPEN_STATUS)
    .order("created_at", { ascending: false })
    .limit(MAX_LISTED + 1);

  // Graceful degradation, the same shape the rest of the app uses: a live
  // database without one of these columns (0038's `priority`, say) must still
  // produce a digest rather than a silent daily failure. Retry once with the
  // columns guaranteed present since 0024.
  if (error && isMissingSchemaError(error)) {
    console.error(
      "support-digest: falling back to the pre-0038 column set:",
      error.message ?? error
    );
    ({ data, error } = await (supabase as any)
      .from("support_messages")
      .select("id, user_id, name, email, message, created_at")
      .eq("status", OPEN_STATUS)
      .order("created_at", { ascending: false })
      .limit(MAX_LISTED + 1));
  }

  if (error) {
    console.error("support-digest: query failed:", error.message ?? error);
    // 200 with ok:false, matching the other crons: a non-2xx would make the
    // platform mark the run failed and retry, and there is nothing here worth
    // retrying inside the same minute.
    return NextResponse.json({ ok: false, error: "query failed" }, { status: 200 });
  }

  const rows = ((data as SupportRow[]) ?? []).filter(Boolean);
  // Silence is the correct output for an empty inbox. A daily "0 messages"
  // note is exactly the mail that trains someone to ignore the channel.
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, open: 0, notified: false });
  }

  const listed = rows.slice(0, MAX_LISTED);
  const more = rows.length > MAX_LISTED;

  // The owner's own account, matched on the published founder address in
  // src/lib/constants.ts. This is the whole authorization story: the digest
  // goes to one address the owner already controls, and it is looked up rather
  // than configured so there is no second place for it to drift.
  const ownerEmail = FOUNDER.email?.trim();
  if (!ownerEmail) {
    console.error(
      "support-digest: FOUNDER.email is blank, so there is nobody to send to"
    );
    return NextResponse.json({ ok: false, open: rows.length, notified: false });
  }

  const { data: owner, error: ownerError } = await (supabase as any)
    .from("users")
    .select("id")
    .eq("email", ownerEmail)
    .maybeSingle();
  if (ownerError) {
    console.error("support-digest: owner lookup failed:", ownerError.message ?? ownerError);
    return NextResponse.json({ ok: false, open: rows.length, notified: false });
  }
  if (!owner?.id) {
    // No Hearth account on the founder address. sendNotification is built
    // around a user row (the in-app bell, the CAN-SPAM unsubscribe token), so
    // there is nothing to send through. Loud log, successful run: the messages
    // are safe in the table and the next run retries once the account exists.
    console.error(
      "support-digest: no Hearth account matches the founder address, so no digest was sent"
    );
    return NextResponse.json({ ok: false, open: rows.length, notified: false });
  }

  // One digest per UTC day. The dup guard is the (user, kind, url) key the
  // renewal crons and the Stripe webhook already use, keyed on the day: a
  // re-run, a manual trigger, or a platform retry within the same day is a
  // no-op, and tomorrow's key re-arms it. Keying on the day rather than on the
  // message ids is deliberate - a backlog that is still unread tomorrow SHOULD
  // be raised again tomorrow.
  const dayKey = new Date().toISOString().slice(0, 10);
  // There is no admin inbox to link to yet (see the header note), so the link
  // points at the support page the owner can actually open. The digest body,
  // not the link, is what carries the information.
  const url = `/account/help?digest=${dayKey}`;

  const { data: already } = await (supabase as any)
    .from("notifications")
    .select("id")
    .eq("user_id", owner.id)
    .eq("kind", DIGEST_KIND)
    .eq("url", url)
    .limit(1)
    .maybeSingle();
  if (already) {
    return NextResponse.json({ ok: true, open: rows.length, notified: false });
  }

  const countLine =
    rows.length === 1
      ? "1 support message is waiting."
      : `${more ? `${MAX_LISTED}+` : rows.length} support messages are waiting.`;
  const tail = more
    ? `\n\nMore than ${MAX_LISTED} are open - this lists the newest ${MAX_LISTED}.`
    : "";
  const footer =
    "\n\nThese are read from the support_messages table; nothing in the app " +
    "marks them handled yet, so a message stays in this digest until its " +
    "status row is changed.";

  const title =
    rows.length === 1
      ? "1 support message is waiting"
      : `${more ? `${MAX_LISTED}+` : rows.length} support messages are waiting`;

  // THE STORED BODY: counts and shape only. Enough to decide whether to go
  // look right now, with nothing in it that belongs to the people who wrote
  // in. `priority` is the Pro flag (0038) and `user_id` says the message came
  // through the signed-in Help page rather than the public contact form -
  // both are triage facts about the backlog, not facts about a person.
  const proCount = rows.filter((r) => r.priority).length;
  const inAppCount = rows.filter((r) => r.user_id).length;
  const shape = [
    proCount > 0 ? `${proCount} from Pro members` : null,
    inAppCount > 0 ? `${inAppCount} from signed-in members` : null,
    rows.length - inAppCount > 0
      ? `${rows.length - inAppCount} from the contact form`
      : null,
  ].filter(Boolean);
  const storedBody =
    countLine +
    (shape.length > 0 ? `\n\n${shape.join(", ")}.` : "") +
    "\n\nWho wrote in and what they said is in the email, not here." +
    footer;

  // THE EMAILED BODY: the detail, which is what makes the digest actionable.
  const emailBody =
    `${countLine}\n\n` + listed.map(summarize).join("\n\n") + tail + footer;

  // No email address on this call: the in-app row is written, and nothing goes
  // out, so the short body is all that is ever stored.
  const sent = await sendNotification(supabase, {
    userId: owner.id,
    kind: DIGEST_KIND,
    title,
    body: storedBody,
    url,
    email: null,
    phone: null,
  });

  // The detail goes out only if the row was written, matching what
  // sendNotification itself does: a failed insert means the owner has no
  // in-app copy, and the next run will raise the same backlog again.
  if (sent) {
    await sendOutboundChannels({
      userId: owner.id,
      kind: DIGEST_KIND,
      title,
      body: emailBody,
      url,
      email: ownerEmail,
      // No SMS: this is a list to read at a desk, and it carries other
      // people's contact details, which do not belong in a text message.
      phone: null,
    });
  }

  return NextResponse.json({ ok: true, open: rows.length, notified: sent });
}

export async function POST(req: NextRequest) {
  return runCron(req);
}

export async function GET(req: NextRequest) {
  return runCron(req);
}
