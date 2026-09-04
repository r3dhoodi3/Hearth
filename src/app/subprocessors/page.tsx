import type { Metadata } from "next";
import LegalDocument from "@/components/LegalDocument";

// Public top-level page, same pattern as src/app/terms/page.tsx: see
// src/lib/supabase/middleware.ts for the allowlist entry and
// src/app/sitemap.ts for the sitemap entry. Content lives in
// src/content/legal/subprocessors.md, rendered by LegalDocument.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  title: "Subprocessors",
  description:
    "Every outside company that processes personal information on OakTend's behalf, what they receive, and where they operate.",
  alternates: {
    canonical: `${SITE_URL}/subprocessors`,
  },
};

export default function SubprocessorsPage() {
  return <LegalDocument slug="subprocessors" />;
}
