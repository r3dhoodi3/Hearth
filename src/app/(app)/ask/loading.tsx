import { Skeleton } from "@/components/Skeleton";

// Mirrors page.tsx: the mobile-only "All conversations" back line, then the
// same full-height rounded chat frame (h-[calc(100dvh-14rem)] / sm's
// h-[calc(100vh-12rem)]) so the frame doesn't resize when the real chat
// swaps in. Inside the frame, the shape of the conversation that is about to
// appear: a header line, then message-shaped blocks, then an input bar, so the
// wait reads as the pane filling in rather than as nothing happening.
export default function Loading() {
  return (
    <div aria-hidden="true">
      <h1 className="sr-only">Ask Hearth</h1>
      <Skeleton className="mb-2 h-5 w-32 sm:hidden" />
      <div className="flex h-[calc(100dvh-14rem)] flex-col rounded-xl border border-stone-200 bg-white p-3 dark:border-white/10 dark:bg-stone-800 sm:h-[calc(100vh-12rem)]">
        {/* Header row: title + subtitle on the left, retention/Clear controls
            on the right. */}
        <div className="flex items-start justify-between gap-2 pb-2">
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-6 w-14 shrink-0" />
        </div>

        {/* Message pane, filling the remaining height. */}
        <div className="flex-1 space-y-3 overflow-hidden py-2">
          <Skeleton className="h-10 w-2/3 rounded-lg" />
          <Skeleton className="ml-auto h-8 w-1/2 rounded-lg" />
          <Skeleton className="h-14 w-3/4 rounded-lg" />
          <Skeleton className="ml-auto h-8 w-2/5 rounded-lg" />
        </div>

        {/* Input bar */}
        <Skeleton className="mt-2 h-11 w-full rounded-full" />
      </div>
    </div>
  );
}
