import Link from "next/link";
import Logo from "@/components/Logo";
import HomeSwitcher from "@/components/HomeSwitcher";
import NavLinks from "@/components/NavLinks";
import ProfileMenu from "@/components/ProfileMenu";
import SidePill from "@/components/SidePill";
import ToolsMenu from "@/components/ToolsMenu";
import AddToHomeScreenNudge from "@/components/AddToHomeScreenNudge";
import GlobalSearch from "@/components/GlobalSearch";
import NotificationBell from "@/components/NotificationBell";
import UnreadProvider from "@/components/UnreadProvider";
import { setPreferredSideAction } from "@/lib/sideActions";
import type { PropertyWithShared } from "@/lib/property";

export default function Nav({
  homes,
  activeId,
  name,
  hasPlus,
  hasPro,
}: {
  homes: PropertyWithShared[];
  activeId: string;
  name: string | null;
  hasPlus: boolean;
  // Does this account also have a pro side (a contractors row)? Decides
  // whether the profile menu offers a switch or an invitation to set one up.
  hasPro: boolean;
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

  // Phone bottom bar: the same four destinations as the top strip. Ask Hearth
  // briefly had a tab of its own here, which made five tabs on a 390px screen
  // and gave the assistant a top-level home it doesn't need. It lives inside
  // Messages instead - a pinned conversation at the top of /chats that opens
  // the full-screen /ask view (see AskHearthRow), with NavLinks treating /ask
  // as a child of Messages so the tab stays lit while you're in there. The
  // floating pill remains desktop-only (see AskHearthDock).
  const BOTTOM_LINKS = LINKS;

  return (
    <>
    {/* Single provider for both NavLinks renderings below (desktop top strip
        + mobile bottom bar): one poll and one realtime subscription for the
        unread-messages badge instead of each rendering running its own. */}
    <UnreadProvider role="homeowner">
    {/* z-40, not z-30: header creates its own stacking context (sticky +
        z-index), which traps ToolsMenu's phone-sheet/scrim (nested inside
        it, at z-50/z-40) inside that context for cross-element paint order.
        The bottom tab bar below is a separate, later sibling at z-30 - with
        the header ALSO at z-30 the tab bar (later in the DOM, same z-index)
        painted on top of the header's entire subtree, including the sheet,
        so taps on the sheet's lower rows hit the tab bar underneath instead.
        Bumping the header above the tab bar's z-30 fixes that without
        touching the sheet's own z-50/z-40, which still order correctly
        relative to each other. Purely a stacking fix: the header only
        occupies the top of the viewport, so it never visually overlaps
        anything else this raises it above. */}
    <header className="sticky top-0 z-40 border-b border-stone-200 bg-bark-50 dark:border-white/10 dark:bg-stone-900">
      {/* One row at every width. Below sm this used to stack into two rows
          (brand line, then the controls left-aligned underneath), which on a
          phone read as a second toolbar. Now the brand + home switcher sit on
          the left and shrink (min-w-0 + truncation) while search, the bell,
          and the profile menu stay pinned top-right like a native app. */}
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6 sm:py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href="/dashboard"
            className="-m-2 flex shrink-0 items-center gap-2 p-2 text-lg font-semibold text-stone-900 sm:m-0 sm:p-0 dark:text-stone-100"
          >
            <Logo className="h-6 w-6 text-bark-700 dark:text-stone-400" />
            {/* Wordmark is desktop-only: on a phone the address is the more
                useful label and the logo alone identifies the app. */}
            <span className="hidden sm:inline">Hearth</span>
          </Link>
          {/* Which side of the account you're on. Only for accounts that
              hold both sides (hasPro) - a homeowner-only account has nothing
              to distinguish, so it sees no pill. Desktop only here; the
              max-sm twin lives just below the header row so it can't push
              this line into two rows next to the bell and avatar. */}
          {hasPro && <SidePill label="Home" accent="bark" className="hidden sm:inline-block" />}
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
        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
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
              // The other side of the account. Switching goes through the
              // action so it also records where they land next time; setting
              // one up is a plain link, since there is nothing to record yet.
              hasPro
                ? {
                    href: "/pro",
                    label: "Switch to your business",
                    action: setPreferredSideAction,
                    side: "contractor" as const,
                  }
                : {
                    href: "/pro/onboarding",
                    label: "Set up your business",
                  },
            ]}
          />
        </div>
      </div>
      {/* Phone twin of the desktop SidePill above. A phone header is already
          tight with the address, search, bell, and avatar on one line, so
          this renders as its own quiet line under the logo instead of
          risking a wrap. */}
      {hasPro && (
        <div className="px-4 pb-1.5 sm:hidden">
          <SidePill label="Home" accent="bark" />
        </div>
      )}
    </header>
    <AddToHomeScreenNudge />
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
      <NavLinks links={BOTTOM_LINKS} variant="bottom" />
    </nav>
    </UnreadProvider>
    </>
  );
}
