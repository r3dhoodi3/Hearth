import type { Metadata } from "next";
import LegalDocument from "@/components/LegalDocument";

// Public top-level page, same pattern as src/app/terms/page.tsx: see
// src/lib/supabase/middleware.ts for the allowlist entry and
// src/app/sitemap.ts for the sitemap entry. Content lives in
// src/content/legal/guidelines.md, rendered by LegalDocument. Covers both
// the community guidelines and the reviews policy (FTC 16 C.F.R. Part 465).

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  title: "Community Guidelines",
  description:
    "How to treat people on OakTend, what we moderate automatically, and our reviews policy: reviews are never paid for, gated, or removed for being negative.",
  alternates: {
    canonical: `${SITE_URL}/guidelines`,
  },
};

export default function GuidelinesPage() {
  return <LegalDocument slug="guidelines" />;
}
