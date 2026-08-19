"use client";

import dynamic from "next/dynamic";
import styles from "./ProDemoPlayer.module.css";
import DemoPoster from "./DemoPoster";

// Lazy boundary for the pro demo, same deal as HeroDemoPlayerLazy:
// ProDemoPlayer is a ~2,800-line click-to-play client component, so /pros
// loads it as its own chunk after hydration instead of shipping and
// hydrating the whole choreography engine for every visitor.
//
// ssr: false is client-only, and src/app/pros/page.tsx is a server component,
// hence this wrapper. The loading state reuses the player's own poster markup
// and CSS module, so the 16/9 box is reserved from the first paint.
const ProDemoPlayer = dynamic(() => import("./ProDemoPlayer"), {
  ssr: false,
  loading: () => (
    <DemoPoster
      styles={styles}
      label="From open lead to job won"
      sub="Watch a pro use Hearth, 28 seconds"
      duration="0:28"
      ariaLabel="Play the Hearth for Pros demo, about half a minute, with sound"
    />
  ),
});

export default function ProDemoPlayerLazy() {
  return <ProDemoPlayer />;
}
