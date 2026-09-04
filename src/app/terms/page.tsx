import type { Metadata } from "next";
import LegalDocument from "@/components/LegalDocument";

// Public top-level page, same pattern as src/app/fountain-valley/page.tsx:
// see src/lib/supabase/middleware.ts for the allowlist entry and
// src/app/sitemap.ts for the sitemap entry. Content lives in
// src/content/legal/terms.md, rendered by LegalDocument; editing the terms
// is now editing that file, not this one.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  // The root layout's title template appends "| Hearth"; don't repeat it here.
  title: "Terms of Service",
  description:
    "What Hearth is and isn't, how accounts and fees work, license and insurance trust signals, and how disputes get resolved.",
  alternates: {
    canonical: `${SITE_URL}/terms`,
  },
};

export default function TermsPage() {
  return <LegalDocument slug="terms" />;
}
