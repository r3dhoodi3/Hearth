import type { Metadata } from "next";
import LegalDocument from "@/components/LegalDocument";

// Public top-level page, same pattern as src/app/billing/page.tsx: see
// src/lib/supabase/middleware.ts for the allowlist entry and
// src/app/sitemap.ts for the sitemap entry. Content lives in
// src/content/legal/pro-data-addendum.md, rendered by LegalDocument. This is
// the addendum to the Pro Terms that governs what a pro may do with a
// homeowner's contact details once they pay to see a lead.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  title: "Pro Data Addendum",
  description:
    "What a pro may and may not do with a homeowner's contact details and job information after paying to see a lead: permitted use, retention, deletion, and security.",
  alternates: {
    canonical: `${SITE_URL}/pro-data-addendum`,
  },
};

export default function ProDataAddendumPage() {
  return <LegalDocument slug="pro-data-addendum" />;
}
