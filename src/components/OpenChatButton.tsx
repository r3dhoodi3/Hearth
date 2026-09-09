"use client";

// Opens the floating ChatDock for a given lead by firing a window event.
export default function OpenChatButton({
  leadId,
  name,
  label = "Message",
}: {
  leadId: string;
  name: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent("oaktend:open-chat", { detail: { leadId, name } })
        )
      }
      className="text-sm font-medium text-bark-700 hover:underline"
    >
      {label}
    </button>
  );
}
