"use client";

import { useChatViewport } from "@/lib/useVisualViewport";

/**
 * The box a full chat lives in on /ask, /chats, /pro/ask and /pro/chats.
 *
 * On sm and up it is exactly the div those pages used to render inline: same
 * classes, same children, nothing added. Below sm it also carries
 * `hearth-chat-frame`, which globals.css turns into a fixed panel pinned
 * between the app header and the top of the software keyboard, sized from the
 * visual viewport by useChatViewport. The feed scrolls inside it and the
 * composer is the last flex child, so what you are typing stays on screen.
 *
 * The hook is mounted here rather than in the chat components because the
 * panel is the thing being measured, and because a page has exactly one of
 * these while it can hold several chat instances.
 */
export default function PhoneChatFrame({
  className,
  children,
}: {
  className: string;
  children: React.ReactNode;
}) {
  useChatViewport();
  return (
    <div className={`hearth-chat-frame ${className}`}>{children}</div>
  );
}
