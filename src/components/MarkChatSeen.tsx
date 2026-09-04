"use client";

import { useEffect } from "react";

// Fires the "mark this conversation as read" server action whenever the open
// thread changes, so the unread badge/dots clear once you've looked at it.
export default function MarkChatSeen({
  leadId,
  action,
}: {
  leadId: string;
  action: (leadId: string) => Promise<void>;
}) {
  useEffect(() => {
    // Record the seen time locally first so the badge can clear instantly and
    // without depending on the server cookie write propagating to document.cookie.
    try {
      localStorage.setItem(`oaktend:seen:${leadId}`, String(Date.now()));
    } catch {
      /* localStorage unavailable */
    }
    window.dispatchEvent(new Event("oaktend:chat-seen"));
    // Persist it server-side too (the cookie survives a reload), then refresh
    // the badge once more once that write lands.
    action(leadId)
      .then(() => {
        window.dispatchEvent(new Event("oaktend:chat-seen"));
      })
      .catch(() => {
        // Fail soft: the local seen-time above already cleared the badge, and
        // a rejected background write (network blip, server down) must not
        // surface as an unhandled rejection.
      });
  }, [leadId, action]);
  return null;
}
