import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import { fillLegalTokens } from "@/lib/legal";
import { parseLegalDocument, renderLegalMarkdown } from "@/lib/legalMarkdown";

// Server component: reads a legal document from src/content/legal/*.md at
// request time, fills its {{TOKENS}}, and renders it with the same page
// chrome every legal page has always used (back link, h1, "Last updated"
// line, max-w-2xl). See next.config.mjs's outputFileTracingIncludes for why
// the .md files are readable on Vercel, not just in `next dev`.
const CONTENT_DIR = path.join(process.cwd(), "src/content/legal");

export const LEGAL_SLUGS = [
  "terms",
  "pro-terms",
  "privacy",
  "cookies",
  "subprocessors",
  "billing",
  "sms-terms",
  "ai-disclosure",
  "accessibility",
  "dmca",
  "guidelines",
  "security",
  "pro-data-addendum",
  "law-enforcement",
] as const;

export type LegalSlug = (typeof LEGAL_SLUGS)[number];

function readLegalMarkdown(slug: LegalSlug): string {
  return fs.readFileSync(path.join(CONTENT_DIR, `${slug}.md`), "utf8");
}

export default function LegalDocument({ slug }: { slug: LegalSlug }) {
  const filled = fillLegalTokens(readLegalMarkdown(slug));
  const doc = parseLegalDocument(filled);
  const showToc = doc.headings.length > 8;

  return (
    <main id="main" className="mx-auto max-w-2xl px-6 pb-16 pt-10">
      <p className="text-sm">
        {/* Same phone-only 44px tap target as the /contact back link: all
            added classes are max-sm:, so sm and up is unchanged. */}
        <Link
          href="/"
          className="text-stone-500 hover:text-bark-700 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:text-base dark:text-stone-400 dark:hover:text-stone-300"
        >
          ← OakTend
        </Link>
      </p>

      <h1 className="mt-4 text-2xl font-bold text-stone-900 sm:text-3xl dark:text-stone-100">
        {doc.title}
      </h1>
      {doc.lastUpdated && (
        <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
          Last updated {doc.lastUpdated}.
        </p>
      )}

      {showToc && (
        <nav
          aria-label="Table of contents"
          className="mt-6 rounded-lg border border-stone-200 p-4 text-sm dark:border-stone-700"
        >
          <p className="font-semibold text-stone-900 dark:text-stone-100">On this page</p>
          <ul className="mt-2 space-y-1">
            {doc.headings.map((h) => (
              <li key={h.id}>
                <a href={`#${h.id}`} className="text-bark-700 hover:underline dark:text-stone-300">
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}

      <div className="mt-8 text-stone-700 dark:text-stone-300">
        {renderLegalMarkdown(doc.body)}
      </div>
    </main>
  );
}
