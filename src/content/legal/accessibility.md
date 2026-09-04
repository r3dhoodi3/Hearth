# Accessibility Statement

Last updated: {{EFFECTIVE_DATE}}

**Plain-language summary:** {{BRAND}} wants everyone, including people using screen readers, keyboard navigation, or other assistive technology, to be able to use the app on the web and on iOS. We are working toward the WCAG 2.2 Level AA standard, we are not there yet, and this page is honest about where we stand and what is still missing. If anything is hard to use, email us at {{SUPPORT_EMAIL}} and we will help, including doing the task for you over email if the site itself is the barrier.

## 1. Our commitment

{{LLC_NAME}} is committed to making {{BRAND}}'s web app and iOS app usable by people with disabilities. We target the Web Content Accessibility Guidelines (WCAG) 2.2, Level AA, as our standard, and we are actively working to identify and fix gaps.

## 2. Current status

{{BRAND}} is **partially conformant** with WCAG 2.2 Level AA. Partially conformant means some parts of the site meet the standard and some do not yet. We have not completed a formal, independent accessibility audit. This statement will be updated as we make progress and as an audit is completed.

## 3. Measures we have taken

- Semantic HTML and ARIA attributes are used throughout the app to support screen readers
- Global focus-visible styles on every interactive element, with a consistent, visible focus ring
- Alt text on images used in the product
- A 44px minimum tap target on primary buttons (`.btn` in our shared styles) and on mobile navigation controls
- Reduced-motion handling on some interactive elements (for example, hover/press animations on clickable cards respect `prefers-reduced-motion`)
- Dark mode with adjusted contrast, including a forced light, high-contrast mode when printing a report
- Keyboard-operable modal flows (for example, the onboarding tour can be closed with Escape as well as a "Skip tour" button)

## 4. Known limitations

We know about the following gaps and are working through them:

- **No skip-to-content link yet.** Keyboard users currently have to tab through the header and navigation on every page before reaching the main content.
- **Reduced motion is only partially handled.** Some animations respect `prefers-reduced-motion` (for example, card hover effects); others do not yet.
- **No formal accessibility audit has been completed.** Our current measures are based on ongoing engineering practice, not an independent WCAG audit.
- **PDF exports (Home Report, insurance packet, tax appeal letter) may not be tagged for screen readers.** We have not verified that generated PDFs meet PDF/UA tagging requirements.
- **Third-party content is outside our direct control.** Payment forms are hosted by Stripe, and SMS delivery is handled by Twilio; we cannot guarantee the accessibility of their hosted interfaces, though we choose vendors that publish their own accessibility commitments where possible.
- **Some color and contrast combinations have not been individually audited** against WCAG 2.2 AA contrast ratios.

## 5. Compatibility

{{BRAND}} is designed to work with:

- Recent versions of Chrome, Safari, Firefox, and Edge on desktop and mobile
- VoiceOver on iOS and macOS
- Standard keyboard navigation (Tab, Shift+Tab, Enter, Escape)

We have not tested against every screen reader and browser combination, particularly on Android's TalkBack and on older browser versions.

## 6. Feedback and contact

If you have trouble using any part of {{BRAND}}, or want to report an accessibility barrier, contact us at {{SUPPORT_EMAIL}}. We aim to respond within 5 business days.

## 7. Alternative access

If a part of the site or app is not accessible to you, email {{SUPPORT_EMAIL}} and describe what you are trying to do. Our support team can complete most account actions on your behalf, including updating your profile, posting or managing a job, reviewing a quote, adjusting notification settings, exporting your data, or deleting your account, so a barrier on the page does not have to stop you from getting the task done.

## 8. Formal complaints

If you are not satisfied with our response, you may also file a complaint with the U.S. Department of Justice's ADA information line at 1-800-514-0301 (or 1-833-610-1264 TTY), or at ada.gov.

## 9. Date of this statement

This statement was last reviewed and updated on {{EFFECTIVE_DATE}}.
