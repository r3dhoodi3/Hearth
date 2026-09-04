import type { Metadata } from "next";
import LegalDocument from "@/components/LegalDocument";

// Public top-level page, same pattern as src/app/terms/page.tsx:
// see src/lib/supabase/middleware.ts for the allowlist entry and
// src/app/sitemap.ts for the sitemap entry. Content lives in
// src/content/legal/pro-terms.md, rendered by LegalDocument.
//
// This page is the B2B supplement to /terms for contractors using Hearth for
// Pros: license/insurance obligations, independent-contractor status, leads
// and lead credit-back, and pro membership billing. It does not replace
// /terms - a contractor account is still bound by the general Terms of
// Service and Privacy Policy for everything not specific to operating as a
// pro on the marketplace.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  // The root layout's title template appends "| Hearth"; don't repeat it here.
  title: "Contractor Terms",
  description:
    "The extra rules for contractors using Hearth for Pros: licensing and insurance, independent-contractor status, lead fees and credit-back, and Pro membership billing.",
  alternates: {
    canonical: `${SITE_URL}/pro-terms`,
  },
};

export default function ProTermsPage() {
  return <LegalDocument slug="pro-terms" />;
}
