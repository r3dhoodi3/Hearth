// Static stand-in for the click-to-play poster on the two marketing demo
// players (HeroDemoPlayer, ProDemoPlayer). Each player is a ~2,700-line client
// component carrying its own audio-synth and choreography engine, so the
// marketing pages pull them in with next/dynamic and paint this while the
// chunk arrives.
//
// It renders the SAME markup and the SAME CSS-module classes as the real
// poster inside each player, so the swap is invisible: .box owns the 16/9
// aspect ratio, so the box is the right size on the very first paint and
// nothing shifts. The player's own poster markup lives at the bottom of each
// player's JSX (search for styles.posterOverlay). Keep the two in sync.
//
// The one thing this poster deliberately does NOT match is the real poster's
// armed play button. It used to render a pixel-identical <button> with no
// onClick, so a press fired during the (post-hydration, ssr:false) chunk fetch
// hit a dead handler and was silently swallowed: the user pressed play,
// nothing happened, and then had to press AGAIN once the real player mounted.
// We can't safely auto-consume that first press either: the audio unlock needs
// a fresh user gesture, and resuming the AudioContext from the real player's
// mount effect runs OUTSIDE one, which browsers (Safari most strictly) reject,
// leaving the demo muted. So instead we make this read as loading, not ready:
// the button is disabled and aria-busy, and the play glyph is a spinner, so a
// press clearly lands on a not-yet-ready control instead of a broken play
// button. The instant the chunk resolves, next/dynamic swaps in the real
// player whose poster IS armed with play, so nothing is ever lost, only
// deferred to a control the user can actually see is live.

type DemoPosterProps = {
  /** The player's own CSS module, so class hashes match its poster exactly. */
  styles: Readonly<Record<string, string>>;
  label: string;
  sub: string;
  duration: string;
  ariaLabel: string;
};

export default function DemoPoster({ styles, label, sub, duration, ariaLabel }: DemoPosterProps) {
  return (
    <div className={styles.shell}>
      {/* Spinner keyframes live here, not in the .module.css, so this stays a
          self-contained placeholder. Named, not scoped, so both posters can
          mount at once (duplicate identical keyframes are harmless); stilled
          under reduced-motion like the rest of the demo chrome. */}
      <style>{`
@keyframes demoPosterSpin { to { transform: rotate(360deg); } }
.demoPosterSpin { transform-origin: 50% 50%; animation: demoPosterSpin 0.8s linear infinite; }
@media (prefers-reduced-motion: reduce) { .demoPosterSpin { animation: none; } }
`}</style>
      <div className={styles.box}>
        <button
          type="button"
          className={styles.posterOverlay}
          aria-label={ariaLabel}
          aria-busy="true"
          disabled
          style={{ cursor: "progress" }}
        >
          <span className={styles.posterBg} aria-hidden="true"></span>
          <span className={styles.playCircle} aria-hidden="true">
            {/* Spinner in place of the play triangle: centered (no optical
                nudge), so it reads as "loading" not "play". */}
            <svg className="demoPosterSpin" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginLeft: 0 }}>
              <circle cx="10" cy="10" r="7" strokeOpacity="0.25" />
              <path d="M17 10a7 7 0 0 0-7-7" strokeLinecap="round" />
            </svg>
          </span>
          <span className={styles.posterLabel}>{label}</span>
          <span className={styles.posterSub}>{sub}</span>
          <span className={styles.durationBadge}>{duration}</span>
        </button>
      </div>
    </div>
  );
}
