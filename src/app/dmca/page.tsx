import type { Metadata } from "next";
import LegalDocument from "@/components/LegalDocument";

// Public top-level page, same pattern as src/app/terms/page.tsx and
// src/app/privacy/page.tsx: see src/lib/supabase/middleware.ts for the
// allowlist entry and src/app/sitemap.ts for the sitemap entry. Content lives
// in src/content/legal/dmca.md, rendered by LegalDocument.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  // The root layout's title template appends "| OakTend"; don't repeat it here.
  title: "Copyright / DMCA Policy",
  description:
    "How to report copyrighted material on OakTend, what a valid DMCA takedown notice must include, how to file a counter-notice, and our repeat infringer policy.",
  alternates: {
    canonical: `${SITE_URL}/dmca`,
  },
};

export default function DmcaPage() {
  return <LegalDocument slug="dmca" />;
}
