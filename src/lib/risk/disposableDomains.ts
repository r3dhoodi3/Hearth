// Throwaway-inbox providers, for the trial-abuse score.
//
// The whole free-trial farm depends on a fresh email address per account, and
// the cheapest supply of those is a disposable-inbox service: a browser tab that
// hands out an address that works for ten minutes and then evaporates. Nobody
// signs up for a home-maintenance app they intend to use with a ten-minute
// inbox, so the domain is a genuinely strong signal - which is why it is worth
// 25 points on its own in src/lib/risk/score.ts.
//
// This list is DELIBERATELY SHORT. There are tens of thousands of disposable
// domains and keeping up with them is a subscription service, not a constant in
// a repo. These are the ones that actually show up: the big self-serve
// throwaway services and the handful of aliasing services whose entire purpose
// is a new address per signup. A miss here costs 25 points on one account, not
// a bypass - the card, device, IP and email-normalization signals all still
// apply - so a stale list degrades gently.
//
// Note what is NOT here: real mailbox providers (gmail, outlook, yahoo,
// proton, icloud, fastmail, hey). Those are where actual customers live. A
// list that punished them would be a list that punished everybody.
//
// Matching is exact, on the lowercased domain, plus a suffix check for the
// couple of services that hand out unlimited subdomains (see isDisposableDomain
// in src/lib/risk/emailNorm.ts).
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  // Classic web-based throwaway inboxes.
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.info",
  "sharklasers.com",
  "grr.la",
  "10minutemail.com",
  "10minutemail.net",
  "tempmail.com",
  "temp-mail.org",
  "throwawaymail.com",
  "yopmail.com",
  "yopmail.fr",
  "getnada.com",
  "dispostable.com",
  "trashmail.com",
  "mytrashmail.com",
  "maildrop.cc",
  "fakeinbox.com",
  "mailnesia.com",
  "moakt.com",
  "emailondeck.com",
  "tempinbox.com",
  "spamgourmet.com",
  "mailcatch.com",
  "inboxbear.com",
  "burnermail.io",
  "mail-temp.com",
  "tmpmail.org",
  "einrot.com",
  "harakirimail.com",
]);

// Services that hand out an unlimited supply of SUBdomains, so an exact-match
// set can never cover them. Matched as a suffix: anything ending in
// ".mailinator.com" is still a mailinator inbox.
export const DISPOSABLE_DOMAIN_SUFFIXES: readonly string[] = [
  ".mailinator.com",
  ".yopmail.com",
  ".guerrillamail.com",
  ".maildrop.cc",
];
