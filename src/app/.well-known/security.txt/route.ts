import { LEGAL } from "@/lib/legal";

// RFC 9116 security.txt. See src/app/security/page.tsx (the human-readable
// policy this file's Policy field points at) and FACTS.md's Security
// section. `Expires` must be a real date-time, not literal text: computed at
// request time as one year out, so the file never silently goes stale the
// way a hardcoded date would.
export const dynamic = "force-dynamic";

export async function GET() {
  const expires = new Date();
  expires.setUTCFullYear(expires.getUTCFullYear() + 1);

  const body = [
    `Contact: mailto:${LEGAL.securityEmail}`,
    `Expires: ${expires.toISOString()}`,
    "Preferred-Languages: en",
    `Canonical: ${LEGAL.siteUrl}/.well-known/security.txt`,
    `Policy: ${LEGAL.siteUrl}/security`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // Scanners poll this file; an hour of edge caching costs nothing and
      // the Expires field is a year out, so a stale hour is harmless.
      "Cache-Control": "public, max-age=3600",
    },
  });
}
