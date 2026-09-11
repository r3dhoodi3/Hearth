"use client";

// The perk grid on the homeowner /plus pitch, the twin of the pro side's
// src/app/pro/plus/PerksList.tsx `variant="grid"`. Same reason it is a client
// module: rendered as ONE client reference in the page's Flight payload with
// plain-data props, so the six description-heavy cards never land at the tail
// of a Server Component row where React Flight's 3200-byte budget would defer
// them into out-of-order segments (the React #418 / "$RS ... parentNode"
// hydration failure documented at the top of PerksList.tsx). No interactivity
// here; this is a streaming-shape twin, not new behaviour.
//
// It replaces the per-card bullet checklists PlanToggle used to carry: the
// cards below are now the price picker only, and what Plus includes is shown
// here as boxes, matching the pro pitch. Every number is read from a constant
// (never typed) so a moved cap can't leave a stale promise on the page; the
// copy is lifted from the reason-banners and comparison table already on this
// page, so nothing new is claimed.

import {
  ClipboardList,
  LineChart,
  ReceiptText,
  FileText,
  Sparkles,
  Home,
} from "lucide-react";
import { PLUS_INCLUDED_HOMES } from "@/lib/constants";

// Icons by name, not as element props: a pre-rendered element re-introduces the
// very deferral this module exists to avoid (see PerksList.tsx's 2026-08-30
// note), so only the string travels and this module renders it.
const ICONS = {
  clipboard: ClipboardList,
  chart: LineChart,
  receipt: ReceiptText,
  file: FileText,
  sparkles: Sparkles,
  home: Home,
} as const;

type PerkIcon = keyof typeof ICONS;

type Perk = { icon: PerkIcon; title: string; body: string };

// What Plus adds, in the order the reason-banners lead with: the money-side
// protections first (plan, forecast, quote check, report), then the AI lift,
// then the capacity. Copy mirrors the reason banners and COMPARISON rows in
// page.tsx so the boxes and the folded table can never disagree.
const PERKS: Perk[] = [
  {
    icon: "clipboard",
    title: "A maintenance plan, auto-built",
    body: "OakTend Plus builds a plan tuned to your home's systems, a few tasks at a time, so upkeep never piles up.",
  },
  {
    icon: "chart",
    title: "Cost forecast & repair fund",
    body: "See what your home will need over the next 10 years, and how much to set aside each month. A big repair becomes a plan, not a panic.",
  },
  {
    icon: "receipt",
    title: "Quote analyzer",
    body: "Plus reads every quote you get, flags anything padded, vague, or duplicated, and writes the message you send back to negotiate.",
  },
  {
    icon: "file",
    title: "Home report for resale & insurance",
    body: "Your home's facts, upkeep record, and the questions to ask, packaged to hand to agents and insurers so they compete for you.",
  },
  {
    icon: "sparkles",
    title: "More Ask OakTend, with photos",
    body: "More questions a day, and photo answers, so you can show it the problem instead of describing it.",
  },
  {
    icon: "home",
    title: `Up to ${PLUS_INCLUDED_HOMES} homes, every alert`,
    body: `Track up to ${PLUS_INCLUDED_HOMES} homes in one place, refresh your home value monthly with trend and equity, and get every proactive alert on every channel.`,
  },
];

// The two-up card grid, matching PerksList's grid variant class for class so
// the homeowner and pro pitches read as the same component.
export default function PlusPerks() {
  return (
    <section className="grid gap-4 sm:grid-cols-2">
      {PERKS.map((p) => {
        const Icon = ICONS[p.icon];
        return (
          <div key={p.title} className="card">
            <div className="icon-chip">
              <Icon className="h-5 w-5" aria-hidden="true" />
            </div>
            <h2 className="mt-2 font-semibold text-stone-900 dark:text-stone-100">
              {p.title}
            </h2>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
              {p.body}
            </p>
          </div>
        );
      })}
    </section>
  );
}
