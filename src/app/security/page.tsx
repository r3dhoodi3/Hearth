import type { Metadata } from "next";
import LegalDocument from "@/components/LegalDocument";

// Public top-level page, same pattern as src/app/terms/page.tsx: see
// src/lib/supabase/middleware.ts for the allowlist entry and
// src/app/sitemap.ts for the sitemap entry. Content lives in
// src/content/legal/security.md, rendered by LegalDocument. Linked from
// src/app/.well-known/security.txt/route.ts as the "Policy" field.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  title: "Security & Responsible Disclosure",
  description:
    "How OakTend protects your data, and how to report a security vulnerability to us in good faith.",
  alternates: {
    canonical: `${SITE_URL}/security`,
  },
};

export default function SecurityPage() {
  return <LegalDocument slug="security" />;
}
