import Link from "next/link";
import Logo from "@/components/Logo";
import NavLinks from "@/components/NavLinks";
import ProfileMenu from "@/components/ProfileMenu";
import NotificationBell from "@/components/NotificationBell";
import UnreadProvider from "@/components/UnreadProvider";
import SidePill from "@/components/SidePill";
import { setPreferredSideAction } from "@/lib/sideActions";

export default function ProNav({
  company,
  hasHome,
}: {
  company: string | null;
  // Does this account also have a homeowner side (a home of their own, or one
  // shared with them)? Decides whether the profile menu offers a switch or an
  // invitation to add one.
  hasHome: boolean;
}) {
  // Primary nav stays to the four or five destinations a pro checks daily.
  // Playbook, Tools, and Membership moved into the profile menu's "Grow"
  // group below: useful, but not a daily-use tab.
  const LINKS = [
    { href: "/pro", label: "Leads", icon: "leads" },
    {
      href: "/pro/chats",
      label: "Messages",
      liveBadge: "contractor" as const,
      icon: "messages",
    },
    { href: "/pro/crm", label: "Clients", icon: "clients" },
    {
      href: "/pro/business",
      label: "My Business",
      shortLabel: "Business",
      icon: "business",
    },
  ];

  // Phone bottom bar: the same four destinations as the top strip, mirroring
  // the homeowner Nav. The copilot briefly had a tab of its own here; it lives
  // inside Messages now, as a pinned conversation at the top of /pro/chats
  // that opens the full-screen /pro/ask view (see AskHearthRow), with NavLinks
  // treating /pro/ask as a child of Messages so the tab stays lit while you're
  // in there. The floating pill remains desktop-only (see pro/layout.tsx).
  const BOTTOM_LINKS = LINKS;

  return (
    <>
    {/* Single provider for both NavLinks renderings below (desktop top strip
        + phone bottom bar), mirroring Nav.tsx: one poll and one realtime
        subscription for the unread-messages badge instead of each rendering
        running its own. Without it the pro shell paid for two of each on
        every page. */}
    <UnreadProvider role="contractor">
    <header className="sticky top-0 z-30 border-b border-stone-200 bg-hearth-50 dark:border-white/10 dark:bg-stone-900">
      {/* One row at every width, mirroring the homeowner Nav: brand left,
          bell + profile pinned top-right, nothing stacks on a phone. */}
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6 sm:py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href="/pro"
            className="flex shrink-0 items-center gap-2 whitespace-nowrap text-lg font-semibold text-stone-900 dark:text-stone-100"
          >
            <Logo className="h-6 w-6 text-hearth-700 dark:text-hearth-400" />
            <span>
              Hearth{" "}
              {/* Hidden until lg: at 768-900px (md), "Leads / Messages /
                  Clients / My Business" plus the Business pill already fill
                  the row, so "for Pros" was getting squeezed by its shrinkable
                  flex parent and wrapping under "Hearth" (measured two lines,
                  reading as overlapping letters). Only lg+ has the slack. */}
              <span className="hidden font-normal text-stone-500 lg:inline dark:text-stone-400">
                for Pros
              </span>
            </span>
          </Link>
          {/* Which side of the account you're on. Only for accounts that
              hold both sides (hasHome) - a pro-only account sees no pill.
              Desktop only here; the max-sm twin lives just below the header
              row so it can't push this line into two rows next to the bell
              and avatar. */}
          {hasHome && <SidePill label="Business" accent="hearth" className="hidden sm:inline-block" />}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          {/* Primary destinations. Desktop/tablet (sm and up) keep this exact
              top strip, unchanged. Below sm it is hidden and the same links
              render as the fixed bottom tab bar further down. */}
          <nav className="-mx-1 hidden items-center gap-1 overflow-x-auto px-1 sm:flex">
            <NavLinks links={LINKS} accent="hearth" />
          </nav>
          <NotificationBell />
          <ProfileMenu
            name={company}
            themeToggle
            links={[
              // First entry, mirroring the homeowner ToolsMenu's askLink: the
              // copilot otherwise lives only as a pinned row inside Messages
              // (AskHearthRow, /pro/chats), which a tester never found. This
              // is the second door, reachable from every page in the pro
              // shell, not just the inbox.
              { href: "/pro/ask", label: "Ask Hearth" },
              // Company profile is the pro's storefront: top-level. "Edit
              // business" says what you DO here.
              { href: "/pro/profile", label: "Edit business profile" },
              { href: "/pro/playbook", label: "Playbook" },
              { href: "/pro/tools", label: "Back office" },
              { href: "/pro/plus", label: "Membership" },
              { href: "/pro/billing", label: "Billing" },
              { href: "/pro/privacy", label: "Your privacy rights" },
              { href: "/pro/help", label: "Help" },
              // The other side of the account, mirroring Nav.tsx: a switch
              // records where they land next time; adding a home is a plain
              // link into onboarding, told explicitly that this is an addition
              // so it doesn't read as a wrong turn and send them back here.
              hasHome
                ? {
                    href: "/dashboard",
                    label: "Switch to your home",
                    action: setPreferredSideAction,
                    side: "homeowner" as const,
                  }
                : {
                    href: "/onboarding?add=home",
                    label: "Add your home",
                  },
            ]}
          />
        </div>
      </div>
      {/* Phone twin of the desktop SidePill above. Mirrors Nav.tsx: its own
          quiet line under the logo instead of risking a wrap on an already
          tight phone header. */}
      {hasHome && (
        <div className="px-4 pb-1.5 sm:hidden">
          <SidePill label="Business" accent="hearth" />
        </div>
      )}
    </header>
    {/* Phone-only bottom tab bar, mirroring the homeowner Nav (see
        Nav.tsx for the full rationale). Kept to <=48px tall so it fits
        inside the pb-24 bottom padding pro/layout.tsx's <main> already
        reserves below sm; globals.css nudges the toast notifier above this
        bar on the same breakpoint. */}
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-stone-200 bg-hearth-50 pb-[env(safe-area-inset-bottom)] sm:hidden dark:border-white/10 dark:bg-stone-900"
    >
      <NavLinks links={BOTTOM_LINKS} variant="bottom" accent="hearth" />
    </nav>
    </UnreadProvider>
    </>
  );
}
