"use client";

// STREAMING FIX, not a behaviour change. Mirrors src/components/pro/SetupChecklist.tsx
// (investigated in scratchpad/debug-DBG3.md): PERKS.map() used to render six
// description-heavy cards or list rows inline inside a Server Component, and on this
// page that block sits at (or past) the point where React Flight's 3200-byte-per-row
// serialization budget runs out. Past that budget Flight defers every further element
// it meets into its own row, which Fizz then streams as an out-of-order segment - a
// <template id="P:n"> hole nested inside the page's own markup plus a late $RS(...) fill
// script, instead of the one clean top-level hole a healthy page has. That is the exact
// shape DBG3 found on /pro (eight holes, chained through SetupChecklist's <ul>) and it
// matches the React #418 / "$RS ... parentNode" hydration failure reported on /pro/plus.
//
// As a client module this whole perks block becomes ONE client reference in the parent
// page's Flight payload, with plain-data props - so there is nothing left at the tail of
// the row for Flight to defer. No interactivity here; this is a streaming-shape fix.
//
// 2026-08-30 follow-up: the icons used to cross the boundary as already-rendered leaf
// ELEMENTS (`icon: <p.icon className="h-5 w-5" />`), which put six elements back inside
// this component's props. Deep in a props object is still inside the page's Flight row,
// so once the row passed 3200 bytes the LAST perk's icon was deferred on its own -
// measured live as `"icon":"$L32"` on /pro/plus. The icon is a NAME now and this module
// renders it, so the props carry nothing but strings. The rendered markup is unchanged:
// the two class strings below are the two the page used to pre-render, picked by the
// same `variant` that already decided the layout.

import { Percent, Gift, DollarSign, Bot, Globe, BarChart3, Zap } from "lucide-react";
import {
  PRO_LEAD_DISCOUNT_PCT,
  PRO_DEPOSIT_BOOST_PTS,
  COLD_START_FREE_ALERTS,
} from "@/lib/constants";

// The icons the perk lineup uses, by name. A bare component reference cannot cross the
// server/client boundary as a prop, and a pre-rendered element re-introduces the very
// deferral this file exists to remove, so the name is the only thing that travels.
const ICONS = {
  percent: Percent,
  gift: Gift,
  dollar: DollarSign,
  bot: Bot,
  globe: Globe,
  chart: BarChart3,
  zap: Zap,
} as const;

export type PerkIcon = keyof typeof ICONS;

export type Perk = { title: string; body: string; icon?: PerkIcon };

