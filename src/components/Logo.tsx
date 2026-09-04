// Brand mark: a warm hearth/house SVG that replaces the 🏡 emoji wordmark.
// Emoji render differently on every OS; this keeps the logo identical
// everywhere and lets it take brand color via currentColor.
export default function Logo({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* House shell with chimney */}
      <path d="M3 11.5 12 4l4 3.33V5.5h2.5v3.92L21 11.5" />
      <path d="M5 10.5V20h14v-9.5" />
      {/* OakTend flame */}
      <path
        d="M12 17.8c1.8 0 3-1.2 3-2.8 0-1.9-1.7-2.6-2.2-4-.9.6-1 1.5-.9 2.2-.6-.2-1-.6-1.2-1.2-.9.8-1.7 1.9-1.7 3 0 1.6 1.2 2.8 3 2.8z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}
