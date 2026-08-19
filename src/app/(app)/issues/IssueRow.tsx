"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ISSUE_CATEGORIES,
  SEVERITIES,
  labelFor,
} from "@/lib/constants";
import CategoryIcon from "@/components/CategoryIcon";
import { imgSrc } from "@/lib/storage";
import { StoredPhotoGrid } from "@/components/FilePreview";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/ToastProvider";
import {
  updateIssueAction,
  checkResolveIssueAction,
  reopenIssueAction,
} from "./actions";

const SEVERITY_STYLE: Record<string, string> = {
  low: "border-stone-200 bg-stone-50 text-stone-600 dark:border-white/10 dark:bg-stone-700 dark:text-stone-300",
  medium: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300",
  urgent: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
};

export default function IssueRow({
  issue,
  initialResolved = false,
  photos = [],
}: {
  issue: any;
  initialResolved?: boolean;
  photos?: string[];
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showPhotos, setShowPhotos] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const toast = useToast();
  // The checkbox follows the issue's real status (initialResolved), with an
  // optimistic override only while a toggle is in flight. Using the prop as the
  // source of truth - instead of a one-time useState init - means a row that
  // moves into the Resolved section always shows checked, and one moved back to
  // Open shows unchecked, even if React reuses the same component instance.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const resolved = optimistic ?? initialResolved;

  async function toggleResolved() {
    const next = !resolved;
    setOptimistic(next); // flip the checkbox immediately
    setBusy(true);
    try {
      const res = next
        ? await checkResolveIssueAction(issue.id)
        : await reopenIssueAction(issue.id);
      if (!res.ok) {
        // A stay-on-page failure never shows via flash, so surface it here and
        // revert the optimistic flip.
        setOptimistic(null);
        toast.error(res.error);
        return;
      }
      // Revalidation re-renders with the new status; drop the override so we
      // follow the server truth again.
      setOptimistic(null);
    } catch {
      setOptimistic(null); // revert the optimistic flip on failure
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <li className="card">
        <form
          action={async (fd) => {
            const res = await updateIssueAction(fd);
            if (!res.ok) {
              setEditError(res.error);
              return;
            }
            setEditError(null);
            setEditing(false);
          }}
          className="space-y-3"
        >
          <input type="hidden" name="id" value={issue.id} />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Category</label>
              <select
                name="category"
                className="select"
                defaultValue={issue.category}
              >
                {ISSUE_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Severity</label>
              <select
                name="severity"
                className="select"
                defaultValue={issue.severity}
              >
                {SEVERITIES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label">What&apos;s going on?</label>
            <textarea
              name="description"
              className="textarea"
              rows={3}
              defaultValue={issue.description ?? ""}
            />
          </div>
          {editError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {editError}
            </p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setEditError(null);
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="card space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={toggleResolved}
            title={resolved ? "Reopen" : "Mark resolved"}
            // Padding + matching negative margin: a finger-sized tap target
            // on the phone without moving the 16px box visually.
            className="-m-3.5 flex shrink-0 p-3.5 sm:-m-2.5 sm:p-2.5"
          >
            <span
              className={`mt-0.5 flex h-4 w-4 items-center justify-center rounded border text-[10px] ${
                resolved
                  ? "border-green-500 bg-green-500 text-white"
                  : "border-stone-300 text-transparent hover:border-green-500 dark:border-stone-600"
              }`}
            >
              ✓
            </span>
          </button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`font-medium ${
                  resolved ? "text-stone-500 line-through dark:text-stone-400" : "text-stone-900 dark:text-stone-100"
                }`}
              >
                <CategoryIcon
                  list={ISSUE_CATEGORIES}
                  value={issue.category}
                  className="mr-1 inline-block h-4 w-4 align-[-3px]"
                />
                {labelFor(ISSUE_CATEGORIES, issue.category)}
              </span>
              <span
                className={`rounded-full border px-2 py-0.5 text-xs ${SEVERITY_STYLE[issue.severity]}`}
              >
                {labelFor(SEVERITIES, issue.severity)}
              </span>
              {issue.converted_to_lead && (
                <span className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-xs text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">
                  pro requested
                </span>
              )}
            </div>
            {issue.description && (
              <p
                className={`mt-1 text-sm ${
                  resolved ? "text-stone-500 line-through dark:text-stone-400" : "text-stone-600 dark:text-stone-300"
                }`}
              >
                {issue.description}
              </p>
            )}
            {photos.length > 0 && (
              <div className="mt-1">
                <button
                  type="button"
                  onClick={() => setShowPhotos((v) => !v)}
                  className="inline-flex min-h-11 items-center text-xs font-medium text-bark-700 hover:underline sm:inline-block sm:min-h-0 dark:text-stone-300"
                >
                  {showPhotos
                    ? "Hide photos"
                    : `Show photo${photos.length === 1 ? "" : "s"} (${photos.length})`}
                </button>
                {showPhotos && (
                  <StoredPhotoGrid
                    photos={photos.map((u) => ({
                      key: u,
                      src: imgSrc(u) ?? u,
                      alt: "Issue photo",
                    }))}
                  />
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {resolved ? (
            <button
              type="button"
              disabled={busy}
              onClick={toggleResolved}
              className="inline-flex min-h-11 items-center text-xs font-medium text-bark-700 hover:underline disabled:opacity-50 sm:inline-block sm:min-h-0 dark:text-stone-300"
            >
              {busy ? "…" : "Undo"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex min-h-11 items-center text-xs font-medium text-bark-700 hover:underline sm:inline-block sm:min-h-0 dark:text-stone-300"
            >
              Edit
            </button>
          )}
        </div>
      </div>
      {!issue.converted_to_lead && !resolved && (
        <Link
          href={`/contractors?issue=${issue.id}&category=${issue.category}`}
          className="inline-block text-sm font-medium text-bark-700 hover:underline dark:text-stone-300"
        >
          Connect me with a local pro →
        </Link>
      )}
    </li>
  );
}
