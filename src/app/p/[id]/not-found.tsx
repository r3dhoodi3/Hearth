import Link from "next/link";

// Branded 404 for public pro pages: an unknown slug or contractor id lands
// here (see notFound() in ./page.tsx). Styled to match NotReadyCard so both
// soft states of this route feel like the same page.
export default function ProNotFound() {
  return (
    <main className="mx-auto max-w-xl px-6 py-16 text-center">
      <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm dark:border-white/10 dark:bg-stone-800">
        {/* Flat warm banner strip, no gradient: oaktend-100 in light, a
            translucent OakTend tint over the stone-800 card in dark. */}
        <div className="h-20 bg-bark-100 dark:bg-bark-700/30" />
        <div className="px-6 pb-8 pt-2">
          <h1 className="mt-3 text-xl font-semibold text-stone-900 dark:text-stone-100">
            This pro page has moved or expired
          </h1>
          <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
            The link may be out of date, or the pro may no longer be on
            OakTend.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-4 text-sm font-medium">
            <Link href="/pros" className="text-bark-700 hover:underline dark:text-stone-300">
              For pros
            </Link>
            <Link href="/" className="text-bark-700 hover:underline dark:text-stone-300">
              OakTend home
            </Link>
          </div>
        </div>
      </div>
      <Link
        href="/pros"
        className="mt-6 inline-block text-sm font-medium text-bark-700 hover:underline dark:text-stone-300"
      >
        Powered by OakTend
      </Link>
    </main>
  );
}
