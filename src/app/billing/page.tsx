import type { Metadata } from "next";
import LegalDocument from "@/components/LegalDocument";

// Public top-level page, same pattern as src/app/terms/page.tsx: see
// src/lib/supabase/middleware.ts for the allowlist entry and
// src/app/sitemap.ts for the sitemap entry. Content lives in
// src/content/legal/billing.md, rendered by LegalDocument. Required before
// purchase by Cal. B&P 17538: legal name, address, and a link to this policy.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  title: "Billing & Refund Policy",
  description:
    "Prices, free trials, auto-renewal, one-click cancellation, and how pro lead credit-back and ghost protection work.",
  alternates: {
    canonical: `${SITE_URL}/billing`,
  },
};

export default function BillingPage() {
  return <LegalDocument slug="billing" />;
}
