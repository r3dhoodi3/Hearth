import type { Metadata } from "next";
import LegalDocument from "@/components/LegalDocument";

// Public top-level page, same pattern as src/app/terms/page.tsx: see
// src/lib/supabase/middleware.ts for the allowlist entry and
// src/app/sitemap.ts for the sitemap entry. Content lives in
// src/content/legal/cookies.md, rendered by LegalDocument.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  title: "Cookie and Tracking Notice",
  description:
    "The first-party cookies Hearth sets, what's kept only in your browser's local storage, and why there's no ad tracker anywhere in the app.",
  alternates: {
    canonical: `${SITE_URL}/cookies`,
  },
};

export default function CookiesPage() {
  return <LegalDocument slug="cookies" />;
}
