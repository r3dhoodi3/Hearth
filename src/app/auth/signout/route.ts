import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requestOrigin } from "@/lib/requestOrigin";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  // Land on the public landing page (neutral for both homeowner and pro).
  // Origin from requestOrigin, not request.url: the latter carries the dev
  // server's bind address (`-H 0.0.0.0`) and strands the browser there.
  return NextResponse.redirect(new URL("/", requestOrigin(request)), {
    status: 303,
  });
}
