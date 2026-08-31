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

// Routes that belong to a tab without living under its path. Ask Hearth is
// reached from a pinned conversation at the top of the Messages list, so
// /ask (and /pro/ask) are children of Messages as far as anyone tapping
// around is concerned - without this the whole bar goes dark the moment the
// assistant opens and there is nothing on screen saying where you are.
const CHILD_ROUTES: Record<string, string[]> = {
  "/chats": ["/ask"],
  "/pro/chats": ["/pro/ask"],
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
// the same active-route logic and data: "top" is the horizontal strip in the
// header on DESKTOP ONLY (lg and up - below that it collided with the
// wordmark, see Nav.tsx); "bottom" is a native-app-style tab (icon over short
// label) for the fixed tab bar phones and tablets get instead.
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
            pathname.startsWith(l.href + "/")) ||
          (CHILD_ROUTES[l.href] ?? []).some(
            (c) => pathname === c || pathname.startsWith(c + "/")
          );

        if (variant === "bottom") {
          const Icon = l.icon ? NAV_ICONS[l.icon] : undefined;
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              // 11px was the smallest primary-navigation text in the app.
              // 12px still fits five tabs at 360px (about 64px of label room
              // each, longest short label measures about 53px), so keep new
              // shortLabels to 8 characters or truncate will bite.
              //
              // The max-lg active-opacity trio is the tab's pressed state: a
              // brief dim while a thumb is on it, which matters because
              // globals.css removes the platform tap highlight and this is the
              // feedback that replaces it. Gated max-lg, not max-sm, because
              // the bottom bar itself lives until lg (Nav.tsx / ProNav.tsx
              // lg:hidden): a tablet in the 640-1023px band shows these tabs
              // too and must not lose the highlight without a replacement.
              // Desktop gains no :active style at all (the bar is gone at lg
              // anyway), so its rendering stays byte-identical. Both shells
              // render their bottom bars through this one variant, so the
              // homeowner and pro sides get the exact same pressed state by
              // construction.
              className={`flex min-h-[48px] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1 text-xs max-lg:transition-opacity max-lg:duration-75 max-lg:active:opacity-60 ${
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
                  <span className="absolute -right-2 -top-1.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-600 px-1 text-[11px] font-semibold text-white">
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
