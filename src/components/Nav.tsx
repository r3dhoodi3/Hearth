import Link from "next/link";
import Logo from "@/components/Logo";
import HomeSwitcher from "@/components/HomeSwitcher";
import NavLinks from "@/components/NavLinks";
import ProfileMenu from "@/components/ProfileMenu";
import ToolsMenu from "@/components/ToolsMenu";
import GlobalSearch from "@/components/GlobalSearch";
import NotificationBell from "@/components/NotificationBell";
import UnreadProvider from "@/components/UnreadProvider";
import type { PropertyWithShared } from "@/lib/property";

export default function Nav({
  homes,
  activeId,
  name,
  hasPlus,
}: {
  homes: PropertyWithShared[];
  activeId: string;
  name: string | null;
  hasPlus: boolean;
}) {
  const LINKS = [
    { href: "/dashboard", label: "Home", icon: "home" },
    {
      href: "/contractors/browse",
      label: "Browse Pros",
      shortLabel: "Pros",
      icon: "pros",
    },
    {
      href: "/contractors",
      label: "Post a Job",
      shortLabel: "Post",
      icon: "post",
    },
    {
      href: "/chats",
      label: "Messages",
      liveBadge: "homeowner" as const,
      icon: "messages",
    },
  ];

  return (
    <>
    {/* Single provider for both NavLinks renderings below (desktop top strip
        + mobile bottom bar): one poll and one realtime subscription for the
        unread-messages badge instead of each rendering running its own. */}
    <UnreadProvider role="homeowner">
    <header className="sticky top-0 z-30 border-b border-stone-200 bg-bark-50 dark:border-white/10 dark:bg-stone-900">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-6 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 text-lg font-semibold text-stone-900 dark:text-stone-100"
          >
            <Logo className="h-6 w-6 text-bark-700 dark:text-stone-400" />
            Hearth
          </Link>
          <span className="hidden text-stone-300 sm:inline dark:text-stone-500">·</span>
          {/* Project to just the fields the client switcher renders. The full
              property rows carry sensitive columns (mortgage_balance,
              purchase_price, assessed_value, insurance_premium, owner names,
              parcel_id, the owner's user_id) that must not be serialized into
              this "use client" component's RSC payload. */}
          <HomeSwitcher
            homes={homes.map((h) => ({
              id: h.id,
              address_line1: h.address_line1,
              isShared: h.isShared,
            }))}
            activeId={activeId}
          />
        </div>
        <div className="flex items-center gap-1">
          {/* Primary destinations. Desktop/tablet (sm and up) keep this exact
              top strip, unchanged. Below sm it is hidden and the same links
              render as the fixed bottom tab bar further down. */}
          <div className="relative hidden min-w-0 sm:block">
            <nav className="-mx-1 flex items-center gap-1 overflow-x-auto px-1">
              <NavLinks links={LINKS} />
            </nav>
          </div>
          {/* Home-page destinations + Plus tools. Lives outside the
              overflow-x-auto nav strip so its dropdown isn't clipped. */}
          <ToolsMenu hasPlus={hasPlus} />
          <div className="hidden sm:block">
            <GlobalSearch />
          </div>
          {/* Mobile-only entry to /search; the inline GlobalSearch box is
              hidden below sm and the page had no other way in. */}
          <Link
            href="/search"
            aria-label="Search"
            className="flex h-11 w-11 items-center justify-center rounded-full text-stone-500 hover:bg-bark-50 hover:text-bark-700 sm:hidden dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-300"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
          </Link>
          <NotificationBell />
          {/* Account-only menu (profile, household, notifications, help, log
              out; account security is reached via Edit profile's tabs).
              Navigation destinations live in ToolsMenu - including Emergency,
              which used to be duplicated here too. */}
          <ProfileMenu
            name={name}
            hasPlus={hasPlus}
            themeToggle
            links={[
              { href: "/account", label: "Edit profile" },
              { href: "/issues", label: "Issues" },
              { href: "/account/household", label: "Household" },
              { href: "/account/notifications", label: "Notifications" },
              { href: "/account/privacy", label: "Your privacy rights" },
              { href: "/account/help", label: "Help" },
            ]}
          />
        </div>
      </div>
    </header>
    {/* Phone-only bottom tab bar: the same primary destinations as the top
        strip above, laid out like a native app so nothing needs horizontal
        scrolling on a narrow viewport. Hidden from sm up, where the top
        strip already handles this. Kept to <=48px tall so it fits inside
        the pb-24 bottom padding AppLayout's <main> already reserves below
        sm for the floating Ask Hearth dock; globals.css also nudges that
        dock and the toast notifier above this bar on the same breakpoint. */}
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-stone-200 bg-bark-50 pb-[env(safe-area-inset-bottom)] sm:hidden dark:border-white/10 dark:bg-stone-900"
    >
      <NavLinks links={LINKS} variant="bottom" />
    </nav>
    </UnreadProvider>
    </>
  );
}
