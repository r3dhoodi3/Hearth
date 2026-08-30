// The pro-side twin of the homeowner dashboard's PlusChip: a small "Pro" token
// on a tile or button that a Hearth Pro membership unlocks, so a non-member
// sees what is behind the wall BEFORE tapping instead of after. Same shape and
// size as PlusChip, in the hearth accent the pro shell uses rather than bark.
//
// It marks a door, it never blocks one. Nothing a pro owns (their leads, their
// jobs, their money, their messages) ever wears this.
export default function ProChip({ className = "" }: { className?: string }) {
  return (
    <span
      className={`chip bg-hearth-100 text-hearth-700 dark:bg-hearth-700 dark:text-stone-300 ${className}`}
    >
      Pro
    </span>
  );
}
