"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import InlineSpinner from "@/components/InlineSpinner";
import ReportSheet from "@/components/ReportSheet";

// id is OPTIONAL on purpose: migration 0138 adds it to contractor_reviews(),
// and a live database still on 0137 returns rows without one. A row with no
// id simply gets no Report control rather than one that points at nothing.
type Review = {
  id?: string;
  rating: number;
  comment: string | null;
  created_at: string;
};

// Expander that lists a contractor's reviews (rating + comment + date), fetched
// on demand via the contractor_reviews RPC. Lets a homeowner read an applicant's
// track record before choosing.
export default function ContractorReviews({
  contractorId,
  count,
}: {
  contractorId: string;
  count: number;
}) {
  const [open, setOpen] = useState(false);
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [loading, setLoading] = useState(false);
  // Distinct from "reviews is an empty array": that's zero written reviews, a
  // normal state. This is "we don't actually know", so the two don't get the
  // same copy. Left cleared only by a fetch that succeeds, so reopening after
  // a failure retries instead of showing the same stale error forever.
  const [failed, setFailed] = useState(false);

  async function toggle() {
    if (!open && reviews === null) {
      setLoading(true);
      try {
        const supabase = createClient();
        const { data, error } = await supabase.rpc("contractor_reviews", {
          p_contractor: contractorId,
        });
        if (error) {
          setFailed(true);
        } else {
          setFailed(false);
          setReviews((data as Review[]) ?? []);
        }
      } catch {
        // A rejected call (network blip, server hiccup) must not strand the
        // button in its loading state forever.
        setFailed(true);
      } finally {
        setLoading(false);
      }
    }
    setOpen((v) => !v);
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={toggle}
        disabled={loading}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-bark-700 hover:underline dark:text-stone-300"
      >
        {loading && <InlineSpinner size={12} />}
        {open ? "Hide reviews" : `Read ${count} review${count === 1 ? "" : "s"}`}
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {loading && <p className="text-xs text-stone-500 dark:text-stone-400">Loading…</p>}
          {!loading && failed && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              Couldn&apos;t load reviews right now.
            </p>
          )}
          {reviews?.map((r, i) => (
            <div key={i} className="rounded-lg border border-stone-200 p-2 dark:border-white/10">
              <div className="flex items-center justify-between">
                <span className="text-xs text-amber-500">
                  {"★".repeat(r.rating)}
                  <span className="text-stone-300 dark:text-stone-600">
                    {"★".repeat(5 - r.rating)}
                  </span>
                </span>
                <span className="text-[11px] text-stone-500 dark:text-stone-400">
                  {r.created_at.slice(0, 10)}
                </span>
              </div>
              {r.comment && (
                <p className="mt-1 text-xs text-stone-600 dark:text-stone-300">{r.comment}</p>
              )}
              {r.id && (
                <div className="mt-1">
                  <ReportSheet
                    targetType="review"
                    targetId={r.id}
                    label="Report"
                    openLabel="Report this review"
                  />
                </div>
              )}
            </div>
          ))}
          {reviews && reviews.length === 0 && (
            <p className="text-xs text-stone-500 dark:text-stone-400">No written reviews yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
