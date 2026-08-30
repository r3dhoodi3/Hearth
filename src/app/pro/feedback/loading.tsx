import { Skeleton, SkeletonLine } from "@/components/Skeleton";

// Mirrors pro/feedback/page.tsx + FeedbackForm.tsx: heading/credit copy, then
// the score row, the message box, and the submit button. The page awaits
// readFeedbackState and isEstablishedPro before it can render either state.
export default function Loading() {
  return (
    <div className="mx-auto max-w-2xl space-y-6" aria-hidden="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <SkeletonLine width="w-2/3" />
      </div>
      <div className="card space-y-4 p-6">
        <SkeletonLine width="w-32" />
        <div className="flex gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-10 rounded-full" />
          ))}
        </div>
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-10 w-32 rounded-lg" />
      </div>
    </div>
  );
}
