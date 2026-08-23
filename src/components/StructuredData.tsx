// Renders one JSON-LD <script> tag from a plain object or array of objects.
// Server component (no "use client"): the data is a build-time constant on
// every page that uses this, so it can render straight into the HTML with no
// hydration cost. Kept generic on purpose - src/app/layout.tsx has its own
// inline Organization script (root-level, every page) and src/app/page.tsx
// has its own inline FAQPage script (built from the same FAQ_ITEMS list the
// visible FAQ renders from); this component is for the landing page's
// Organization + WebApplication pair, so that combined block stays a single
// script tag instead of two.
export default function StructuredData({
  data,
}: {
  data: Record<string, unknown> | Record<string, unknown>[];
}) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
