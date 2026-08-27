import {
  DISPOSABLE_EMAIL_DOMAINS,
  DISPOSABLE_DOMAIN_SUFFIXES,
} from "./disposableDomains";

// Reducing an email address to the one address it really is.
//
// The cheapest way to farm a free trial without leaving your inbox is the plus
// tag and the gmail dot: sam@gmail.com, s.am@gmail.com, sam+1@gmail.com and
// sam+hearth@gmail.com are four Hearth accounts and one human being. Every mail
// server involved delivers all four to the same person, so treating them as
// four separate first-time customers is a choice, not a fact.
//
// This module makes that one value. src/lib/risk/signals.ts hashes the result
// and stores it as an 'email_norm' signal, so a second account with a dotted or
// tagged variant of an existing address collides on the hash and the score sees
// it (+30 in src/lib/risk/score.ts).
//
// Pure and dependency-free on purpose: this is the piece most worth unit
// testing, and it has to behave identically at signup, at checkout, and in a
// test.

export type NormalizedEmail = {
  // The whole address, reduced: "s.am+hearth@GMail.com" -> "sam@gmail.com".
  normalized: string;
  // Just the domain, lowercased, after the googlemail alias is folded in.
  domain: string;
  // Whether that domain is a throwaway-inbox provider.
  disposable: boolean;
};

// Gmail and its alias. Both fold dots in the local part AND ignore plus tags,
// and googlemail.com is the same mailbox as gmail.com, so both normalize to
// gmail.com.
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

// Is this domain a throwaway-inbox provider? Exact match against the list,
// plus a suffix check for the services that hand out unlimited subdomains.
export function isDisposableDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  if (!d) return false;
  if (DISPOSABLE_EMAIL_DOMAINS.has(d)) return true;
  return DISPOSABLE_DOMAIN_SUFFIXES.some((suffix) => d.endsWith(suffix));
}

// Reduce an address to its canonical form. Returns null for anything that is
// not recognizably an email address, so callers can skip the signal entirely
// rather than storing a hash of garbage.
//
// The rules, and why each one is safe:
//
//   lowercase everything
//     The domain is case-insensitive by the spec. The local part technically
//     is not, but no mail provider anybody actually uses treats Sam@ and sam@
//     as different mailboxes, and treating them as different accounts here
//     would just hand a farmer a free variant.
//
//   strip the +tag, on every domain
//     Plus addressing is supported by Gmail, Outlook, Yahoo, Fastmail, Proton,
//     iCloud and most self-hosted setups. On a domain that does NOT support it,
//     the tagged address would simply not have received the confirmation email,
//     so it cannot be a real signed-up account in the first place. Stripping it
//     everywhere is therefore safe: at worst it merges two addresses that could
//     never both be live.
//
//   strip dots, on Gmail only
//     Dot-insensitivity is a Gmail-specific behaviour. Other providers really
//     do treat sam.smith@ and samsmith@ as different mailboxes, so stripping
//     dots there would merge two unrelated people into one account - a false
//     accusation, which is much worse than a missed one.
export function normalizeEmail(raw: string | null | undefined): NormalizedEmail | null {
  if (!raw) return null;
  const trimmed = String(raw).trim().toLowerCase();
  if (!trimmed) return null;

  // Split on the LAST "@": a local part may legally contain one inside quotes,
  // and the domain never can.
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;

  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);

  // A domain has to have a dot and no whitespace to be worth storing.
  if (!domain.includes(".") || /\s/.test(domain)) return null;
  if (/\s/.test(local)) return null;

  // Plus tag, every domain (see the note above).
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);

  // Gmail: fold the alias domain, then drop dots.
  if (GMAIL_DOMAINS.has(domain)) {
    domain = "gmail.com";
    local = local.replace(/\./g, "");
  }

  // Stripping the tag or the dots can leave nothing behind ("+tag@gmail.com",
  // "...@gmail.com"). That is not an address anybody can receive mail at.
  if (!local) return null;

  return {
    normalized: `${local}@${domain}`,
    domain,
    disposable: isDisposableDomain(domain),
  };
}
