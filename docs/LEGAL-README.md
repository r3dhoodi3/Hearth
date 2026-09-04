# OakTend Legal and Company Setup: README

Last updated: 2026-09-02. Owner: Landen Chu. Co-founder: William Tran.

This is the one file to read when you come back to this. It says where everything is, what is decided, what is not, what to do next, and what we learned. The full document set is in Google Drive: OakTend / 07: Legal / Paperwork (https://drive.google.com/drive/folders/1Q0n_8vjaomzxcFCahTwvtUQ2MrQn8E8a). The site copies live in the repo at src/content/legal.

## Current

**Company**
- Entity decision: California two-member LLC, Landen and William 50/50 (decided 2026-09-02). Landen holds the tiebreaker on product and operations, William on his domain, both must agree on the major decisions list, deadlock goes to mediation then a shotgun buy-sell. Not formed yet. No S corp election until profit is consistently above about $80,000 a year. No Delaware or Wyoming.
- Vesting: 12-month cliff, then monthly, fully vested at 3 or 4 years (you pick). Both founders vest. Each must file an IRS 83(b) election within 30 days of signing. See docs 16 and 27.
- Brand: OakTend (decided 2026-09-03; LLC filed as OakTend LLC the same night, Northwest Registered Agent, oaktend.com/.app/.homes registered on Cloudflare). "Hearth" could not be the launch brand: Shogun Enterprises holds a live federal trademark on HEARTH for contractor software (gethearth.com) and an iOS app called "Hearth: Home Maintenance" already exists. The codebase was renamed to OakTend on 2026-09-03; the {{BRAND}} token in every document fills as OakTend. USPTO intent-to-use filing for OAKTEND (classes 35 and 42) is still to do, owned by the LLC.
- Business city: the code says Fountain Valley, an older note said Huntington Beach, the runbook used Orange as the example. The city license goes to wherever the business is actually based. Confirm.

**Documents (29 in Drive incl. this README, all drafted against the code and verified twice)**
- 00 Start Here (index), 02 Terms, 03 Pro Terms, 04 Privacy, 05 Cookies, 06 Subprocessors + DPA checklist, 07 Billing and Refunds, 08 Billing email copy, 09 SMS Terms, 10 Twilio 10DLC worksheet, 11 AI Disclosure, 12 Accessibility, 13 DMCA, 14 Community Guidelines and Reviews, 15 Security disclosure, 16 Operating Agreement (two-member, vesting, deadlock, exit clauses), 17 Formation and Compliance Runbook, 18 Consent Copy Sheet, 19 IP Assignment, 20 Contributor Agreement, 21 NDA, 22 FCRA background check pack, 23 Homeowner Data Use Addendum, 24 Incident Response Plan, 25 Law Enforcement Policy, 26 Record Retention Schedule, 27 Founder Vesting and 83(b) Guide, 99 Facts sheet (internal).
- Every document uses the same placeholders: {{LLC_NAME}}, {{BRAND}}, {{DOMAIN}}, {{ADDRESS}}, {{LEGAL_EMAIL}}, {{SUPPORT_EMAIL}}, {{PRIVACY_EMAIL}}, {{SECURITY_EMAIL}}, {{DMCA_AGENT_*}}, {{EFFECTIVE_DATE}}. One find-and-replace fills the whole set. The site fills them automatically from env vars (src/lib/legal.ts).

**Site (uncommitted on main as of 2026-09-02 evening)**
- Legal pages render from markdown in src/content/legal. 15 routes plus /.well-known/security.txt.
- Auto-renewal consent checkbox on every checkout, enforced server-side. Legal name, address, and refund link on pricing and checkout.
- SMS: STOP and START confirmation texts, opt-in confirmation text rate-limited to 2 per day per user, SMS Terms linked at the checkbox.
- AI disclosure line at the top of every Ask session. Insurance chips say "self-reported".
- Email unsubscribe no longer blocks account, billing, or active-job mail. Email footer reads the real address once env vars are set.
- Deleting a homeowner account scrubs their identity from pro client records tied to their jobs.
- Skip link, reduced motion, footer legal links everywhere, pro onboarding acknowledgment, consent lines on review, photo upload, job post, and account deletion.
- Verification: typecheck 0, lint 0, full test suite green except one search debounce test that flakes under load and passes alone.

## Next steps

Do these in order. Items 1 to 4 are blocking.

1. **Fill in doc 16's "Choices to make" box:** 3 or 4 years vesting, single or double trigger acceleration, Landen's pre-formation vesting credit (default 6 months), William's decision domain for the tiebreaker, and the dollar threshold for "major decisions". Ownership is set at 50/50. Then both of you sign 16 and 19 the same day.
2. **File the LLC** on bizfile.sos.ca.gov (Articles of Organization, $70) and get the EIN at irs.gov (free, same day; answer "partnership" for tax classification). Statement of Information within 90 days ($20). Runbook 17, Part 1.
3. **File both 83(b) elections** within 30 days of signing. Certified mail, keep the receipt. Doc 27 has the exact steps. Missing this deadline cannot be fixed.
4. **Pick the brand and buy the domain.** Then set up legal@, support@, privacy@, security@ mailboxes and set the NEXT_PUBLIC_LEGAL_* env vars in Vercel (list in docs/LEGAL-TODO.md in the repo). Until then the site shows bracketed TODO placeholders on purpose.
5. Open the business bank account. Move Stripe, Twilio, Resend, Vercel, Supabase, and Apple billing to the LLC and EIN.
6. Register the DMCA agent at dmca.copyright.gov ($6) and paste the agent details into the env vars.
7. Book the lawyer hour. Send docs 02, 03, 04, 07, 09, 16, 19, 22, 23. Ask for a fixed-fee review and markup, not a rewrite. Andrew Gale, Incorporation Attorney, Orange, (714) 634-4838 is the listing you found. Adams and Pham in Costa Mesa is the better fit for the marketplace terms if Gale hesitates.
8. Sign the vendor DPAs (doc 06 appendix) before real user volume.
9. Get insurance quotes: general liability, tech E&O, cyber. Fill in the insurer hotline in doc 24.
10. Twilio 10DLC brand and campaign registration using doc 10, after the SMS Terms page is live.
11. Decide Apple in-app purchase: StoreKit for Plus and Pro membership, or no buy button in the iOS app with subscriptions on the web only. Not needed while it ships as a web app.
12. Do not turn on Checkr background checks until the FCRA screens in doc 22 are built into the pro flow.
13. Commit and push the site wave when you say so. Then 5 live checks on Vercel.
14. Annual calendar is in doc 17, Part 3: franchise tax, Form 568 and 1065, Statement of Information every 2 years, DMCA renewal every 3 years, policy review yearly.

## What worked

- Drafting from a single facts sheet built from a code audit, then verifying every claim against the code a second time. The verifier caught 8 mismatches the drafters had made, including quiet hours, credit rules, and things the code already did that we thought it didn't.
- Placeholders instead of guessing the entity name, address, or brand. The whole set survives a rename.
- Markdown as the source for site pages. Editing a policy is now editing a text file, and Drive and the site hold the same text.
- Red-teaming the code changes. Two independent reviews found a critical bug in the deletion purge (a stranger's phone number could be used to wipe their records across pros) and a cost amplification in the privacy signal logging. Both fixed the same day.
- Asking a fresh agent "what is missing" after the set looked complete. That is what surfaced the co-founder and IP assignment problem, the FCRA requirement, and the Apple in-app purchase question.

## What didn't

- The first pass assumed the LLC was single-member. The code credited William as co-founder the whole time. The operating agreement had to be redone. Lesson: confirm ownership before drafting company documents.
- The facts sheet was wrong twice: it said renewal reminder emails did not exist (they did) and it missed two vendors (Open-Meteo weather, CPSC recalls). Drafters who read the code caught both.
- Parallel workers editing the same repo produced false test failures mid-run. Every "pre-existing failure" report had to be re-checked on a clean checkout. One real pre-existing failure (a landing page test) was fixed along the way.
- Uploading large documents to Drive through the main session is slow and was interrupted twice. A fresh, small agent per batch is the reliable way.
- Batch arbitration clauses: a drafter added one because the instructions asked for it; the existing site had deliberately removed it because the Ninth Circuit struck a similar clause. Removed again. Lesson: the instructions are not always right.

## Important research

- **Entity:** a California LLC costs $70 to file and $800 a year minimum tax, no first-year waiver anymore. S corp only saves money above roughly $80,000 to $100,000 profit because of payroll costs and California's 1.5% S corp tax. Delaware or Wyoming saves nothing for a California-based founder. Beneficial ownership (BOI) reporting no longer applies to US companies.
- **Liability:** lead marketplaces are actively sued. HomeAdvisor paid up to $7.2M to the FTC in 2023 over lead quality claims to contractors. Thumbtack faces a class action over junk leads. Angi has multiple 2025 TCPA text suits at $500 to $1,500 per message. An LLC shields personal assets from contract and platform claims but not from your own negligence or texts you personally send in violation of TCPA.
- **Brand:** Shogun Enterprises, reg. 5,536,632, HEARTH, class 9, contractor financing and software. Plain "Hearth" is also taken as an App Store name. A different brand is the clean path. Run a real USPTO clearance on the top two candidates before buying a domain.
- **California auto-renewal law** (amended July 1, 2025): clear disclosure next to the buy button, a separate affirmative consent, an acknowledgment with cancel instructions, one-click online cancel, reminders before a trial ends and before annual renewals, 30 days notice of price changes. The federal Click-to-Cancel rule was vacated, but ROSCA still applies.
- **TCPA:** the FCC one-to-one consent rule was vacated in January 2025, but prior express written consent is fully alive. Carriers require the exact opt-in language, STOP and HELP handling, and a STOP confirmation as the last message.
- **CCPA:** applies at 100,000 consumers or $26.6M revenue, but the policy is written as if it applies. Sharing a lead with a pro is not a "sale" because the homeowner directs it and the pro is contractually restricted (doc 23 is what makes that true). California breach notice law has no size exemption.
- **FCRA:** background checks need a stand-alone disclosure and a separate authorization, plus a two-step adverse action process, even for contractors. Checkr is the reporting agency; we are the user.
- **Accessibility:** California's Unruh Act adds $4,000 per violation to ADA website claims, and California is about 40% of all US web accessibility suits. The statement is honest about gaps and gives a contact.
- **Reviews:** FTC Consumer Reviews rule (16 CFR 465), effective October 2024. No paid reviews, no gating, no suppression. The code already complied; the policy now says so.
- **Not needed:** COPPA (adults only), California Age-Appropriate Design Code (enjoined), AB 587 (only above $100M revenue), Delete Act data broker registration (we have direct relationships), AB 2013 training data transparency (falls on Anthropic), CPRA audit regs (far above our size), seller's permit (services are not taxable).

## Other notes

- The legal contact in the code still points at Landen's personal Gmail until the env vars are set. Two lawyers had already flagged that as a risk; the fix is the mailboxes in step 4.
- The pro onboarding now requires accepting the Pro Terms with a checkbox and records it separately from the general terms.
- Wallet credit for leads is not cash and only applies to lead fees, never to membership. Ghost protection re-charges the fee only if the wallet can cover it. Both are now stated exactly in docs 03 and 07.
- Anthropic keeps API data up to 30 days for trust and safety and does not train on it. Ask transcripts never leave the user's browser.
- The insurance-on-file gate for major leads (migration 0153) is a real product rule and is now in the Pro Terms.
- If you ever hire, add an employee handbook, workers' comp, and the California employee data privacy notice. Not needed today.
- Memory for this work is saved under the Claude project memory as "hearth-legal-paperwork-2026-09-02".
