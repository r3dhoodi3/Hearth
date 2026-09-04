# Cookie and Tracking Notice

Last updated: {{EFFECTIVE_DATE}}

**Plain-language summary:** {{BRAND}} uses a small number of cookies and browser-storage items to keep you signed in and make the app work correctly. None of them are advertising or analytics cookies. We do not use any third-party tracker anywhere in {{BRAND}}, and we do not need to show you a cookie-consent banner, because nothing we use requires one under California law. You can control or delete cookies through your own browser settings at any time.

This notice supplements our Privacy Policy and lists, specifically, the cookies and similar technologies {{BRAND}} uses.

## Cookies we set

All of the following are first-party cookies: set by {{BRAND}} itself, read only by {{BRAND}}, never by an advertiser or a tracking network.

| Cookie | Purpose | Duration | First or Third Party |
|---|---|---|---|
| `sb-*-auth-token` (Supabase) | Keeps you signed in between visits | Managed automatically by Supabase's authentication library | First-party (set by our server through Supabase) |
| `hearth_did` | A random device identifier, used only to notice when the same device is being used to claim more than one free trial | 400 days | First-party, httpOnly (a page script cannot read it) |
| `hearth_fp` | A hash of a few browser characteristics, used the same way as `hearth_did`, to help link accounts that look like the same person | Same lifetime as `hearth_did` | First-party, set by page script, not httpOnly |
| `hearth_pwrecovery` | Lets the "set a new password" screen work after you click a password-reset link, and stops a stranger from reaching that screen just by typing its address | 15 minutes | First-party, httpOnly and secure |
| `hearth_seen` | Records your last activity, so a device that goes 30 days without visiting is automatically signed out | 35 days | First-party, httpOnly and secure; this is a security control and cannot be turned off |
| `hearth_active_home` | Remembers which property is currently active, for anyone managing more than one home | Session-length | First-party, functional only |
| `hearth_flash` | Carries a one-time confirmation or error message, such as "Job posted," which is read once and cleared right after | About 30 seconds | First-party, functional only |
| `hearth_last_reason` | Remembers why you were shown a paywall or upgrade prompt (for example, after asking a question or filing a report), so we can show the right message on the next page | Short-lived | First-party, functional only |
| `hearth_ho_chat_seen` / `hearth_chat_seen` | Tracks which chat threads and messages you've already viewed, so unread counts are accurate | Persistent | First-party, functional only |

## Browser local storage (not cookies)

These values live only in your own browser's local storage. They are never sent to our servers, and clearing your browser's site data clears all of them.

- **Theme preference** (`hearth-theme`): whether you're using light or dark mode.
- **Ask {{BRAND}} chat history** (keyed to your account, for example `hearth_ask_chat:<your account id>`): the actual text of your conversations with Ask {{BRAND}}. This is the same chat history our Privacy Policy describes as never stored on our servers; it lives only in this browser, on this device.
- **Ask {{BRAND}} usage lock and retention preference**: whether you've already used today's questions, and how long you'd like your chat history kept in this browser.
- **Per-thread "seen" markers**: a timestamp of when you last opened a given message thread, so unread counts stay accurate without a server round trip.
- **Various "seen it" or "dismissed" flags**: for onboarding guides, walkthroughs, referral-ask prompts, the add-to-home-screen prompt, the "enjoying OakTend?" review prompt, and push-notification prompts, so we don't show you the same nudge over and over.
- **Draft autosave**: in-progress onboarding form answers and pro message drafts, so you don't lose your typing if you navigate away.
- **Weather unit preference**: whether you'd rather see Fahrenheit or Celsius.

None of these local-storage items are shared across accounts or devices, and none of them are used for advertising.

## Third-party cookies

**Stripe.** When you check out for {{BRAND}} Plus, a pro membership, or a lead fee, you are taken to Stripe's own hosted checkout page. Stripe may set its own cookies there, on Stripe's domain, for fraud prevention and to process your payment. {{BRAND}} does not set, read, or control these cookies; see Stripe's own privacy policy for what they do.

**Vercel.** Our hosting provider does not add any analytics or tracking cookie of its own. It hosts the app; it does not track visitors on our behalf.

**No advertising or analytics trackers, anywhere.** {{BRAND}} does not run Google Analytics, Meta Pixel, PostHog, session-replay tools, or any comparable third-party analytics or advertising service. We do not use retargeting, and we do not build an advertising profile of you from cookies or any other source.

## Your controls

You can block, delete, or be warned about cookies through your browser's own settings; every major browser has this built in. Blocking the Supabase authentication cookie will prevent you from staying signed in. Blocking `hearth_pwrecovery` will prevent password reset from working. None of the other cookies are required for {{BRAND}} to function, though a few nudges and preferences may reappear if you clear your local storage.

We honor the Global Privacy Control (GPC) signal, where your browser sends it, as a valid opt-out preference. Because we do not sell or share personal information in the first place, honoring GPC does not change what happens to your data, but we wanted to say so directly. We do not respond specifically to a "Do Not Track" browser signal, because {{BRAND}} runs no cross-site tracking for that signal to turn off.

For what we collect and why beyond cookies, see our Privacy Policy.
