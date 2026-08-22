import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Authenticated image proxy for the private home-photos bucket.
//
// Given ?path=<object path>, it asks Supabase to sign a short-lived URL for that
// object USING THE CALLER'S SESSION. Signing is gated by the storage RLS
// policies, so a user can only get a URL for an object they're allowed to see
// (a property they own, or a chat/<lead> they're a party to). We then redirect
// to the signed URL. No service role, no manual auth logic - RLS is the gate.
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const path = req.nextUrl.searchParams.get("path") ?? "";
  // Reject path traversal / absolute-ish inputs.
  if (!path || path.includes("..") || path.startsWith("/")) {
    return NextResponse.json({ error: "Bad path" }, { status: 400 });
  }

  const { data, error } = await supabase.storage
    .from("home-photos")
    .createSignedUrl(path, 60 * 10); // 10 minutes

  if (error || !data?.signedUrl) {
    // Either the object doesn't exist or the caller isn't allowed to see it.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const res = NextResponse.redirect(data.signedUrl);
  // 480s < the signed URL's 600s TTL, so a cached redirect can never outlive
  // the URL it points to. "private" keeps this out of any shared/CDN cache
  // since the signed URL itself is effectively a per-user credential.
  res.headers.set("Cache-Control", "private, max-age=480");
  return res;
}