// The perk lineup, used by every branch of /pro/plus. Membership is perks
// only: it never changes which jobs a pro can see or apply to. Ordered
// exclusive economics first (the lead discount, credit, deposit boost, AI
// back office); alerts sit last while COLD_START_FREE_ALERTS makes them free
// for everyone.
//
// It lives in this client module rather than in the page for the same
// streaming reason as everything else in this file: the strings are what cross
// the boundary, so the one array can be shared by all three layouts without a
// single element landing in the page's Flight row. Nothing here reads the
// clock, a request, or the locale.
export const PERKS: Perk[] = [
  {
    icon: "percent",
    // "apply fee", not "every lead fee": the discount applies to board
    // applications only (apply_to_lead, 0149). Direct-request unlocks carry
    // no member discount (0104), and a free trial does not qualify
    // (is_pro_member is active-only since 0151), so the old unqualified
    // "every lead fee" headline overstated on both counts. The 2026-08-30
    // monetization audit flagged it; stated honestly now.
    title: `${PRO_LEAD_DISCOUNT_PCT}% off apply fees`,
    // Owner's words: "it does NOT stack with the 15-30%. More incentive to
    // buy." Stated here exactly that plainly, first in the list: it is the
    // most direct incentive to subscribe, priced against the same fee a
    // non-member pays on the leads board. Mirrors apply_to_lead's
    // pro_lead_fee_cents (migration 0149) and bestLeadDiscount in
    // src/lib/leadPricing.ts.
    body: `Every board application's fee drops ${PRO_LEAD_DISCOUNT_PCT}% while your membership is active (the free trial does not count yet, and direct-request unlocks are not discounted). It never stacks with a listing's own aging markdown (15-30% off unclaimed jobs) - you always get whichever discount is bigger, never both added together.`,
  },
  {
    icon: "gift",
    title: "$10 lead credit every month",
    // Mirrors grant_membership_credit in the Stripe webhook: monthly grants
    // are $10 with a 60-day expiry, yearly is $120 up front with a 400-day
    // expiry (it outlives the year). Keep this copy in sync with those terms.
    body: "Each monthly billing cycle drops $10 of bonus lead credit into your wallet, good for 60 days from the day it lands. On the yearly plan the whole $120 lands up front and stays spendable for your entire year.",
  },
  {
    icon: "dollar",
    title: `+${PRO_DEPOSIT_BOOST_PTS}% on every deposit`,
    body: `Every wallet deposit earns an extra ${PRO_DEPOSIT_BOOST_PTS} percentage points of bonus credit, on top of the regular tier bonus.`,
  },
  {
    icon: "bot",
    title: "AI back office",
    // /api/pro-tools ships five tools (estimate, invoice, followup,
    // review_response, overdue); list all five here so this perk isn't
    // undersold. The 250 mirrors DAILY_LIMIT_PLUS in src/lib/aiUsage.ts: the
    // shared per-user daily cap on every AI route. Keep both in sync.
    body: "Draft estimates, invoices, follow-up messages, review responses, and overdue-invoice reminders in seconds, up to 250 drafts a day, so evenings go back to being evenings.",
  },
  {
    icon: "globe",
    title: "A richer public page",
    body: "Every pro already gets a public page with their services, reviews, and contact info. Pro adds your logo, work photos, and an about section so it looks fully yours. Send one link instead of ten screenshots.",
  },
  {
    icon: "chart",
    title: "Win-rate analytics",
    body: "See which jobs you win, what each lead really costs, and where your money works hardest.",
  },
  {
    icon: "zap",
    title: "Instant job alerts",
    // COLD START: while COLD_START_FREE_ALERTS is on, every pro gets these
    // alerts, so the perk says so honestly - and says that it is temporary,
    // which "included right now" left the reader to guess at. The
    // parenthetical drops when the flag flips back to members-only.
    body:
      "The moment a job posts in your trades and area, it hits your email and your phone. Be the first name the homeowner sees." +
      (COLD_START_FREE_ALERTS
        ? " (Free for every pro during launch - after launch, instant alerts are members-only.)"
        : ""),
  },
];

export default function PerksList({
  perks,
  variant,
}: {
  perks: Perk[];
  // "grid": the pitch page's two-up perk cards. "welcome" and "member" are the
  // two flavors of bullet list the other two branches use - a plain icon for
  // "welcome", a green checkmark (no icon prop needed) for "member".
  variant: "grid" | "welcome" | "member";
}) {
  // The two sizes the page used to pre-render, kept exactly: the card layout's
  // icon and the bullet list's smaller, top-aligned one.
  const iconFor = (name: PerkIcon | undefined, cardSize: boolean) => {
    if (!name) return null;
    const Icon = ICONS[name];
    return cardSize ? (
      <Icon className="h-5 w-5" aria-hidden="true" />
    ) : (
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
    );
  };

  if (variant === "grid") {
    return (
      <section className="grid gap-4 sm:grid-cols-2">
        {perks.map((p) => (
          <div key={p.title} className="card">
            <div className="icon-chip">{iconFor(p.icon, true)}</div>
            <h2 className="mt-2 font-semibold text-stone-900 dark:text-stone-100">
              {p.title}
            </h2>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">{p.body}</p>
          </div>
        ))}
      </section>
    );
  }

  // The two bullet-list branches share every class except the <ul> itself:
  // "welcome" sits centered in a bare max-w-2xl page, "member" sits inside a
  // .card that already constrains its own width.
  const ulClass =
    variant === "welcome" ? "mx-auto max-w-md space-y-2 text-left" : "space-y-2";

  return (
    <ul className={ulClass}>
      {perks.map((p) => (
        <li
          key={p.title}
          className="flex items-start gap-2 text-sm text-stone-700 dark:text-stone-300"
        >
          {variant === "member" ? (
            <span className="mt-0.5 font-bold text-green-600 dark:text-green-400">✓</span>
          ) : (
            iconFor(p.icon, false)
          )}
          <span>
            <span className="font-medium text-stone-900 dark:text-stone-100">
              {p.title}.
            </span>{" "}
            {p.body}
          </span>
        </li>
      ))}
    </ul>
  );
}
