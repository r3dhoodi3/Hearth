# Legal and compliance to-do (for Landen, to take to a CA attorney)

Rewritten 2026-09-02. The full legal document set is now published as real
site pages, rendered from Markdown in `src/content/legal/*.md` (see
`src/components/LegalDocument.tsx` and `src/lib/legalMarkdown.tsx`). Editing a
policy is now editing its `.md` file, not a page component. This file is a
short status list, not legal advice: what's live, what env vars fill in the
company identity, and what's still on the owner before launch.

## 1. What's published

Every page below reads from `src/content/legal/<slug>.md` through
`LegalDocument`, so the text and this list can't drift apart the way hand-
written JSX copies used to:

| Page | Slug |
|---|---|
| `/terms` | `terms.md` |
| `/pro-terms` | `pro-terms.md` |
| `/privacy` | `privacy.md` |
| `/cookies` | `cookies.md` |
| `/subprocessors` | `subprocessors.md` |
| `/billing` | `billing.md` |
| `/sms-terms` | `sms-terms.md` |
| `/ai-disclosure` | `ai-disclosure.md` |
| `/accessibility` | `accessibility.md` |
| `/dmca` | `dmca.md` |
| `/guidelines` | `guidelines.md` |
| `/security` | `security.md` |
| `/pro-data-addendum` | `pro-data-addendum.md` |
| `/law-enforcement` | `law-enforcement.md` |

`/privacy-choices` is a short, hand-written page (not from Markdown) pointing
at the Privacy Policy's CCPA section and the in-app Account > Privacy
controls. `/.well-known/security.txt` (`src/app/.well-known/security.txt/route.ts`)
is a machine-readable RFC 9116 file built from the same `LEGAL` config, linking
to `/security`. All fifteen pages are in the public allowlist
(`src/lib/supabase/middleware.ts`) and the sitemap (`src/app/sitemap.ts`), and
every footer that lists legal links now maps over `LEGAL_LINKS`
(`src/lib/legal.ts`) instead of hardcoding hrefs.

Every document still carries the `{{TOKENS}}` described below, filled at
render time by `fillLegalTokens()`. Nothing in `src/content/legal` should be
published with the literal token still showing; `legalPlaceholdersRemaining()`
in `src/lib/legal.ts` reports which owner-fillable fields are still
placeholders, and a repo-wide `grep -r "TODO(legal)"` should be run before
each launch milestone to catch anything new.

## 2. Env vars to set (src/lib/legal.ts)

None of these are required to build or run the app: every one has a fallback
(a bracketed `[TODO(legal): ...]` placeholder for the entity/DMCA fields, or a
`name@<domain>` guess for the email fields), so the site works today and the
fallbacks are what currently render on every legal page. Set these in Vercel
(and `.env.local`) once each fact is real:

