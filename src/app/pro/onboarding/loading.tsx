import { Skeleton, SkeletonLine } from "@/components/Skeleton";

// Mirrors pro/onboarding/page.tsx, which renders the company-setup wizard in a
// max-w-lg column: a step counter over a three-segment progress bar, the step
// heading and its one line of copy, the first step's three fields, and the
// button row.
export default function Loading() {
  return (
    <div className="mx-auto max-w-lg" aria-hidden="true">
      <div className="card space-y-5">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-36" />
          <Skeleton className="h-3 w-20" />
        </div>

        {/* Progress segments */}
        <div className="flex gap-1.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-1 flex-1 rounded-full" />
          ))}
        </div>

        <div className="space-y-2">
          <Skeleton className="h-6 w-52" />
          <SkeletonLine width="w-3/4" />
        </div>

        {/* Company name, phone, email */}
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-10 w-full rounded-lg" />
            </div>
          ))}
        </div>

        <Skeleton className="h-11 w-full rounded-lg sm:w-32" />
      </div>
    </div>
  );
}
