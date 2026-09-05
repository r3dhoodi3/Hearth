// Quiet "which side am I on" indicator for the header. Rendered only for
// accounts that hold BOTH a homeowner and a pro side - Nav.tsx passes it only
// when hasPro is true, ProNav.tsx only when hasHome is true, so a single-side
// account sees nothing new here. One accent color, no gradient, matching the
// flat-color design rule; the accent follows whichever side's own token the
// calling nav already uses (bark for Nav.tsx, hearth for ProNav.tsx) so this
// never introduces a third brand color.
//
// `label` is a free string: usually a short side name ("Home" / "Business"),
// but the pro phone header passes the company name here, so callers that do
// that should pass a max-width + `truncate` via className to keep it tidy.
export default function SidePill({
  label,
  accent,
  size = "md",
  className = "",
}: {
  label: string;
  accent: "bark" | "hearth";
  // "md" is the standard header pill; "sm" is a tighter pill for spots where it
  // has to tuck into a smaller gap (the pro desktop badge under the wordmark).
  size?: "sm" | "md";
  className?: string;
}) {
  const tone =
    accent === "bark"
      ? "bg-bark-100 text-bark-700 dark:bg-bark-700 dark:text-stone-300"
      : "bg-hearth-100 text-hearth-700 dark:bg-hearth-700 dark:text-stone-300";
  const sizing =
    size === "sm" ? "px-1.5 py-0 text-[11px]" : "px-2 py-0.5 text-[13px]";
  return (
    <span
      className={`shrink-0 rounded-full font-medium ${sizing} ${tone} ${className}`}
    >
      {label}
    </span>
  );
}
