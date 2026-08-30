// The pro-side twin of the homeowner dashboard's PlusChip: a small "Pro" token
// on a tile or button that a Hearth Pro membership unlocks, so a non-member
// sees what is behind the wall BEFORE tapping instead of after. Same shape and
// size as PlusChip, in the hearth accent the pro shell uses rather than bark.
//
// It marks a door, it never blocks one. Nothing a pro owns (their leads, their
// jobs, their money, their messages) ever wears this.
//
// tone="free" (2026-08-30): a second, green-toned reading for a door that is
// NOT actually member-only, such as the Estimate tile once every contractor
// got two free drafts (0145) - the hearth-accent "Pro" tone would claim a gate
// that no longer exists there, which is exactly the lie CEO pass item C asked
// to stop telling. Same shape, different color and (usually) different label.
export default function ProChip({
  className = "",
  label = "Pro",
  tone = "pro",
}: {
  className?: string;
  label?: string;
  tone?: "pro" | "free";
}) {
  return (
    <span
      className={`chip ${
        tone === "free"
          ? "border border-green-200 bg-green-50 text-green-700 dark:border-green-500/30 dark:bg-green-500/15 dark:text-green-300"
          : "bg-hearth-100 text-hearth-700 dark:bg-hearth-700 dark:text-stone-300"
      } ${className}`}
    >
      {label}
    </span>
  );
}
