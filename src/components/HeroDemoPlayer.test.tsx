// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import HeroDemoPlayer from "./HeroDemoPlayer";

// The bug this covers: clicking anywhere inside the simulated app screen -
// the fake nav, the fake chat "Send" button, etc, all rendered with the real
// site's own interactive-looking classes - used to pause the whole demo,
// because a single onClick on the full-bleed device wrapper (deviceWrap)
// caught every click inside it with no exemption for the decorative content.
// A viewer naturally tries clicking things that look clickable inside the
// demo; each one silently killed playback. Confirmed live on
// gethearth.vercel.app with a Playwright click probe (see
// scratchpad/video-probe.js): clicking the fake nav logo or the fake Send
// chip paused playback; clicking the surrounding real page (header, heading,
// background, scroll) never did.
//
// HeroDemoPlayer drives a hand-built Web Audio engine (no <video> element
// anywhere in this component - or anywhere in src/, confirmed by grep), so
// starting playback touches AudioContext, matchMedia and speechSynthesis.
// Those are stubbed below with permissive fakes: the goal is only to observe
// the play/pause state and the audio pause() calls it makes, not to model
// the audio graph faithfully.

function fakeParam() {
  let value = 0;
  return {
    get value() {
      return value;
    },
    set value(v: number) {
      value = v;
    },
    setValueAtTime: vi.fn(),
    setValueCurveAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
}

// Any Web Audio node used by the engine (gain, oscillator, filter,
// compressor, delay, panner, buffer source, waveshaper...): auto-vivifies
// AudioParam-shaped properties (gain, frequency, Q, detune, threshold,
// knee, ratio, attack, release, pan, delayTime) on first read, and no-ops
// every graph/lifecycle method (connect/disconnect/start/stop).
function fakeAudioNode(): any {
  const target: Record<string, unknown> = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  return new Proxy(target, {
    get(t, prop: string) {
      if (!(prop in t)) t[prop] = fakeParam();
      return t[prop];
    },
    set(t, prop: string, value) {
      t[prop] = value;
      return true;
    },
  });
}

function installBrowserStubs() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  );

  const fakeCtx: any = new Proxy(
    {
      destination: fakeAudioNode(),
      currentTime: 0,
      sampleRate: 44100,
      state: "running",
      resume: vi.fn().mockResolvedValue(undefined),
      suspend: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      createBuffer: vi.fn((_channels: number, length: number) => ({
        getChannelData: () => new Float32Array(length),
      })),
    },
    {
      get(t: Record<string, unknown>, prop: string) {
        if (prop in t) return t[prop];
        // createGain, createOscillator, createBiquadFilter,
        // createDynamicsCompressor, createWaveShaper, createDelay,
        // createStereoPanner, createBufferSource, ...
        return () => fakeAudioNode();
      },
    }
  );
  class FakeAudioContext {
    constructor() {
      return fakeCtx;
    }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);

  vi.stubGlobal("speechSynthesis", {
    getVoices: vi.fn(() => []),
    speak: vi.fn(),
    cancel: vi.fn(),
  });

  // Real <audio> elements only get created when `Audio` exists (see
  // initVoAudio's own `typeof Audio === "undefined"` guard); jsdom does not
  // implement play()/pause() and would throw synchronously without a stub.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

  // jsdom's requestAnimationFrame would otherwise keep the camera/cursor
  // rAF loop and the scene scheduler ticking on real timers for the whole
  // test; a no-op stub keeps the run deterministic and fast. The pause bug
  // under test lives entirely in the click handler, not the animation loop.
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
}

beforeEach(() => {
  installBrowserStubs();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function playPauseLabel() {
  return screen
    .getByRole("button", { name: /^(Play|Pause|Resume)$/ })
    .getAttribute("aria-label");
}

describe("HeroDemoPlayer click-to-pause", () => {
  it("does not pause when a click lands on the simulated app content inside the screen", () => {
    render(<HeroDemoPlayer />);

    fireEvent.click(screen.getByRole("button", { name: /Play the Hearth demo/i }));
    expect(playPauseLabel()).toBe("Pause");

    // A fake nav logo rendered with the real site's own classes - exactly
    // the kind of element a viewer would try to click, expecting it to do
    // something (or nothing) rather than kill the video.
    const navLogo = document.querySelector('[data-x="navLogo"]');
    expect(navLogo).toBeTruthy();
    fireEvent.click(navLogo as Element);
    expect(playPauseLabel()).toBe("Pause");

    // The fake chat "Send" chip: rendered with the real .btn-primary class,
    // looks exactly like a real button.
    const sendChip = document.querySelector('[data-x="sendBtn"]');
    expect(sendChip).toBeTruthy();
    fireEvent.click(sendChip as Element);
    expect(playPauseLabel()).toBe("Pause");

    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
  });

  it("still toggles pause on a click that lands on the device frame outside the screen (the deliberate control)", () => {
    render(<HeroDemoPlayer />);

    fireEvent.click(screen.getByRole("button", { name: /Play the Hearth demo/i }));
    expect(playPauseLabel()).toBe("Pause");

    // deviceWrap itself, not any descendant of [data-x="screen"] - this is
    // the "click the picture, like a video player" control the component's
    // own comment describes, and it must keep working. CSS Modules hash
    // class names, so match the module class by substring.
    const deviceWrap = document.querySelector('[class*="deviceWrap"]') as Element;
    expect(deviceWrap).toBeTruthy();
    fireEvent.click(deviceWrap);
    expect(playPauseLabel()).toBe("Resume");
  });
});

describe("HeroDemoPlayer transport labels", () => {
  // Phones have no click. The speed control's accessible name used to end in
  // "click to change", which is both wrong on the platform the demo is mostly
  // watched on and the one place in this component that named a mouse.
  it("names the playback speed without telling a phone user to click", () => {
    render(<HeroDemoPlayer />);
    fireEvent.click(screen.getByRole("button", { name: /Play the Hearth demo/i }));

    const rate = screen.getByRole("button", { name: /Playback speed/i });
    const label = rate.getAttribute("aria-label") ?? "";
    expect(label).toMatch(/^Playback speed [\d.]+x, change speed$/);
    expect(label).not.toMatch(/click/i);
  });
});
