import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { labelFor, SYSTEM_TYPES, ISSUE_CATEGORIES } from "@/lib/constants";
import { FileText, Bell, Search, Sparkles, type LucideIcon } from "lucide-react";
import Breadcrumbs from "@/components/Breadcrumbs";

// Pages the search can jump to, each with a few keywords so a homeowner does
// not have to know the exact page name.
const ROUTES = [
  { label: "Home", href: "/dashboard", keywords: ["home", "dashboard", "health", "score", "systems"] },
  { label: "Report a problem", href: "/issues", keywords: ["issue", "issues", "problem", "repair", "broken", "leak"] },
  { label: "Post a Job", href: "/contractors", keywords: ["job", "quote", "contractor", "pro", "hire", "estimate"] },
  { label: "Messages", href: "/chats", keywords: ["message", "chat", "quote", "pro"] },
  { label: "Documents", href: "/documents", keywords: ["document", "warranty", "manual", "receipt", "vault", "paperwork", "label"] },
  { label: "Learn", href: "/learn", keywords: ["learn", "guide", "how", "maintenance", "tips"] },
  { label: "Account security", href: "/account/security", keywords: ["password", "security", "account", "delete", "email"] },
  { label: "Your privacy rights", href: "/account/privacy", keywords: ["privacy", "data", "export", "download", "ccpa", "delete", "rights", "california"] },
  { label: "Notifications", href: "/account/notifications", keywords: ["notification", "notifications", "alerts", "preferences", "email"] },
  { label: "Help", href: "/account/help", keywords: ["help", "support", "contact", "faq", "question"] },
];

type Result = {
  label: string;
  sub?: string;
  href: string;
  icon?: LucideIcon | null;
};

