import Link from "next/link";

// Shared breadcrumb trail for pages nested more than one level under a tab
// root (account settings, a single guide, the hub pages off Home). Never
// rendered on the four main tabs themselves, or on auth pages - those are the
// top of their own trees, not nested under anything. See the "where" list in
// the launch-polish research doc for the exact page inventory.
//
// Props-driven, not derived from usePathname(): an auto-derived route->label
// map gets dynamic segments wrong (a pro's client page needs the client's
// name, not its id) and can't express a "logical parent" that differs from
// the URL parent. Each page composes its own array instead; a small shared
// map of the reusable static crumbs (Account, Guides, ...) can live wherever
// a page wants to import it from, so wording doesn't drift page to page.
//
// Server component, no client JS: nothing here depends on session state, only
// on what the calling page already knows at render time.

export type Crumb = {
  label: string;
  // Omitted on the last item: the current page renders as plain text, never
  // a link to itself.
  href?: string;
};

// The page list this ships on today tops out at 3 levels (Home > Account >
// Notifications, Home > Clients > a name), so a simple "collapse everything
// between the ends" rule is enough - no need for a collapsing-menu pattern
// built for a depth nothing here reaches yet.
const COLLAPSE_ABOVE = 3;

export default function Breadcrumbs({ items }: { items: Crumb[] }) {
  const collapsed: Crumb[] =
    items.length > COLLAPSE_ABOVE
      ? [items[0], { label: "…" }, items[items.length - 1]]
      : items;

  return (
    <nav aria-label="Breadcrumb" className="mb-4">
      {/* Single line, no wrap: overflow-hidden on the row plus a truncating
          max-width on each middle crumb keeps a long chain from wrapping to a
          second line on a phone. */}
      <ol className="flex items-center gap-1 overflow-hidden whitespace-nowrap text-sm">
        {collapsed.map((item, i) => {
          const isLast = i === collapsed.length - 1;
          const isLink = Boolean(item.href) && !isLast;
          return (
            <li key={`${item.label}-${i}`} className="flex min-w-0 items-center gap-1">
              {i > 0 && (
                <span className="text-stone-400 dark:text-stone-500" aria-hidden="true">
                  &rsaquo;
                </span>
              )}
              {isLink ? (
                // Same 44px phone tap target as every other back link in the
                // app (contact/page.tsx, privacy/page.tsx, the old "All
                // guides" links this replaces); sm and up is untouched.
                <Link
                  href={item.href as string}
                  className="max-w-[8rem] truncate text-stone-500 hover:text-bark-700 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center sm:max-w-none dark:text-stone-400 dark:hover:text-stone-300"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  className="max-w-[8rem] truncate text-stone-700 sm:max-w-none dark:text-stone-300"
                  aria-current={isLast ? "page" : undefined}
                >
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// JSON-LD BreadcrumbList, for the public pages that want the SEO rich-result
// eligibility (guides today; anything else public and nested later). Kept
// separate from the visible Crumb type: schema.org's ListItem wants "name",
// not "label", and the last item's URL is optional-but-nice rather than
// omitted outright the way the visible trail treats the current page.
export type JsonLdCrumb = {
  name: string;
  // Relative ("/guides") or absolute; resolved against siteUrl when relative.
  // Omit on the last item to match the current-page-has-no-item convention,
  // or pass its canonical URL - both are valid schema.org, and a URL is
  // marginally better for rich-result eligibility.
  href?: string;
};

export function breadcrumbListJsonLd(items: JsonLdCrumb[], siteUrl: string) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      ...(item.href
        ? { item: item.href.startsWith("http") ? item.href : `${siteUrl}${item.href}` }
        : {}),
    })),
  };
}

// Renders the <script type="application/ld+json"> tag itself, matching the
// escaping the FAQ JSON-LD on every guide page already uses (dangerous
// characters can't close the script tag early).
export function BreadcrumbJsonLd({
  items,
  siteUrl,
}: {
  items: JsonLdCrumb[];
  siteUrl: string;
}) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(breadcrumbListJsonLd(items, siteUrl)).replace(/</g, "\\u003c"),
      }}
    />
  );
}
