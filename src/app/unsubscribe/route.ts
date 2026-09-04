import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyUnsubscribeToken } from "@/lib/unsubscribeToken";

// One-click email unsubscribe target for the footer link in every outgoing
// email (src/lib/notify.ts sendEmail). CAN-SPAM requires the unsubscribe to
// work with no login, so this is a PUBLIC route (see the allowlist entry in
// src/lib/supabase/middleware.ts) authenticated only by a signed token, the
// same posture as the webhook routes.
//
// The link carries ?uid=<user id>&token=<HMAC(uid)>. The token is verified
// (constant-time) before anything is written, so a recipient can only ever
// opt their own account out, never someone else's.
//
// GET, not POST: it is opened straight from an email client. Email link
// scanners can therefore pre-fetch it, but the only effect is setting an
// opt-out the user asked for, which is idempotent and reversible from
// /account, so a scanner triggering it causes no harm.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function page(title: string, message: string, showAccountLink: boolean): NextResponse {
  const accountLine = showAccountLink
    ? `<p style="margin-top:16px">Changed your mind? Turn emails back on any time from your <a href="/account" style="color:#b45309">account settings</a>.</p>`
    : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title} - OakTend</title>
</head>
<body style="margin:0;background:#faf7f2;color:#1c1917;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.6">
<main style="max-width:32rem;margin:0 auto;padding:64px 24px">
<h1 style="font-size:1.375rem;margin:0 0 12px">${title}</h1>
<p style="margin:0">${message}</p>
${accountLine}
</main>
</body>
</html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function GET(req: NextRequest) {
  const uid = req.nextUrl.searchParams.get("uid") ?? "";
  const token = req.nextUrl.searchParams.get("token") ?? "";

  if (!verifyUnsubscribeToken(uid, token)) {
    return page(
      "Link expired or invalid",
      "We couldn't verify this unsubscribe link. You can manage all of your email settings from your account instead.",
      true
    );
  }

  try {
    const admin = createAdminClient();
    // Read-merge-write so a global email opt-out never clobbers the per-channel
    // toggles the user set on /account/notifications (same jsonb column).
    const { data: current } = await admin
      .from("users")
      .select("notification_prefs")
      .eq("id", uid)
      .single();
    const prefs = current?.notification_prefs ?? {};
    const { error } = await admin
      .from("users")
      .update({ notification_prefs: { ...prefs, email_opt_out: true } })
      .eq("id", uid);
    if (error) {
      console.error("unsubscribe: update failed:", error.message);
      return page(
        "Something went wrong",
        "We couldn't update your email settings just now. Please try again, or turn emails off from your account.",
        true
      );
    }
  } catch (err) {
    console.error(
      "unsubscribe:",
      err instanceof Error ? err.message : err
    );
    return page(
      "Something went wrong",
      "We couldn't update your email settings just now. Please try again, or turn emails off from your account.",
      true
    );
  }

  return page(
    "You're unsubscribed",
    "You're unsubscribed from digests and product updates. We'll still email you about your account, billing, and active jobs. Your in-app notifications are unchanged.",
    true
  );
}
