// The as-you-type suggestion engine behind the top-nav search on both sides
// of the app (src/components/GlobalSearch.tsx) and the pro /pro/search page.
// Everything in here is pure data and pure functions: a static registry of
// app destinations, plus prefix-style matching over that registry and the FAQ
// index (src/lib/faqIndex.ts). No network, no database, so suggestions render
// on the very first keystrokes.

import { FAQ_INDEX, type FaqEntry, type FaqSide } from "@/lib/faqIndex";

export type SearchSide = "homeowner" | "pro";

export type Destination = {
  // Action-flavored label, the way a person would say it ("Post a job"), not
  // the route's internal name.
  label: string;
  href: string;
  // Extra match words beyond the label's own tokens.
  keywords: string[];
  side: FaqSide;
};

// Every destination the search can jump to, per side. Hrefs mirror the real
// nav surfaces: Nav.tsx / ToolsMenu.tsx / ProfileMenu links on the homeowner
// side, ProNav.tsx and its profile menu on the pro side. Adding a page to the
// app should usually mean adding a row here.
export const DESTINATIONS: Destination[] = [
  // ---- Homeowner ----
  { label: "Home", href: "/dashboard", keywords: ["dashboard", "health", "score", "systems"], side: "homeowner" },
  { label: "Post a job", href: "/contractors", keywords: ["quote", "hire", "estimate", "contractor", "pro"], side: "homeowner" },
  { label: "Browse pros", href: "/contractors/browse", keywords: ["find", "plumber", "electrician", "contractor", "handyman"], side: "homeowner" },
  { label: "Messages", href: "/chats", keywords: ["chat", "message", "inbox"], side: "homeowner" },
  { label: "Ask Hearth", href: "/chats?lead=ask-hearth", keywords: ["ai", "assistant", "question", "chat"], side: "homeowner" },
  { label: "Add a document", href: "/documents", keywords: ["documents", "warranty", "manual", "receipt", "upload", "vault", "paperwork"], side: "homeowner" },
  { label: "See your home value", href: "/value", keywords: ["value", "worth", "equity", "estimate", "price"], side: "homeowner" },
  { label: "Cost forecast", href: "/forecast", keywords: ["budget", "repair", "fund", "savings", "10-year"], side: "homeowner" },
  { label: "Quote analyzer", href: "/quote-check", keywords: ["quote", "check", "fair", "analyze", "compare"], side: "homeowner" },
  { label: "Home report", href: "/home-report", keywords: ["report", "resale", "share", "insurance"], side: "homeowner" },
  { label: "Property taxes", href: "/taxes", keywords: ["tax", "assessed", "bill"], side: "homeowner" },
  { label: "Home inspection", href: "/inspection", keywords: ["inspection", "inspector", "import"], side: "homeowner" },
  { label: "Walk your home", href: "/walkthrough", keywords: ["walkthrough", "tour", "setup"], side: "homeowner" },
  { label: "Home details", href: "/home-details", keywords: ["address", "details", "systems", "edit"], side: "homeowner" },
  { label: "Learn about your home", href: "/learn", keywords: ["guides", "tips", "maintenance", "how"], side: "homeowner" },
  { label: "Report a problem", href: "/issues", keywords: ["issue", "broken", "leak", "repair", "problem"], side: "homeowner" },
  { label: "Household", href: "/account/household", keywords: ["family", "invite", "share", "member"], side: "homeowner" },
  { label: "Hearth Plus and billing", href: "/plus", keywords: ["billing", "subscription", "upgrade", "membership", "plan", "cancel", "pay"], side: "homeowner" },
  { label: "Notifications", href: "/account/notifications", keywords: ["alerts", "email", "preferences", "push"], side: "homeowner" },
  { label: "Account security", href: "/account/security", keywords: ["password", "delete", "email", "login"], side: "homeowner" },
  { label: "Your privacy rights", href: "/account/privacy", keywords: ["privacy", "data", "export", "download", "rights"], side: "homeowner" },
  { label: "Help", href: "/account/help", keywords: ["support", "contact", "faq", "question"], side: "homeowner" },

  // ---- Pro ----
  { label: "Home", href: "/pro", keywords: ["dashboard", "overview"], side: "pro" },
  { label: "Browse leads", href: "/pro/leads", keywords: ["jobs", "lead", "apply", "work", "board"], side: "pro" },
  { label: "Messages", href: "/pro/chats", keywords: ["chat", "message", "inbox", "homeowner"], side: "pro" },
  { label: "Ask Hearth", href: "/pro/ask", keywords: ["ai", "copilot", "assistant", "question"], side: "pro" },
  { label: "Clients", href: "/pro/crm", keywords: ["crm", "customer", "contact", "list"], side: "pro" },
  { label: "My business", href: "/pro/business", keywords: ["business", "company", "stats"], side: "pro" },
  { label: "Your public page", href: "/pro/profile", keywords: ["profile", "storefront", "reviews", "badge", "license", "edit"], side: "pro" },
  { label: "Deposits and billing", href: "/pro/billing", keywords: ["wallet", "deposit", "credit", "balance", "payment", "money"], side: "pro" },
  { label: "Membership", href: "/pro/plus", keywords: ["pro", "plus", "subscribe", "discount", "upgrade"], side: "pro" },
  { label: "Back office", href: "/pro/tools", keywords: ["ai", "tools", "compliance", "calendar", "office"], side: "pro" },
  { label: "Playbook", href: "/pro/playbook", keywords: ["grow", "marketing", "tips"], side: "pro" },
  { label: "Blocked accounts", href: "/pro/blocks", keywords: ["block", "report", "safety"], side: "pro" },
  { label: "Your privacy rights", href: "/pro/privacy", keywords: ["privacy", "data", "rights"], side: "pro" },
  { label: "Help", href: "/pro/help", keywords: ["support", "contact", "faq", "lead", "pricing"], side: "pro" },
];

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// True when every token the person typed prefix-matches some token of the
// candidate's text or keywords. Prefixes make it fire from the first
// keystrokes ("dep" finds "Deposits"), and the AND across query tokens keeps
// "post job" from matching everything containing either word. Longer tokens
// (4+) also match inside a word so "heater" still finds compound words, and
// the reverse prefix lets a plural query ("leads") find a singular keyword
// ("lead") without a stemmer.
export function matchesQuery(query: string, text: string, keywords: string[] = []): boolean {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return false;
  const hay = tokenize(text).concat(keywords.flatMap(tokenize));
  return qTokens.every((t) =>
    hay.some(
      (h) =>
        h.startsWith(t) ||
        (h.length >= 4 && t.startsWith(h)) ||
        (t.length >= 4 && h.includes(t))
    )
  );
}

function onSide(entrySide: FaqSide, side: SearchSide): boolean {
  return entrySide === "both" || entrySide === side;
}

export function matchDestinations(
  query: string,
  side: SearchSide,
  limit = 5
): Destination[] {
  return DESTINATIONS.filter(
    (d) => onSide(d.side, side) && matchesQuery(query, d.label, d.keywords)
  ).slice(0, limit);
}

export function matchFaq(query: string, side: SearchSide, limit = 4): FaqEntry[] {
  return FAQ_INDEX.filter(
    (f) => onSide(f.side, side) && matchesQuery(query, f.question, f.keywords)
  ).slice(0, limit);
}
