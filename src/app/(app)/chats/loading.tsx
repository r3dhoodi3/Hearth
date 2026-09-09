import { Skeleton } from "@/components/Skeleton";

// Mirrors chats/page.tsx: heading, then the two-pane grid - the conversation
// list (bordered, divided rows, the first a pinned "Ask OakTend" with a left
// accent) on the left, the open-thread pane on the right (desktop only,
// matching the page's md:flex and its tall calc height).
export default function Loading() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <Skeleton className="h-7 w-32" />
      <div className="grid gap-4 md:grid-cols-[280px_1fr]">
        <div className="max-h-[40vh] divide-y divide-stone-100 overflow-hidden rounded-xl border border-stone-200 bg-white dark:divide-white/10 dark:border-white/10 dark:bg-stone-800 md:h-[calc(100vh-13rem)] md:max-h-none">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className={`space-y-2 border-l-4 px-4 py-3 ${
                i === 0 ? "border-bark-600" : "border-transparent"
              }`}
            >
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
        <div className="hidden rounded-xl border border-stone-200 bg-white p-3 dark:border-white/10 dark:bg-stone-800 md:block md:h-[calc(100vh-13rem)]">
          <Skeleton className="h-full min-h-[60vh] w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
