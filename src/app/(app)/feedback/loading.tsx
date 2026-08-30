import { Skeleton, SkeletonLine } from "@/components/Skeleton";

// Mirrors feedback/page.tsx + FeedbackForm.tsx: heading, then the one card
// with a textarea, a checkbox row, and the submit button. The page's only
// server work is two awaited lookups (profile, user) for the email prefill,
// but that is still a round trip before the form can paint.
export default function Loading() {
  return (
    <div className="mx-auto max-w-2xl space-y-6" aria-hidden="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-32" />
        <SkeletonLine width="w-2/3" />
      </div>
      <div className="card space-y-4 p-6">
        <SkeletonLine width="w-40" />
        <Skeleton className="h-28 w-full rounded-lg" />
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-10 w-28 rounded-lg" />
      </div>
    </div>
  );
}
