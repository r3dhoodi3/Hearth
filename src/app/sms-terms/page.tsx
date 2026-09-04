import type { Metadata } from "next";
import LegalDocument from "@/components/LegalDocument";

// Public top-level page, same pattern as src/app/terms/page.tsx: see
// src/lib/supabase/middleware.ts for the allowlist entry and
// src/app/sitemap.ts for the sitemap entry. Content lives in
// src/content/legal/sms-terms.md, rendered by LegalDocument.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  title: "SMS Terms",
  description:
    "OakTend Alerts: what texts you'll get, how to opt in and out, message frequency, quiet hours, and that your number is never shared for marketing.",
  alternates: {
    canonical: `${SITE_URL}/sms-terms`,
  },
};

export default function SmsTermsPage() {
  return <LegalDocument slug="sms-terms" />;
}
