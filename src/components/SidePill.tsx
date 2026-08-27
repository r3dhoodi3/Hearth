// Quiet "which side am I on" indicator for the header. Rendered only for
// accounts that hold BOTH a homeowner and a pro side - Nav.tsx passes it only
// when hasPro is true, ProNav.tsx only when hasHome is true, so a single-side
// account sees nothing new here. One accent color, no icon, no gradient,
// matching the flat-color design rule; the accent follows whichever side's
// own token the calling nav already uses (bark for Nav.tsx, hearth for
// ProNav.tsx) so this never introduces a third brand color.
export default function SidePill({
  label,
  accent,
  className = "",
}: {
  label: "Home" | "Business";
  accent: "bark" | "hearth";
  className?: string;
}) {
  const tone =
    accent === "bark"
      ? "bg-bark-100 text-bark-700 dark:bg-bark-700 dark:text-stone-300"
      : "bg-hearth-100 text-hearth-700 dark:bg-hearth-700 dark:text-stone-300";
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[13px] font-medium ${tone} ${className}`}
    >
      {label}
    </span>
  );
}
