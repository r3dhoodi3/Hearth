import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { toObjectPath } from "@/lib/storage";

export const runtime = "nodejs";

// Authenticated image proxy for JOB photos in the private home-photos bucket.
//
// Unlike /api/img (which signs under the CALLER'S own RLS, and RLS locks the
// photos/home-photos objects to the property owner), a pro is NOT the owner, so
// RLS denies them. Authorization here goes through two SECURITY DEFINER gates
// that derive auth.uid() themselves:
//   - can_preview_job_photo  -> a board-eligible pro may see a DOWNSCALED preview
//   - can_view_job_photo_full -> owner / assigned / applied pro may see full res
// Both also bind the given photo url to the lead, so a caller cannot pair an
// arbitrary object path with a lead they can see. Only after a gate returns
// true do we sign the URL with the admin client. The admin client is used ONLY
// for signing, never for the authz decision.
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const leadId = req.nextUrl.searchParams.get("lead") ?? "";
  // The RAW stored value (a legacy public url OR a bare path). The gate
  // functions compare this against photos.url, so it must be passed through
  // unchanged - never the normalized path.
  const rawPath = req.nextUrl.searchParams.get("path") ?? "";
  const full = req.nextUrl.searchParams.get("full") === "1";

  if (!leadId || !rawPath) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // The object path to actually sign, normalized off the stored value.
  const objectPath = toObjectPath(rawPath) ?? "";
  // Reject path traversal / absolute-ish inputs, same guard as /api/img.
  if (
    !objectPath ||
    objectPath.includes("..") ||
    objectPath.startsWith("/")
  ) {
    return NextResponse.json({ error: "Bad path" }, { status: 400 });
  }

  // Authorization: the gate runs under the caller's session (the functions are
  // security definer and read auth.uid() themselves). Anything other than a
  // true result - false, null, or an error - is treated as 404 so we never
  // distinguish "not allowed" from "missing".
  const { data: allowed, error: authzError } = await (supabase as any).rpc(
    full ? "can_view_job_photo_full" : "can_preview_job_photo",
    { p_lead_id: leadId, p_photo_url: rawPath }
  );
  if (authzError || allowed !== true) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Only now, after authz passed, sign with the admin client. Preview mode adds
  // a Supabase image transform (downscale + recompress); full mode signs the
  // original object.
  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from("home-photos")
    .createSignedUrl(
      objectPath,
      60 * 10, // 10 minutes
      full
        ? undefined
        : { transform: { width: 700, quality: 55, resize: "contain" } }
    );

  if (error || !data?.signedUrl) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const res = NextResponse.redirect(data.signedUrl);
  // 480s < the signed URL's 600s TTL, so a cached redirect can never outlive
  // the URL it points to. "private" keeps this per-user credential out of any
  // shared/CDN cache.
  res.headers.set("Cache-Control", "private, max-age=480");
  return res;
}
