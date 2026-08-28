"use client";

import { useState } from "react";
import InlineSpinner from "@/components/InlineSpinner";
import { unblockUserAction } from "@/app/(app)/account/blocks/actions";
import type { BlockedAccount } from "@/lib/blocks";
import type { ActionResult } from "@/lib/actionResult";

// The undo path for blocking. Everything reversible about a block lives here,
// which is why the Block control on a chat or a profile can be a one-tap
// confirm: nothing is lost, it is just moved to a list.
//
// Rows disappear optimistically on unblock and come back if the server says
// no, so the list never claims something happened that did not.
export default function BlockedUsersPanel({
  blocks,
  action = unblockUserAction,
}: {
  blocks: BlockedAccount[];
  // Injectable for tests. Production always uses the real server action.
  action?: (formData: FormData) => Promise<ActionResult>;
}) {
  const [rows, setRows] = useState<BlockedAccount[]>(blocks);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function unblock(row: BlockedAccount) {
    setBusyId(row.userId);
    setError(null);
    const fd = new FormData();
    fd.set("blocked_user_id", row.userId);
    try {
      const res = await action(fd);
      if (res && !res.ok) {
        setError(res.error);
        return;
      }
      setRows((prev) => prev.filter((r) => r.userId !== row.userId));
    } catch {
      setError("Couldn't unblock this person just now. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="card">
        <p className="text-sm text-stone-600 dark:text-stone-300">
          You have not blocked anyone.
        </p>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          You can block someone from a conversation with them, or from a pro&apos;s
          profile page. Blocking stops new messages between you and hides your
          jobs from each other.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      {error && (
        <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <ul className="divide-y divide-stone-100 dark:divide-white/10">
        {rows.map((row) => (
          <li
            key={row.userId}
            className="flex flex-wrap items-center justify-between gap-3 py-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                {row.label}
              </p>
              <p className="text-xs text-stone-500 dark:text-stone-400">
                Blocked {row.createdAt.slice(0, 10)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => unblock(row)}
              disabled={busyId === row.userId}
              className="btn-secondary inline-flex items-center gap-1.5 whitespace-nowrap text-sm disabled:opacity-50"
            >
              {busyId === row.userId && <InlineSpinner size={14} />}
              Unblock
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