- `NEXT_PUBLIC_LEGAL_BRAND` - product name (default "Hearth").
- `NEXT_PUBLIC_LEGAL_ENTITY_NAME` - the formed LLC's legal name. **Not set. The LLC does not exist yet.**
- `NEXT_PUBLIC_LEGAL_ADDRESS` - registered business address. **Not set.** Required before purchase under Cal. B&P 17538 and in every email under CAN-SPAM.
- `NEXT_PUBLIC_LEGAL_DOMAIN` - defaults to the host in `NEXT_PUBLIC_SITE_URL`; only set this separately if the legal domain differs from the site's own host.
- `NEXT_PUBLIC_LEGAL_EMAIL`, `NEXT_PUBLIC_SUPPORT_EMAIL`, `NEXT_PUBLIC_PRIVACY_EMAIL`, `NEXT_PUBLIC_SECURITY_EMAIL` - default to `legal@`/`support@`/`privacy@`/`security@` the domain above. Set these once real, monitored inboxes exist; the legal address in particular currently routes to a personal inbox and needs to move off it.
- `NEXT_PUBLIC_PRIVACY_PHONE` - optional; blank hides the phone line on `/privacy` and `/privacy-choices`.
- `NEXT_PUBLIC_DMCA_AGENT_NAME`, `NEXT_PUBLIC_DMCA_AGENT_ADDRESS`, `NEXT_PUBLIC_DMCA_AGENT_PHONE` - **not set.** `NEXT_PUBLIC_DMCA_AGENT_EMAIL` defaults to `dmca@` the domain.
- `NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE` - the "Last updated" date shown at the top of every document; bump this (and the doc's own "Last updated" line, which the token also fills) whenever a document changes.

## 3. Remaining owner items before launch

1. **Form the LLC.** File a CA LLC, get an EIN, file a county Fictitious
   Business Name statement if trading as "Hearth", get a Huntington Beach
   business license. Then set `NEXT_PUBLIC_LEGAL_ENTITY_NAME` and
   `NEXT_PUBLIC_LEGAL_ADDRESS`. Until this is done, `{{LLC_NAME}}` and
   `{{ADDRESS}}` render as `TODO(legal)` placeholders on every page that uses
   them, on purpose, so this is easy to catch.
2. **Register the DMCA agent** at dmca.copyright.gov ($6, renew every 3
   years), then set the four `NEXT_PUBLIC_DMCA_AGENT_*` vars to match exactly
   what was registered. `/dmca` does not have a working safe harbor until
   this is done, no matter what the page shows.
3. **Move legal/support/privacy/security email off any personal inbox** onto
   real, monitored addresses at the real domain, then set the four email env
   vars to match.
4. **B&P 17538 checkout disclosure.** The legal name, address, and a link to
   `/billing` are not yet shown on the checkout or pricing screen before
   purchase. Out of scope for this pass (checkout/pricing pages are owned by
   another work stream); flagging here so it isn't lost.
5. **Auto-renewal consent checkbox.** `/billing` describes an unchecked "I
   agree to the automatic renewal terms above" checkbox at checkout; that
   checkbox does not exist yet (`src/components/AutoRenewalTerms.tsx` shows
   the disclosure but nothing gates the submit button on it). Same
   out-of-scope note as above.
6. **SMS STOP/START confirmation texts.** `/sms-terms` describes a
   confirmation message sent on STOP and on opt-in; `src/app/api/twilio/inbound/route.ts`
   currently flips the consent flag silently with no confirmation text. Also
   still open: Twilio 10DLC brand and campaign registration.
7. ~~**Global Privacy Control.**~~ Done 2026-09-02: `src/middleware.ts` now
   calls `logGpcSignalOncePerSession` (`src/lib/gpc.ts`) after every request,
   fire-and-forget via `event.waitUntil`. `/privacy` and `/cookies` say Hearth
   honors the GPC signal; that claim now has a logged `app_event` behind it.
   Because Hearth doesn't sell or share personal information, this changes no
   other behavior.
8. **Pro CRM data purge on homeowner deletion.** `/privacy` discloses that a
   pro's CRM copy of a deleted homeowner's name/phone/email/address is
   removed within 30 days. Confirm this is actually implemented before
   relying on the claim; it was an open gap as of the last privacy pass.
9. **Sign in with Apple token revocation** (Apple TN3194): confirm
   account deletion also revokes Apple sign-in tokens.
10. **Insurance**: E&O and cyber liability quotes before real payments at
    scale.
11. **Attorney review of every document in `src/content/legal`**, especially
    the arbitration/class-waiver section of `terms.md`, the liability cap, and
    the independent-contractor language in `pro-terms.md`. Nothing here has
    been reviewed by counsel.

## 4. Nice to have / monitor

- **SB 942 (AI Transparency Act)** and **AB 2013** target large GenAI
  developers; Hearth is a downstream API user, likely out of scope.
- **SB 243 (companion chatbots)**: Ask Hearth is task-based, likely excluded;
  confirm.
- **CA SaaS sales tax**: not taxable today; SB 122 makes SaaS taxable from
  Jan 1, 2027. Plan 2027 pricing.
- **Formal WCAG 2.2 AA audit.** `/accessibility` is honest that Hearth is
  "partially conformant" and no formal audit has run yet.

Sources: CSLB online marketplace fast facts (cslb.ca.gov), leginfo B&P 7027.1
/ 7048 / 7159 / 17538 / 17941, CA Automatic Renewal Law as amended by AB 2863
(eff. July 1, 2025), FTC 16 CFR 465 (Consumer Reviews and Testimonials Rule),
Apple TN3194, CTIA messaging principles, 17 U.S.C. 512 (DMCA), CCPA/CPRA.
