import type { Metadata } from "next";
import LegalDocument from "@/components/LegalDocument";

// Public top-level page, same pattern as src/app/billing/page.tsx: see
// src/lib/supabase/middleware.ts for the allowlist entry and
// src/app/sitemap.ts for the sitemap entry. Content lives in
// src/content/legal/law-enforcement.md, rendered by LegalDocument. This is
// where a law enforcement agency or a civil litigant finds what Hearth
// requires before disclosing any user data.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  title: "Law Enforcement Requests",
  description:
    "What Hearth has, what legal process we require before disclosing it, how to serve us, and how we handle preservation, emergency, and civil requests.",
  alternates: {
    canonical: `${SITE_URL}/law-enforcement`,
  },
};

export default function LawEnforcementPage() {
  return <LegalDocument slug="law-enforcement" />;
}
