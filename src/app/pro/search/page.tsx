import Link from "next/link";
import { Search, Sparkles } from "lucide-react";
import Breadcrumbs from "@/components/Breadcrumbs";
import { matchDestinations, matchFaq } from "@/lib/searchSuggestions";

// The pro side's search page, the landing spot for ProNav's phone search icon
// and for pressing enter in the header search box (GlobalSearch side="pro").
// Unlike the homeowner /search page it reads nothing from the database: the
// pro registry and FAQ index (src/lib/searchSuggestions.ts, src/lib/faqIndex.ts)
// are static, so this whole page is synchronous matching over data that ships
// with the app. No loading skeleton for the same reason: there is no data
// load to wait on.
export default async function ProSearchPage(props: {
  searchParams: Promise<{ q?: string }>;
}) {
  const searchParams = await props.searchParams;
  const q = (searchParams.q ?? "").trim();

  // Higher limits than the header dropdown: a full page has the room.
  const pages = q ? matchDestinations(q, "pro", 8) : [];
  const faqs = q ? matchFaq(q, "pro", 8) : [];
  const total = pages.length + faqs.length;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Static label regardless of the query - the breadcrumb answers "how
          did I get here", not "what did I search for". */}
      <Breadcrumbs items={[{ label: "Home", href: "/pro" }, { label: "Search" }]} />
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          {q ? `Results for "${q}"` : "Search"}
        </h1>

        {/* ProNav's inline search box is hidden below sm in favor of an icon
            link to this page, so the page needs its own input too. GET form,
            no JS required. */}
        <form action="/pro/search" method="GET" role="search" className="flex items-center gap-2">
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
              className="w-full rounded-xl border border-stone-200 bg-white py-2.5 pl-9 pr-3 text-base sm:text-sm text-stone-900 placeholder:text-stone-500 focus:border-hearth-500 focus:outline-none dark:border-white/10 dark:bg-stone-800 dark:text-stone-100"
            />
          </span>
          <button type="submit" className="btn-primary shrink-0">
            Search
          </button>
        </form>

        {q && (
          <p className="text-sm text-stone-500 dark:text-stone-400">
            {total > 0
              ? `Found ${total} match${total === 1 ? "" : "es"}.`
              : "Nothing matched."}
          </p>
        )}
      </div>

      {/* Nothing matched is exactly the moment a pro wants to ask instead of
          click, so this hands the same question to the copilot at /pro/ask,
          which reads ?q= as a prefilled first question. */}
      {q && total === 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
            Ask Hearth
          </h2>
          <Link
            href={`/pro/ask?q=${encodeURIComponent(q)}`}
            className="flex items-center gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 hover:bg-hearth-50 max-sm:min-h-11 dark:border-white/10 dark:bg-stone-800 dark:hover:bg-stone-700"
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

      {pages.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
            Pages
          </h2>
          <ul className="divide-y divide-stone-100 overflow-hidden rounded-xl border border-stone-200 bg-white dark:divide-white/10 dark:border-white/10 dark:bg-stone-800">
            {pages.map((r) => (
              <li key={r.href}>
                <Link
                  href={r.href}
                  className="flex items-center px-4 py-3 hover:bg-hearth-50 max-sm:min-h-11 dark:hover:bg-stone-700"
                >
                  <span className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                    {r.label}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {faqs.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
            FAQ
          </h2>
          <div className="divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white px-4 dark:divide-white/10 dark:border-white/10 dark:bg-stone-800">
            {faqs.map((f) => (
              <details key={f.question} className="group py-3">
                <summary className="cursor-pointer text-sm font-medium text-stone-900 marker:text-stone-500 max-sm:flex max-sm:min-h-11 max-sm:items-center dark:text-stone-100 dark:marker:text-stone-400">
                  {f.question}
                </summary>
                <p className="mt-2 text-sm text-stone-600 dark:text-stone-300">{f.answer}</p>
                {f.href && (
                  <Link
                    href={f.href}
                    className="mt-2 inline-block text-sm font-medium text-hearth-700 hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-hearth-300"
                  >
                    Open page
                  </Link>
                )}
              </details>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
