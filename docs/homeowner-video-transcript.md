# Homeowner Landing Page Demo Video: Transcript and Caption Timeline

Source component: `src/components/HeroDemoPlayer.tsx` (used on the homeowner landing page, `src/app/page.tsx`).
Voiceover files: `public/demo-vo/*.mp3` (7 clips, neural TTS, 24 kHz, 96 kbps CBR).
Timing basis: 160 BPM, 375 ms per beat, 80 beats total, 30.000 s runtime at 1x speed.
All times below are at 1x playback rate. Verified against the real MP3 files on disk on 2026-08-14.

## Full voiceover transcript

This is Hearth. Your home, looked after. Just type your address to get started. Hearth gives your home a health score, and catches problems before they cost you. Something break? Post a job in seconds, with the price up front. A real quote from a local pro, straight to your messages. Booked. That easy. Hearth. Free for homeowners.

## Scene timeline (beat math)

Scene boundaries come from the `SCENES` beat budgets times `BEAT_MS` (375 ms):

| Scene id | Beats | Scene start | Scene end |
|---|---|---|---|
| hook | 13 | 00:00.000 | 00:04.875 |
| address | 9 | 00:04.875 | 00:08.250 |
| dash | 16 | 00:08.250 | 00:14.250 |
| postjob | 14 | 00:14.250 | 00:19.500 |
| chat | 20 | 00:19.500 | 00:27.000 |
| end | 8 | 00:27.000 | 00:30.000 |

After 00:30.000 the end card holds for another 2.600 s (a wall-clock timeout in `finishTour`) before the replay overlay appears.

## Captions timeline

Each row is one VO clip. Start time = scene start plus the clip's scheduled offset in the code (`after(700)` in the hook, `playVo` at scene start, or `atBeat(n)`). End time = start plus the clip's real measured duration on disk. Captions are the same text as the VO, painted two words at a time, advanced off the audio element's live `currentTime`, so caption end equals audio end.

| Scene id | VO clip | Start | End | Caption text shown |
|---|---|---|---|---|
| hook | hook.mp3 | 00:00.700 | 00:04.060 | This is Hearth. Your home, looked after. |
| address | address.mp3 | 00:04.875 | 00:07.323 | Just type your address to get started. |
| dash | dash.mp3 | 00:08.250 | 00:13.410 | Hearth gives your home a health score, and catches problems before they cost you. |
| postjob | postjob.mp3 | 00:14.250 | 00:19.098 | Something break? Post a job in seconds, with the price up front. |
| chat | chat.mp3 | 00:19.875 | 00:24.075 | A real quote from a local pro, straight to your messages. |
| chat | booked.mp3 | 00:24.900 | 00:27.276 | Booked. That easy. |
| end | end.mp3 | 00:27.825 | 00:30.801 | Hearth. Free for homeowners. |

Caption chunk breakdown (2-word chunks, replaced in place, timed by evenly splitting the clip duration):

- hook: "This is" / "Hearth. Your" / "home, looked" / "after."
- address: "Just type" / "your address" / "to get" / "started."
- dash: "Hearth gives" / "your home" / "a health" / "score, and" / "catches problems" / "before they" / "cost you."
- postjob: "Something break?" / "Post a" / "job in" / "seconds, with" / "the price" / "up front."
- chat: "A real" / "quote from" / "a local" / "pro, straight" / "to your" / "messages."
- booked: "Booked. That" / "easy."
- end: "Hearth. Free" / "for homeowners."

## Sync verification

Measured every MP3 in `public/demo-vo/` by walking its MPEG frames (no ffprobe on this machine; a Node frame parser was used, and the frame count times 24 ms per frame matches the file byte size exactly, so the numbers are exact, not estimates).

### Real file duration vs the hardcoded `VO_EST_MS` fallback constants

`VO_EST_MS` is only the fallback pacing used when the audio element has no metadata (muted viewers or a failed load); live playback drives captions off `audio.currentTime` directly.

| Clip | VO_EST_MS | Real duration | Delta |
|---|---|---|---|
| hook.mp3 | 3360 ms | 3360 ms | 0 ms |
| address.mp3 | 2450 ms | 2448 ms | +2 ms |
| dash.mp3 | 5160 ms | 5160 ms | 0 ms |
| postjob.mp3 | 4850 ms | 4848 ms | +2 ms |
| chat.mp3 | 4200 ms | 4200 ms | 0 ms |
| booked.mp3 | 2380 ms | 2376 ms | +4 ms |
| end.mp3 | 2980 ms | 2976 ms | +4 ms |

Worst case is 4 ms, far under the 150 ms drift threshold. No constant needed fixing.

### Clip duration vs its available time window

| Clip | Window (start to next VO or hard cut) | Real duration | Fits? |
|---|---|---|---|
| hook.mp3 | 4175 ms (00:00.700 to scene cut at 00:04.875) | 3360 ms | Yes, 815 ms spare |
| address.mp3 | 3375 ms (to scene cut at 00:08.250) | 2448 ms | Yes, 927 ms spare |
| dash.mp3 | 6000 ms (to scene cut at 00:14.250) | 5160 ms | Yes, 840 ms spare |
| postjob.mp3 | 5625 ms (to chat VO at 00:19.875) | 4848 ms | Yes, 402 ms before the scene cut, 777 ms before the next VO |
| chat.mp3 | 5025 ms (to booked VO at 00:24.900) | 4200 ms | Yes, 825 ms spare; the `setCaption([])` clear at beat 65 (00:24.375) lands 300 ms after the audio ends, so no words are cut |
| booked.mp3 | 2925 ms (to end VO at 00:27.825) | 2376 ms | Yes, 549 ms spare. It crosses the chat-to-end scene cut at 00:27.000 by 276 ms, which is intentional: scene cuts do not stop the VO element, and `enterEnd` deliberately delays the closer to beat 2.2 so this line can finish |
| end.mp3 | 2175 ms to the 30.000 s timeline end, plus the 2600 ms end-card hold | 2976 ms | Yes. `finishTour` stops the music but not the VO element, so the last 801 ms plays out over the held end card, with 1799 ms to spare before the replay overlay |

### File inventory cross-check

- Every key in `VO_TEXT` (hook, address, dash, postjob, chat, booked, end) has a matching MP3 on disk. No caption is scheduled for a missing clip.
- Every MP3 in `public/demo-vo/` is scheduled. The `public/demo-vo/pro/` subdirectory belongs to the pro-side video and is out of scope here.

### Verdict

All timings check out. No sync bugs were found and no code changes were needed. Two harmless non-timing observations, left as-is on purpose:

- A stale comment near the top of the component says "78 beats = 29.25 seconds" and "the BOOKED payoff lands on beat 63"; the actual scene budgets sum to 80 beats (30.000 s) and the payoff lands on global beat 65 (which is what the music's `WIN = 65` constant already uses). Comment only, behavior is correct.
- The final caption chunk ("for homeowners.") stays painted after the audio ends at 00:30.801 because `finishTour` cancels the caption-driving animation frame at 00:30.000. The words on screen match the tail of the audio, and the replay overlay covers them at 00:32.600, so nothing reads out of sync.