export default async function SearchPage(
  props: {
    searchParams: Promise<{ q?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const q = (searchParams.q ?? "").trim();
  const ql = q.toLowerCase();

  const propertyOrNull = await getActiveProperty();
  // The (app) layout (src/app/(app)/layout.tsx) is what sends an account with
  // no claimed home to the right place, and it always redirects when there is
  // no active property. But Next renders the layout and the page in PARALLEL,
  // so this function still runs on that request - and reading .id off the
  // non-null assertion below threw "Cannot read properties of null" on every
  // such GET (live log, 2026-08-30). The response was still the layout's 307,
  // so nobody ever saw it, but a TypeError thrown on a routine redirect is
  // noise that buries real errors. Bail out quietly instead and let the layout
  // own the destination: it knows whether this account belongs on /onboarding,
  // /pro/onboarding or the role picker, and this page does not.
  if (!propertyOrNull) return null;
  const property = propertyOrNull;
  const supabase = await createClient();

  const has = (text: string | null | undefined) =>
    !!text && text.toLowerCase().includes(ql);

  let pages: Result[] = [];
  let systems: Result[] = [];
  let documents: Result[] = [];
  let issues: Result[] = [];
  let reminders: Result[] = [];

  if (ql) {
    pages = ROUTES.filter(
      (r) =>
        r.label.toLowerCase().includes(ql) ||
        r.keywords.some((k) => k.includes(ql) || ql.includes(k))
    ).map((r) => ({ label: r.label, href: r.href }));

    const [sysRes, docRes, issueRes, taskRes] = await Promise.all([
      supabase
        .from("home_systems")
        .select("system_type, material_or_model")
        .eq("property_id", property.id),
      supabase
        .from("documents")
        .select("id, title, brand, model, summary, system_type")
        .eq("property_id", property.id),
      supabase
        .from("issues")
        .select("id, category, description, status")
        .eq("property_id", property.id),
      supabase
        .from("maintenance_tasks")
        .select("id, title, due_date, status")
        .eq("property_id", property.id),
    ]);

    systems = (sysRes.data ?? [])
      .filter(
        (s) =>
          has(labelFor(SYSTEM_TYPES, s.system_type)) ||
          has(s.system_type) ||
          has(s.material_or_model)
      )
      .map((s) => ({
        label: labelFor(SYSTEM_TYPES, s.system_type),
        sub: s.material_or_model ?? undefined,
        href: "/dashboard#systems",
      }));

    documents = (docRes.data ?? [])
      .filter(
        (d) =>
          has(d.title) || has(d.brand) || has(d.model) || has(d.summary)
      )
      .map((d) => ({
        label: d.title ?? "Home document",
        sub: [d.brand, d.model].filter(Boolean).join(" ") || undefined,
        href: "/documents",
        icon: FileText,
      }));

    issues = (issueRes.data ?? [])
      .filter((i) => has(labelFor(ISSUE_CATEGORIES, i.category)) || has(i.description))
      .map((i) => ({
        label: labelFor(ISSUE_CATEGORIES, i.category),
        sub: i.description ?? undefined,
        href: "/issues",
      }));

    reminders = (taskRes.data ?? [])
      .filter((t) => has(t.title))
      .map((t) => ({ label: t.title, href: "/dashboard#this-month", icon: Bell }));
  }

  const groups = [
    { title: "Pages", items: pages },
    { title: "Your systems", items: systems },
    { title: "Documents", items: documents },
    { title: "Issues", items: issues },
    { title: "Reminders", items: reminders },
  ].filter((g) => g.items.length > 0);

  const total = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Static label regardless of the query - the breadcrumb answers "how
          did I get here", not "what did I search for". */}
      <Breadcrumbs items={[{ label: "Home", href: "/dashboard" }, { label: "Search" }]} />
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          {q ? `Results for "${q}"` : "Search"}
        </h1>

        {/* The nav has an inline search box on desktop, but it is hidden on
            mobile in favor of a link to this page, so this page needs its
            own input too. GET form, no JS required. */}
        <form action="/search" method="GET" role="search" className="flex items-center gap-2">
          <span className="relative flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-500 dark:text-stone-400">
              <Search className="h-4 w-4" aria-hidden="true" />
            </span>
            <input
              type="search"
              name="q"
              defaultValue={q}
              autoFocus={!q}
              placeholder="Type, then press Search"
              aria-label="Search"
              className="w-full rounded-xl border border-stone-200 bg-white py-2.5 pl-9 pr-3 text-base sm:text-sm text-stone-900 placeholder:text-stone-500 focus:border-bark-500 focus:outline-none dark:border-white/10 dark:bg-stone-800 dark:text-stone-100"
            />
          </span>
          <button type="submit" className="btn-primary shrink-0">
            Search
          </button>
        </form>

        {q && (
          <p className="text-sm text-stone-500 dark:text-stone-400">
            {total > 0
              ? `Found ${total} match${total === 1 ? "" : "es"} in your home and pages.`
              : "Nothing on the site matched."}
          </p>
        )}
      </div>

      {/* Ask Hearth lives only in Messages now (owner's rule, 2026-08-29:
          "ask hearth can just be on the messages tab to limit potential
          usage") - this page no longer renders it inline. Nothing matched is
          exactly the moment a homeowner wants to ask instead of click, so it
          points at Messages with the same question already typed in, using
          the ?lead=ask-hearth&q= mechanism src/app/(app)/chats/page.tsx
          already reads (see initialQuestion there). */}
      {q && total === 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
            Ask Hearth
          </h2>
          <Link
            href={`/chats?lead=ask-hearth&q=${encodeURIComponent(q)}`}
            className="flex items-center gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 hover:bg-bark-50 max-sm:min-h-11 dark:border-white/10 dark:bg-stone-800 dark:hover:bg-stone-700"
          >
            <span className="text-stone-500 dark:text-stone-400">
              <Sparkles className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                Ask Hearth in Messages
              </span>
              <span className="block truncate text-xs text-stone-500 dark:text-stone-400">
                &ldquo;{q}&rdquo;
              </span>
            </span>
          </Link>
        </section>
      )}

      {groups.map((g) => (
        <section key={g.title} className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
            {g.title}
          </h2>
          <ul className="divide-y divide-stone-100 overflow-hidden rounded-xl border border-stone-200 bg-white dark:divide-white/10 dark:border-white/10 dark:bg-stone-800">
            {g.items.map((r, i) => (
              <li key={`${r.href}-${i}`}>
                <Link
                  href={r.href}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-bark-50 dark:hover:bg-stone-700"
                >
                  {r.icon && (
                    <span className="text-stone-500 dark:text-stone-400">
                      <r.icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                      {r.label}
                    </span>
                    {r.sub && (
                      <span className="block truncate text-xs text-stone-500 dark:text-stone-400">
                        {r.sub}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
