# Security and Responsible Disclosure

Last updated: {{EFFECTIVE_DATE}}

**Plain-language summary:** We protect your data with database-level access rules, encryption, and server-only secrets, and we verify every incoming webhook before trusting it. No system is perfect. If you find a security problem, tell us at {{SECURITY_EMAIL}} before telling anyone else, and we will work with you in good faith and won't pursue legal action for honest, careful research. We do not currently offer a paid bug bounty.

## 1. How we protect your data

- **Row level security on every table.** Our database enforces, at the database layer, which rows a signed-in user may read or write, not just at the application layer. A bug in our application code cannot easily let one user read another user's data.
- **Server-only secrets.** Service keys and other credentials that can bypass row-level security are only usable from server-side code and never sent to a browser.
- **HTTPS everywhere.** All traffic to and from {{BRAND}} is encrypted in transit.
- **Encryption at rest.** Our database and file storage (Supabase) encrypt data at rest as a platform default.
- **Signed and verified webhooks.** Incoming webhooks from Stripe (payments) and Twilio (SMS) are cryptographically verified before we act on them, so a request claiming to be from Stripe or Twilio has to prove it.
- **Upload scanning.** Every file uploaded, whether a homeowner's photo or a contractor's license document, is checked against its actual file content, not the filename or the label your browser sent. We identify the real file type from its byte signature, reject unsupported or disguised file types (like an HTML file renamed to look like an image), enforce a server-side size cap, and strip camera metadata and trailing hidden data from photos before storing them. PDFs are scanned for embedded scripts or auto-run actions and rejected if found.
- **Salted, one-way hashes for fraud signals.** Where we check for signs of abuse, such as the same device or IP used across many accounts, we never store the raw identifier, only a salted cryptographic hash of it, useless to anyone who obtains it without our secret salt.
- **Rate limits.** Actions that could be abused if automated, such as filing reports, are limited per account per hour.
- **Least-privilege service access.** Backend service credentials are scoped to what a given server function actually needs, not one all-powerful key used everywhere.
- **Backups.** Our hosting and database provider maintains routine backups as part of the platform.

## 2. What we ask of you

- Use a strong, unique password for your {{BRAND}} account.
- If your sign-in provider (Google or Apple) offers two-factor authentication, turn it on there. It protects your {{BRAND}} account too, since signing in through them relies on that account being secure.
- If you notice anything suspicious, an account behaving strangely, a message that looks like a phishing attempt, or anything that looks like unauthorized access, tell us right away at {{SECURITY_EMAIL}}.

## 3. Responsible disclosure program

We welcome good-faith security research and want to hear from you if you find a vulnerability.

### Scope

In scope: {{DOMAIN}} and the {{BRAND}} web and iOS apps.

Out of scope:

- Third-party vendors and services we use (Supabase, Vercel, Stripe, Twilio, Resend, Anthropic, and similar providers). Report vulnerabilities in those platforms directly to them.
- Denial-of-service or availability testing of any kind.
- Social engineering of our staff, contractors, or users (phishing, pretexting, and similar).
- Physical security testing of any office, device, or location.

### Rules for testing

If you test in good faith and follow these rules, we consider it authorized research:

- Do not access, copy, modify, or delete data beyond what is strictly necessary to prove the vulnerability exists. A single example is proof; do not go further.
- Do not access another real user's account, messages, photos, or documents. Test against your own account wherever possible.
- Do not disrupt or degrade {{BRAND}} for other users.
- Give us 90 days from your report to investigate and fix the issue before any public disclosure.

### Safe harbor

If you make a good-faith effort to comply with this policy while researching a vulnerability, we will not pursue legal action against you for that research, and will consider it authorized under any applicable computer-use terms. This safe harbor does not extend to testing that violates the rules above: accessing other users' real data, disrupting service, or refusing to give us time to fix a critical issue before going public.

### How to report

Email {{SECURITY_EMAIL}} with a clear description of the vulnerability and its impact, step-by-step reproduction instructions, any proof-of-concept code or screenshots that help us confirm it, the URL or endpoint where you found it, and how you would like to be credited, if at all.

Please do not include real other-user data in your report; if your proof needs an example, use your own account's data or clearly redacted data.

### What you can expect from us

- We will acknowledge your report within 3 business days.
- We will give you a status update within 10 business days of your report.
- We will move quickly to fix issues we confirm as critical.
- If you would like credit for the find, we are glad to give it once the issue is fixed, unless you would rather stay anonymous.

### No bounty program today

We do not currently offer a paid bug bounty program. We are grateful for good-faith research and will credit you if you want, but we do not pay for reports at this time. This may change in the future.

## 4. security.txt

We publish a machine-readable version of this contact information at [/.well-known/security.txt](/.well-known/security.txt), in the format defined by RFC 9116: our security contact, the date this listing expires, and a link to this policy.
