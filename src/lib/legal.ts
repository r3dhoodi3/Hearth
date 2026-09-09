// =============================================================================
// LEGAL: the single source of truth for the company identity that every legal
// page, email footer, checkout disclosure, and consent string reads from.
//
// Owner-fillable. Set the NEXT_PUBLIC_LEGAL_* env vars in Vercel (and
// .env.local) once the LLC exists. Until then the bracketed TODO(legal)
// placeholders render on purpose so a grep for TODO(legal) catches anything
// unfilled before launch. Do not invent a name or address here.
//
// The legal documents in src/content/legal/*.md use {{TOKENS}} that
// fillLegalTokens() replaces at render time, so a rename or a new address is a
// one-line change here, not a rewrite of every policy.
// =============================================================================
import { FOUNDER } from "@/lib/constants";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "localhost:3000";
  }
}

const env = (key: string): string | undefined => {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
};

const domain = env("NEXT_PUBLIC_LEGAL_DOMAIN") ?? hostOf(SITE_URL);
const mailDomain = domain.replace(/^www\./, "").replace(/:\d+$/, "");

export const LEGAL = {
  /** Product / brand name shown to users. */
  brand: env("NEXT_PUBLIC_LEGAL_BRAND") ?? "OakTend",
  /** Registered legal entity, e.g. "Keepwell Home LLC, a California limited liability company". */
  legalName: env("NEXT_PUBLIC_LEGAL_ENTITY_NAME") ?? "[TODO(legal): LLC legal name]",
  /** Street or mailing address. Required before purchase by Cal. B&P 17538 and in every email by CAN-SPAM. */
  address: env("NEXT_PUBLIC_LEGAL_ADDRESS") ?? "[TODO(legal): registered business address]",
  domain,
  siteUrl: SITE_URL,
  legalEmail: env("NEXT_PUBLIC_LEGAL_EMAIL") ?? `legal@${mailDomain}`,
  supportEmail: env("NEXT_PUBLIC_SUPPORT_EMAIL") ?? `support@${mailDomain}`,
  privacyEmail: env("NEXT_PUBLIC_PRIVACY_EMAIL") ?? `privacy@${mailDomain}`,
  securityEmail: env("NEXT_PUBLIC_SECURITY_EMAIL") ?? `security@${mailDomain}`,
  /** Optional toll-free number for CCPA requests. Blank hides it. */
  privacyPhone: env("NEXT_PUBLIC_PRIVACY_PHONE") ?? "",
  dmcaAgent: {
    name: env("NEXT_PUBLIC_DMCA_AGENT_NAME") ?? "[TODO(legal): DMCA agent name]",
    address: env("NEXT_PUBLIC_DMCA_AGENT_ADDRESS") ?? "[TODO(legal): DMCA agent address]",
    phone: env("NEXT_PUBLIC_DMCA_AGENT_PHONE") ?? "[TODO(legal): DMCA agent phone]",
    email: env("NEXT_PUBLIC_DMCA_AGENT_EMAIL") ?? `dmca@${mailDomain}`,
  },
  /**
   * ISO date the current document set took effect. Bumped 2026-09-09 when
   * cookieless Vercel Web Analytics was turned on and the privacy policy and
   * cookie notice were reworded to disclose it.
   */
  effectiveDate: env("NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE") ?? "2026-09-09",
  venueCounty: "Orange County, California",
  liabilityCap:
    "the greater of $100 or the amounts you paid to us in the 12 months before the claim",
  ownerName: FOUNDER.name || "[TODO(legal): owner name]",
} as const;

/** True when any owner-fillable field is still a placeholder. Used by tests and the admin health check. */
export function legalPlaceholdersRemaining(): string[] {
  const out: string[] = [];
  const check = (label: string, v: string) => {
    if (v.includes("TODO(legal)")) out.push(label);
  };
  check("legalName", LEGAL.legalName);
  check("address", LEGAL.address);
  check("dmcaAgent.name", LEGAL.dmcaAgent.name);
  check("dmcaAgent.address", LEGAL.dmcaAgent.address);
  check("dmcaAgent.phone", LEGAL.dmcaAgent.phone);
  return out;
}

const TOKENS: Record<string, () => string> = {
  BRAND: () => LEGAL.brand,
  LLC_NAME: () => LEGAL.legalName,
  DOMAIN: () => LEGAL.domain,
  ADDRESS: () => LEGAL.address,
  LEGAL_EMAIL: () => LEGAL.legalEmail,
  SUPPORT_EMAIL: () => LEGAL.supportEmail,
  PRIVACY_EMAIL: () => LEGAL.privacyEmail,
  SECURITY_EMAIL: () => LEGAL.securityEmail,
  PRIVACY_PHONE: () => LEGAL.privacyPhone,
  DMCA_AGENT_NAME: () => LEGAL.dmcaAgent.name,
  DMCA_AGENT_ADDRESS: () => LEGAL.dmcaAgent.address,
  DMCA_AGENT_PHONE: () => LEGAL.dmcaAgent.phone,
  DMCA_AGENT_EMAIL: () => LEGAL.dmcaAgent.email,
  EFFECTIVE_DATE: () => LEGAL.effectiveDate,
  VENUE_COUNTY: () => LEGAL.venueCounty,
  LIABILITY_CAP: () => LEGAL.liabilityCap,
  OWNER_NAME: () => LEGAL.ownerName,
};

/** Replace every {{TOKEN}} in a legal document with the live LEGAL value. Unknown tokens are left as-is. */
export function fillLegalTokens(text: string): string {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => {
    const fn = TOKENS[key];
    return fn ? fn() : match;
  });
}

/** Footer links for every public and in-app footer. Order is deliberate: most-read first. */
export const LEGAL_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/pro-terms", label: "Pro Terms" },
  { href: "/pro-data-addendum", label: "Pro Data Addendum" },
  { href: "/billing", label: "Billing & Refunds" },
  { href: "/sms-terms", label: "SMS Terms" },
  { href: "/ai-disclosure", label: "AI Disclosure" },
  { href: "/accessibility", label: "Accessibility" },
  { href: "/guidelines", label: "Community Guidelines" },
  { href: "/dmca", label: "DMCA" },
  { href: "/security", label: "Security" },
  { href: "/law-enforcement", label: "Law Enforcement Requests" },
  { href: "/cookies", label: "Cookies" },
  { href: "/subprocessors", label: "Subprocessors" },
  { href: "/privacy-choices", label: "Your Privacy Choices" },
];
