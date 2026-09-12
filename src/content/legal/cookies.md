# Cookie and Tracking Notice

Last updated: {{EFFECTIVE_DATE}}

**Plain-language summary:** {{BRAND}} uses a small number of cookies and browser-storage items to keep you signed in and make the app work correctly. None of them are advertising cookies. We use a cookieless analytics service from our hosting provider that sets no cookie at all, and we do not need to show you a cookie-consent banner, because nothing we use requires one under California law. You can control or delete cookies through your own browser settings at any time.

This notice supplements our Privacy Policy and lists, specifically, the cookies and similar technologies {{BRAND}} uses.

## Cookies we set

All of the following are first-party cookies: set by {{BRAND}} itself, read only by {{BRAND}}, never by an advertiser or a tracking network.

| Cookie | Purpose | Duration | First or Third Party |
|---|---|---|---|
| `sb-*-auth-token` (Supabase) | Keeps you signed in between visits | Managed automatically by Supabase's authentication library | First-party (set by our server through Supabase) |
| `oaktend_did` | A random device identifier, used only to notice when the same device is being used to claim more than one free trial | 400 days | First-party, httpOnly (a page script cannot read it) |
| `oaktend_fp` | A hash of a few browser characteristics, used the same way as `oaktend_did`, to help link accounts that look like the same person | Same lifetime as `oaktend_did` | First-party, set by page script, not httpOnly |
| `oaktend_pwrecovery` | Lets the "set a new password" screen work after you click a password-reset link, and stops a stranger from reaching that screen just by typing its address | 15 minutes | First-party, httpOnly and secure |
| `oaktend_seen` | Records your last activity, so a device that goes 30 days without visiting is automatically signed out | 35 days | First-party, httpOnly and secure; this is a security control and cannot be turned off |
| `oaktend_active_home` | Remembers which property is currently active, for anyone managing more than one home | 1 year | First-party, httpOnly, functional only |
| `oaktend_flash` | Carries a one-time confirmation or error message, such as "Job posted," which is read once and cleared right after | About 30 seconds | First-party, functional only |
| `oaktend_last_reason` | Remembers why you were shown a paywall or upgrade prompt (for example, after asking a question or filing a report), so we can show the right message on the next page | Short-lived | First-party, functional only |
| `oaktend_ho_chat_seen` / `oaktend_chat_seen` | Tracks which chat threads and messages you've already viewed, so unread counts are accurate | 180 days | First-party, functional only |
| `oaktend_campaign` | Remembers which referral or campaign link brought you here, so that if you sign up we can credit the right one | 30 days | First-party, httpOnly |
| `oaktend_gpc_seen` | Records that your browser's Global Privacy Control signal was noticed, so we log it once instead of on every page you open | Until you close your browser | First-party, httpOnly |

Cookies set before our September 2026 name change carry the earlier prefix. We still read them during a transition period that ends December 31, 2026, and after that they are ignored.

## Browser local storage (not cookies)

These values live only in your own browser's local storage. They are never sent to our servers, and clearing your browser's site data clears all of them.

- **Theme preference** (`oaktend-theme`): whether you're using light or dark mode.
- **Ask {{BRAND}} chat history** (keyed to your account, for example `oaktend_ask_chat:<your account id>`): the actual text of your conversations with Ask {{BRAND}}. This is the same chat history our Privacy Policy describes as never stored on our servers; it lives only in this browser, on this device.
- **Ask {{BRAND}} usage lock and retention preference**: whether you've already used today's questions, and how long you'd like your chat history kept in this browser.
- **Per-thread "seen" markers**: a timestamp of when you last opened a given message thread, so unread counts stay accurate without a server round trip.
- **Various "seen it" or "dismissed" flags**: for onboarding guides, walkthroughs, referral-ask prompts, the add-to-home-screen prompt, the "enjoying OakTend?" review prompt, and push-notification prompts, so we don't show you the same nudge over and over.
- **Draft autosave**: in-progress onboarding form answers and pro message drafts, so you don't lose your typing if you navigate away.
- **Weather unit preference**: whether you'd rather see Fahrenheit or Celsius.

None of these local-storage items are shared across accounts or devices, and none of them are used for advertising.

## Third-party cookies

**Stripe.** When you check out for {{BRAND}} Plus, a pro membership, or a lead fee, you are taken to Stripe's own hosted checkout page. Stripe may set its own cookies there, on Stripe's domain, for fraud prevention and to process your payment. {{BRAND}} does not set, read, or control these cookies; see Stripe's own privacy policy for what they do.

**Vercel.** Our hosting provider also provides Vercel Web Analytics, a cookieless page-view counter. It sets no cookie and stores nothing in your browser. It records page views, referrer, country and region, device type, and the outcome of a few in-app actions we define, without any identifier that lasts beyond a day. Details are in the Analytics section of our Privacy Policy.

**No advertising trackers, anywhere.** {{BRAND}} does not run Google Analytics, Meta Pixel, PostHog, session-replay tools, or any advertising service. We do not use retargeting, and we do not build an advertising profile of you from cookies or any other source.

## Your controls

You can block, delete, or be warned about cookies through your browser's own settings; every major browser has this built in. Blocking the Supabase authentication cookie will prevent you from staying signed in. Blocking `oaktend_pwrecovery` will prevent password reset from working. None of the other cookies are required for {{BRAND}} to function, though a few nudges and preferences may reappear if you clear your local storage.

We honor the Global Privacy Control (GPC) signal, where your browser sends it, as a valid opt-out preference. Because we do not sell or share personal information in the first place, honoring GPC does not change what happens to your data, but we wanted to say so directly. We do not respond specifically to a "Do Not Track" browser signal, because {{BRAND}} runs no cross-site tracking for that signal to turn off.

For what we collect and why beyond cookies, see our Privacy Policy.
