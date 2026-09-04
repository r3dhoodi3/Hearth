import type { Metadata } from "next";
import LegalDocument from "@/components/LegalDocument";

// Public top-level page, same pattern as src/app/terms/page.tsx: see
// src/lib/supabase/middleware.ts for the allowlist entry and
// src/app/sitemap.ts for the sitemap entry. Content lives in
// src/content/legal/accessibility.md, rendered by LegalDocument.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  title: "Accessibility Statement",
  description:
    "Where Hearth stands on WCAG 2.2 AA today, what's already in place, known gaps, and how to reach us if something isn't usable.",
  alternates: {
    canonical: `${SITE_URL}/accessibility`,
  },
};

export default function AccessibilityPage() {
  return <LegalDocument slug="accessibility" />;
}
