import type { Metadata } from "next";
import LegalDocument from "@/components/LegalDocument";

// Public top-level page, same pattern as src/app/terms/page.tsx and
// src/app/privacy/page.tsx: see src/lib/supabase/middleware.ts for the
// allowlist entry and src/app/sitemap.ts for the sitemap entry. Content lives
// in src/content/legal/ai-disclosure.md, rendered by LegalDocument. The
// inline label under AI output (src/components/AiNotice.tsx) links here.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  // The root layout's title template appends "| Hearth"; don't repeat it here.
  title: "AI Disclosure",
  description:
    "You're talking to an AI, not a person: what Ask Hearth can and can't do, what data goes to Anthropic, and how to reach a human instead.",
  alternates: {
    canonical: `${SITE_URL}/ai-disclosure`,
  },
};

export default function AiDisclosurePage() {
  return <LegalDocument slug="ai-disclosure" />;
}
