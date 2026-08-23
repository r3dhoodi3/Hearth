"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  AlertTriangle,
  Briefcase,
  MessageCircle,
  Inbox,
  Users,
  Building2,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import LiveUnreadBadge from "@/components/LiveUnreadBadge";

// Icons are resolved HERE (a client component) by string key. Nav/ProNav are
// server components, so their LINKS data must carry a plain string, never a
// Lucide component - passing a function/component across the server->client
// boundary throws "Functions cannot be passed directly to Client Components".
const NAV_ICONS: Record<string, LucideIcon> = {
  home: Home,
  ask: Sparkles,
  issues: AlertTriangle,
  post: Briefcase,
  messages: MessageCircle,
  leads: Inbox,
  clients: Users,
  pros: Users,
  business: Building2,
};

type NavLink = {
  href: string;
  label: string;
  // Compact label for the mobile bottom tab bar (variant="bottom"); falls
  // back to `label` when omitted.
  shortLabel?: string;
  // Icon KEY for the mobile bottom tab bar (see NAV_ICONS); ignored by the top
  // variant. A string, not a component, so it stays serializable across the
  // server->client boundary.
  icon?: string;
  badge?: number;
  liveBadge?: "homeowner" | "contractor";
};

// Highlights whichever link matches the current route. Two renderings share
// the same active-route logic and data: "top" is the existing horizontal
// strip used in the header on tablet/desktop; "bottom" is a native-app-style
// tab (icon over short label) for the mobile fixed tab bar.
export default function NavLinks({
  links,
  variant = "top",
  accent = "bark",
}: {
  links: NavLink[];
  variant?: "top" | "bottom";
  // Which brand accent marks the active/hover link: bark for the homeowner
  // shell (Nav), hearth for the pro shell (ProNav). Kept as a prop instead of
  // reading the route so this component stays a plain rendering of whatever
  // it's handed. Full class strings are spelled out per accent below (not
  // interpolated) so Tailwind's compiler can see them.
  accent?: "bark" | "hearth";
}) {
  const pathname = usePathname();

  return (
    <>
      {links.map((l) => {
        // Exact match, or a nested route under it (but never let an "index"
        // link like /pro - or /contractors, whose /contractors/browse sibling
        // is its own tab - swallow its own sub-pages).
        const active =
          pathname === l.href ||
          (l.href !== "/pro" &&
            l.href !== "/contractors" &&
            pathname.startsWith(l.href + "/"));

        if (variant === "bottom") {
          const Icon = l.icon ? NAV_ICONS[l.icon] : undefined;
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-[48px] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1 text-[11px] ${
                active
                  ? accent === "hearth"
                    ? "font-semibold text-hearth-700 dark:text-stone-300"
                    : "font-semibold text-bark-700 dark:text-stone-300"
                  : "font-medium text-stone-500 dark:text-stone-400"
              }`}
            >
              <span className="relative flex h-6 w-6 items-center justify-center">
                {Icon ? (
                  <span aria-hidden="true">
                    <Icon className="h-5 w-5" />
                  </span>
                ) : null}
                {l.liveBadge ? (
                  <span className="absolute -right-2 -top-1.5">
                    <LiveUnreadBadge role={l.liveBadge} />
                  </span>
                ) : l.badge ? (
                  <span className="absolute -right-2 -top-1.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
                    {l.badge}
                  </span>
                ) : null}
              </span>
              <span className="max-w-full truncate">{l.shortLabel ?? l.label}</span>
            </Link>
          );
        }

        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium ${
              active
                ? accent === "hearth"
                  ? "bg-hearth-100 text-hearth-700 dark:bg-hearth-700 dark:text-stone-300"
                  : "bg-bark-100 text-bark-700 dark:bg-bark-700 dark:text-stone-300"
                : accent === "hearth"
                  ? "text-stone-600 hover:bg-hearth-50 hover:text-hearth-700 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-300"
                  : "text-stone-600 hover:bg-bark-50 hover:text-bark-700 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-300"
            }`}
          >
            {l.label}
            {l.liveBadge ? (
              <LiveUnreadBadge role={l.liveBadge} />
            ) : l.badge ? (
              <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">
                {l.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </>
  );
}
