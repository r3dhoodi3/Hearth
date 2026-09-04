import Link from "next/link";
import Logo from "@/components/Logo";
import GlobalSearch from "@/components/GlobalSearch";
import NavLinks from "@/components/NavLinks";
import ProfileMenu from "@/components/ProfileMenu";
import NotificationBell from "@/components/NotificationBell";
import UnreadProvider from "@/components/UnreadProvider";
import SidePill from "@/components/SidePill";
import { setPreferredSideAction } from "@/lib/sideActions";

export default function ProNav({
  company,
  hasHome,
  backOfficeHref,
}: {
  company: string | null;
  // Does this account also have a homeowner side (a home of their own, or one
  // shared with them)? Decides whether the profile menu offers a switch or an
  // invitation to add one.
  hasHome: boolean;
  // Where the header's "Back office" button sends a tap: /pro/tools when the
  // pro can actually use it (member, or an established non-member with free
  // drafts left), otherwise /pro/plus?reason=tools. Computed server-side in
  // pro/layout.tsx, which already loads the contractor for this request -
  // ProNav stays dumb about the gating rules so only one place decides them.
  backOfficeHref: string;
}) {
  // Five destinations a pro checks daily. Playbook, Tools, and Membership stay
  // in the profile menu's "Grow" group below: useful, but not a daily-use tab.
  //
  // HOME AND LEADS ARE TWO TABS NOW (2026-08-29). /pro used to BE the leads
  // board; it is the Home screen now and the board lives at /pro/leads
  // (PRO_LEADS_HREF). NavLinks already refuses to let an index link like /pro
  // swallow its own sub-pages, so /pro lights up on exactly /pro while
  // /pro/leads lights up on itself - without that carve-out, Home would be lit
  // on every pro screen in the app.
  //
  // Desktop order leads with Home, which is how a top strip reads. The phone
  // bar below uses a different order on purpose.
  const LINKS = [
    { href: "/pro", label: "Home", icon: "home" },
    { href: "/pro/leads", label: "Leads", icon: "leads" },
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

  // Phone AND TABLET bottom bar: the same five destinations, re-ordered so
  // HOME SITS IN THE CENTRE, which is where a thumb rests and where every
  // phone app people already use puts it. Leads and Messages (the two working
  // screens) flank it on the left, Clients and Business on the right.
  //
  // THE SHELL BREAKPOINT IS `lg`, NOT `sm` (changed 2026-08-30), mirroring
  // Nav.tsx: the top strip switched on at 640px but only fitted from about
  // 1024px, so between those widths the pills painted over the wordmark.
  // Desktop at 1024px and up is unchanged; tablets get this bar.
  //
  // Five tabs at 390px: NavLinks gives each a flex-1 column, so about 78px
  // each, with 12px labels. The longest label here is "Messages" at 8
  // characters, which is the ceiling NavLinks' own comment sets, so nothing
  // truncates.
  //
  // The copilot briefly had a tab of its own here; it lives inside Messages
  // now, as a pinned conversation at the top of /pro/chats that opens the
  // full-screen /pro/ask view (see AskHearthRow), with NavLinks treating
  // /pro/ask as a child of Messages so the tab stays lit while you're in there.
  // Home first (2026-08-30). It sat in the centre for one night; the owner
  // asked for the best placement and the answer from Apple's HIG, Material and
  // the field (Airbnb, Angi, Thumbtack, App Store) is the same: the primary
  // destination goes in reading position, leftmost, and the centre slot is
  // for a primary ACTION (post, create), which Hearth's bar does not have.
  const BOTTOM_LINKS = [
    LINKS[0], // Home
    LINKS[1], // Leads
    LINKS[2], // Messages
    LINKS[3], // Clients
    LINKS[4], // Business
  ];

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
              {/* Shown at every width so a pro (especially a pro-only account,
                  which gets no side pill) can tell at a glance they're in the
                  Pro app, not the homeowner one. This used to be hidden below lg
                  because the top nav strip filled the row at md and squeezed the
                  suffix into a wrap - but the strip is lg-only now (it lives in
                  the bottom tab bar below lg), so the top row has the room, and
                  the wordmark's whitespace-nowrap keeps "Hearth for Pros" on one
                  line at phone widths. */}
              <span className="font-normal text-stone-500 dark:text-stone-400">
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
          {/* Primary destinations. Desktop (lg and up) keeps this exact top
              strip, unchanged. Below lg it is hidden and the same links render
              as the fixed bottom tab bar further down. It was `sm:flex`: at
              640-1023px five pills plus the wordmark did not fit one row and
              the strip was painted over the brand. */}
          <nav className="-mx-1 hidden items-center gap-1 overflow-x-auto px-1 lg:flex">
            <NavLinks links={LINKS} accent="hearth" />
          </nav>
          {/* Back office is NOT a header button anymore: it duplicated the
              "Back office" entry already in the profile menu below, and its
              label + icon were crowding the row (the nav pills were overlapping
              at desktop widths). The menu entry now carries the same gated
              backOfficeHref so the member/non-member routing is preserved. */}
          {/* Same smart search as the homeowner header, switched to the pro
              registry and FAQ half. Inline box from sm up, mirroring Nav.tsx. */}
          <div className="hidden sm:block">
            <GlobalSearch side="pro" expandable />
          </div>
          {/* Phone-only entry to /pro/search; the inline box above is hidden
              below sm and the page would have no other way in. Mirrors the
              homeowner Nav's phone search icon, with this shell's accent. */}
          <Link
            href="/pro/search"
            aria-label="Search"
            className="flex h-11 w-11 items-center justify-center rounded-full text-stone-500 hover:bg-hearth-50 hover:text-hearth-700 sm:hidden dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-300"
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
          <ProfileMenu
            name={company}
            themeToggle
            links={[
              // No "Ask Hearth" entry here on purpose: the copilot lives in
              // one place, the pinned row at the top of /pro/chats. A second
              // door in the profile menu is what made it feel bigger than the
              // rest of the app.
              //
              // Company profile is the pro's storefront: top-level. "Edit
              // business" says what you DO here.
              { href: "/pro/profile", label: "Edit business profile" },
              { href: "/pro/playbook", label: "Playbook" },
              { href: backOfficeHref, label: "Back office" },
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
      {/* Phone twin of the desktop side pill: its own quiet line under the
          wordmark rather than risking a wrap on the tight phone header. pl-12
          starts it under the "H" of "Hearth" (past the h-6 logo + gap). On the
          phone it shows the COMPANY NAME (truncated) instead of the generic
          "Business" - the phone has nowhere else the business name is visible,
          not even the profile dropdown. Falls back to "Business" when unset. */}
      {hasHome && (
        // Negative top margin pulls the pill up under the wordmark: the header
        // row's own bottom padding (py-2.5) plus the wordmark's line-height
        // otherwise leave a visible gap between "Hearth for Pros" and this line.
        <div className="-mt-5 pl-12 pb-1.5 sm:hidden">
          <SidePill
            label={company ?? "Business"}
            accent="hearth"
            className="inline-block max-w-[75vw] truncate align-middle"
          />
        </div>
      )}
    </header>
    {/* Phone and tablet bottom tab bar, mirroring the homeowner Nav (see
        Nav.tsx for the full rationale). Kept to <=48px tall so it fits
        inside the pb-24 bottom padding pro/layout.tsx's <main> reserves
        below lg; globals.css nudges the toast notifier and the floating
        docks above this bar on the same lg breakpoint. */}
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-stone-200 bg-hearth-50 pb-[env(safe-area-inset-bottom)] lg:hidden dark:border-white/10 dark:bg-stone-900"
    >
      <NavLinks links={BOTTOM_LINKS} variant="bottom" accent="hearth" />
    </nav>
    </UnreadProvider>
    </>
  );
}
