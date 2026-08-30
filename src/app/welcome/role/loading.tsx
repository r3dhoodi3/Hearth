import { Skeleton, SkeletonLine } from "@/components/Skeleton";

// Mirrors welcome/role/page.tsx: the centered card with the "Welcome to
// Hearth" heading and the two role buttons. The page awaits the signed-in
// user and their sides before it knows whether to render the picker at all.
export default function Loading() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <div className="card" aria-hidden="true">
        <div className="mb-6 space-y-2 text-center">
          <Skeleton className="mx-auto h-7 w-40" />
          <SkeletonLine width="w-3/4" className="mx-auto" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      </div>
    </main>
  );
}
