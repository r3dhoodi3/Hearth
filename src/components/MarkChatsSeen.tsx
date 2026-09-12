"use client";

import { useEffect } from "react";

// Marks every conversation as read as soon as the Messages page is open, so the
// top nav unread badge clears whenever the homeowner looks at their inbox. This
// runs even when the default Ask OakTend pane is shown (no specific thread
// selected), which is the case the user hit where the badge would not clear.
export default function MarkChatsSeen({
  leadIds,
  action,
}: {
  leadIds: string[];
  action: (leadIds: string[]) => Promise<void>;
}) {
  // Stable dependency so the effect does not refire on array identity changes.
  const key = leadIds.join(",");
  useEffect(() => {
    if (!leadIds.length) return;
    const now = String(Date.now());
    try {
      for (const id of leadIds) localStorage.setItem(`oaktend:seen:${id}`, now);
    } catch {
      /* localStorage unavailable */
    }
    window.dispatchEvent(new Event("oaktend:chat-seen"));
    action(leadIds)
      .then(() => {
        window.dispatchEvent(new Event("oaktend:chat-seen"));
      })
      .catch(() => {
        // Fail soft: the local seen-times above already cleared the badge, and
        // a rejected background write (network blip, server down) must not
        // surface as an unhandled rejection.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}
