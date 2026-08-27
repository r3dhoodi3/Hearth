import { Skeleton, SkeletonRow } from "@/components/Skeleton";

// The public pro profile has no root loading.tsx to fall back on (this route
// sits outside every route group with a loading.tsx, sharing only the root
// layout with the marketing pages), so a client-side navigation into /p/[id]
// currently shows nothing at all while the public_pro_profile RPC resolves.
// Mirrors page.tsx's shape: the banner-strip card with the logo, name,
// rating, badges, category chips and CTA button, then a few review rows
// below it in their own card, pinned to the same max-w-2xl measure so the
// width doesn't jump once the real profile mounts.
export default function Loading() {
  return (
    <main className="mx-auto max-w-2xl px-6 pb-16 pt-10" aria-hidden="true">
      <Skeleton className="mb-4 h-4 w-24" />
      <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm dark:border-white/10 dark:bg-stone-800">
        <div className="h-20 bg-stone-100 dark:bg-stone-700/40" />
        <div className="px-6 pb-6">
          <Skeleton className="-mt-8 mb-4 h-16 w-16 rounded-2xl" />
          <Skeleton className="h-6 w-48" />
          <Skeleton className="mt-2 h-4 w-32" />
          <Skeleton className="mt-3 h-6 w-40 rounded-full" />
          <div className="mt-4 flex flex-wrap gap-1.5">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-20 rounded-full" />
            ))}
          </div>
          <Skeleton className="mt-5 h-10 w-40 rounded-lg" />
        </div>
      </div>

      <div className="mt-6 space-y-3">
        <Skeleton className="h-4 w-24" />
        <SkeletonRow />
        <SkeletonRow />
      </div>

      <Skeleton className="mx-auto mt-6 h-4 w-32" />
    </main>
  );
}
