"use client";

import dynamic from "next/dynamic";
import styles from "./HeroDemoPlayer.module.css";
import DemoPoster from "./DemoPoster";

// Lazy boundary for the landing demo. HeroDemoPlayer is ~2,700 lines of
// client code (WebAudio synth, virtual clock, camera rig, five fake app
// screens) and the demo is click-to-play, so nobody needs any of it to read
// the landing page. Pulling it in with next/dynamic keeps it out of the
// page's first-load JS: the browser paints the poster, finishes hydrating
// everything else, and fetches the player chunk after.
//
// ssr: false because there is nothing worth streaming in the HTML (the poster
// covers the whole box until you press play) and because it skips the
// server-render + hydration cost of the entire fake-app DOM. That flag is
// client-only, hence this wrapper: src/app/page.tsx is a server component.
//
// The loading state is the same poster markup off the same CSS module, so the
// box is 16/9 from the first paint and the swap causes no shift.
const HeroDemoPlayer = dynamic(() => import("./HeroDemoPlayer"), {
  ssr: false,
  loading: () => (
    <DemoPoster
      styles={styles}
      label="From leak to booked pro"
      sub="Watch someone use Hearth, 30 seconds"
      duration="0:30"
      ariaLabel="Play the Hearth demo, about 30 seconds, with sound"
    />
  ),
});

export default function HeroDemoPlayerLazy() {
  return <HeroDemoPlayer />;
}
