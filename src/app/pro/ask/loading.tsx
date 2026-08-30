import { Skeleton } from "@/components/Skeleton";

// Mirrors page.tsx (the pro copilot's own full-page frame, identical shape
// to the homeowner /ask page): the mobile-only "All conversations" back
// line, then the same full-height rounded chat frame, so the frame doesn't
// resize when the real conversation swaps in. Inside, the shape of the
// conversation about to appear: header line, message-shaped blocks, input bar.
export default function Loading() {
  return (
    <div aria-hidden="true">
      <h1 className="sr-only">Ask Hearth for Pros</h1>
      <Skeleton className="mb-2 h-5 w-32 sm:hidden" />
      <div className="flex h-[calc(100dvh-14rem)] flex-col rounded-xl border border-stone-200 bg-white p-3 sm:h-[calc(100vh-12rem)] dark:border-white/10 dark:bg-stone-800">
        {/* Header row: title + subtitle on the left, retention/Clear controls
            on the right. */}
        <div className="flex items-start justify-between gap-2 pb-2">
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-36" />
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
