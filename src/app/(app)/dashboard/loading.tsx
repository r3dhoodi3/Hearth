import { Skeleton, SkeletonLine, SkeletonCard, SkeletonRow } from "@/components/Skeleton";

// Mirrors dashboard/page.tsx: the 4-tile stats grid (health score tile first,
// given an extra line since its card-hero has a "why this score" disclosure
// the other three don't - now a one-liner, not a paragraph), the "This
// month" card (briefing + progress line + one collapsed "see tasks" row,
// standing in for the details element), the Plus CTA + 3-tile tools row
// (now compact, no description paragraph), a few system rows, and the
// project-chip row.
export default function Loading() {
  return (
    <div className="space-y-8" aria-hidden="true">
      {/* WeatherStrip renders before the stats grid and shows this exact
          shape (icon dot + one line) as ITS OWN skeleton the instant it
          mounts, since its fetch starts loading=true. Without a matching row
          here, the stats grid sits flush at the top while this route's data
          loads, then jumps down the moment page.tsx mounts and WeatherStrip
          inserts its row above it - the same jump a skeleton exists to
          prevent. Mirrors WeatherStrip.tsx's own loading return exactly. */}
      <div className="flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-4 py-2.5 shadow-card dark:border-white/10 dark:bg-stone-800">
        <Skeleton className="h-4 w-4 shrink-0 rounded-full" />
        <Skeleton className="h-4 w-40" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card space-y-2">
          <SkeletonLine width="w-28" />
          <Skeleton className="h-9 w-16" />
          <SkeletonLine width="w-2/3" />
          <SkeletonLine width="w-1/3" />
        </div>
        {/* Phone: only the health score tile is real down here. Open jobs,
            Home value, and Energy this season are all max-sm:hidden on the
            page, so placeholders for them would be three cards that vanish
            the moment the page arrives. Desktop still gets all four. */}
        <div className="card space-y-2 max-sm:hidden">
          <SkeletonLine width="w-20" />
          <Skeleton className="h-6 w-24" />
          <SkeletonLine width="w-3/4" />
        </div>
        <div className="card space-y-2 max-sm:hidden">
          <SkeletonLine width="w-20" />
          <Skeleton className="h-6 w-24" />
          <SkeletonLine width="w-3/4" />
        </div>
        <div className="card space-y-2 max-sm:hidden">
          <SkeletonLine width="w-28" />
          <Skeleton className="h-6 w-24" />
          <SkeletonLine width="w-3/4" />
        </div>
      </div>

      <div className="space-y-3">
        <Skeleton className="h-5 w-28" />
        {/* The real card (page.tsx:878-882) nests the checklist in its own
            bg-bark-50 box rather than laying the lines straight in the card;
            without that nested box here the card's inner padding shifts the
            moment real content lands. */}
        <div className="card">
          <div className="space-y-1.5 rounded-lg bg-bark-50 p-3 dark:bg-bark-700/30">
            <SkeletonLine width="w-full" />
            <SkeletonLine width="w-2/3" />
            <SkeletonLine width="w-1/2" />
            <SkeletonLine width="w-40" />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <Skeleton className="h-5 w-52" />
        <SkeletonCard lines={2} />
        <div className="grid grid-cols-3 gap-2 sm:gap-4">
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
        </div>
      </div>

      <div className="space-y-3">
        <Skeleton className="h-5 w-32" />
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
        {/* Phone only: reserves the height of SystemsPhoneList's "See all N
            systems" button (min-h-11, sm:hidden) so a home with more than 3
            systems doesn't grow the moment the real list mounts. Desktop
            never shows that button, so this stays hidden there too. */}
        <Skeleton className="h-11 w-full rounded-xl sm:hidden" />
      </div>

      {/* Thinking about a project? heading, one-line intro, then the
          remodel-project chip row. Hidden below sm to match the real block
          (page.tsx:1355,1366), which is max-sm:hidden - phone moved this
          content to /contractors, so a phone skeleton for it would flash a
          heading and 6 pills that then vanish. */}
      <div className="space-y-3 max-sm:hidden">
        <Skeleton className="h-5 w-56" />
        <SkeletonLine width="w-2/3" />
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-24 rounded-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
