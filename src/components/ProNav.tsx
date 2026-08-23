import Link from "next/link";
import Logo from "@/components/Logo";
import NavLinks from "@/components/NavLinks";
import ProfileMenu from "@/components/ProfileMenu";
import NotificationBell from "@/components/NotificationBell";
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

  // Phone bottom bar only, mirroring what the homeowner Nav did with Ask
  // Hearth. The pro copilot used to be reachable only from the floating pill,
  // which on a 390px screen sat on top of whatever was in the bottom-right
  // corner (the /pro/tools cards, the /pro/profile fields, a client's notes).
  // It is a tab now, third of five so a thumb reaches it, and the pill is
  // desktop-only (see pro/layout.tsx). The desktop top strip keeps rendering
  // LINKS above, untouched, because it still has the pill.
  const BOTTOM_LINKS = [
    ...LINKS.slice(0, 2),
    { href: "/pro/ask", label: "Ask Hearth", shortLabel: "Ask", icon: "ask" },
    ...LINKS.slice(2),
  ];

  return (
    <>
    <header className="sticky top-0 z-30 border-b border-stone-200 bg-hearth-50 dark:border-white/10 dark:bg-stone-900">
      {/* One row at every width, mirroring the homeowner Nav: brand left,
          bell + profile pinned top-right, nothing stacks on a phone. */}
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6 sm:py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href="/pro"
            className="flex items-center gap-2 text-lg font-semibold text-stone-900 dark:text-stone-100"
          >
            <Logo className="h-6 w-6 text-hearth-700 dark:text-hearth-400" />
            <span>
              Hearth{" "}
              <span className="hidden font-normal text-stone-500 sm:inline dark:text-stone-400">
                for Pros
              </span>
            </span>
          </Link>
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
    </>
  );
}
