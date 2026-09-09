# Homeowner Landing Page Demo Video: Transcript and Caption Timeline

Source component: `src/components/HeroDemoPlayer.tsx` (used on the homeowner landing page, `src/app/page.tsx`).
Voiceover files: `public/demo-vo/*.mp3` (7 clips, msedge-tts `en-US-AvaNeural` at rate -8%, output `audio-24khz-96kbitrate-mono-mp3`: MPEG-2 Layer III, 24 kHz, 96 kbps CBR, mono, no ID3).
Brand rename: `hook.mp3`, `dash.mp3` and `end.mp3` were re-recorded on 2026-09-04 with those exact settings so the voice says "OakTend", not "Hearth". The other four clips (`address`, `postjob`, `chat`, `booked`) never spoke the brand and are byte-identical to the August files.
Timing basis: 160 BPM, 375 ms per beat, 80 beats total, 30.000 s runtime at 1x speed.
All times below are at 1x playback rate. Verified against the real MP3 files on disk on 2026-09-04.

## Full voiceover transcript

This is OakTend. Your home, looked after. Just type your address to get started. OakTend gives your home a health score, and catches problems before they cost you. Something break? Post a job in seconds, with the price up front. A real quote from a local pro, straight to your messages. Booked. That easy. OakTend. Free for homeowners.

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
| hook | hook.mp3 | 00:00.700 | 00:04.084 | This is OakTend. Your home, looked after. |
| address | address.mp3 | 00:04.875 | 00:07.323 | Just type your address to get started. |
| dash | dash.mp3 | 00:08.250 | 00:13.362 | OakTend gives your home a health score, and catches problems before they cost you. |
| postjob | postjob.mp3 | 00:14.250 | 00:19.098 | Something break? Post a job in seconds, with the price up front. |
| chat | chat.mp3 | 00:19.875 | 00:24.075 | A real quote from a local pro, straight to your messages. |
| chat | booked.mp3 | 00:24.900 | 00:27.276 | Booked. That easy. |
| end | end.mp3 | 00:27.825 | 00:30.921 | OakTend. Free for homeowners. |

Caption chunk breakdown (2-word chunks, replaced in place, timed by evenly splitting the clip duration):

- hook: "This is" / "OakTend. Your" / "home, looked" / "after."
- address: "Just type" / "your address" / "to get" / "started."
- dash: "OakTend gives" / "your home" / "a health" / "score, and" / "catches problems" / "before they" / "cost you."
- postjob: "Something break?" / "Post a" / "job in" / "seconds, with" / "the price" / "up front."
- chat: "A real" / "quote from" / "a local" / "pro, straight" / "to your" / "messages."
- booked: "Booked. That" / "easy."
- end: "OakTend. Free" / "for homeowners."

## Sync verification

Measured every MP3 in `public/demo-vo/` by walking its MPEG frames (no ffprobe on this machine; a Node frame parser was used, and the frame count times 24 ms per frame matches the file byte size exactly, so the numbers are exact, not estimates).

### Real file duration vs the hardcoded `VO_EST_MS` fallback constants

`VO_EST_MS` is only the fallback pacing used when the audio element has no metadata (muted viewers or a failed load); live playback drives captions off `audio.currentTime` directly.

| Clip | VO_EST_MS | Real duration | Delta |
|---|---|---|---|
| hook.mp3 | 3384 ms | 3384 ms | 0 ms |
| address.mp3 | 2450 ms | 2448 ms | +2 ms |
| dash.mp3 | 5112 ms | 5112 ms | 0 ms |
| postjob.mp3 | 4850 ms | 4848 ms | +2 ms |
| chat.mp3 | 4200 ms | 4200 ms | 0 ms |
| booked.mp3 | 2380 ms | 2376 ms | +4 ms |
| end.mp3 | 3096 ms | 3096 ms | 0 ms |

Worst case is 4 ms, far under the 150 ms drift threshold. The three re-recorded clips had their constants updated to their new measured durations on 2026-09-04 (hook 3360 to 3384, dash 5160 to 5112, end 2980 to 3096); the four untouched clips keep their August values.

### Clip duration vs its available time window

| Clip | Window (start to next VO or hard cut) | Real duration | Fits? |
|---|---|---|---|
| hook.mp3 | 4175 ms (00:00.700 to scene cut at 00:04.875) | 3384 ms | Yes, 791 ms spare |
| address.mp3 | 3375 ms (to scene cut at 00:08.250) | 2448 ms | Yes, 927 ms spare |
| dash.mp3 | 6000 ms (to scene cut at 00:14.250) | 5112 ms | Yes, 888 ms spare |
| postjob.mp3 | 5625 ms (to chat VO at 00:19.875) | 4848 ms | Yes, 402 ms before the scene cut, 777 ms before the next VO |
| chat.mp3 | 5025 ms (to booked VO at 00:24.900) | 4200 ms | Yes, 825 ms spare; the `setCaption([])` clear at beat 65 (00:24.375) lands 300 ms after the audio ends, so no words are cut |
| booked.mp3 | 2925 ms (to end VO at 00:27.825) | 2376 ms | Yes, 549 ms spare. It crosses the chat-to-end scene cut at 00:27.000 by 276 ms, which is intentional: scene cuts do not stop the VO element, and `enterEnd` deliberately delays the closer to beat 2.2 so this line can finish |
| end.mp3 | 2175 ms to the 30.000 s timeline end, plus the 2600 ms end-card hold | 3096 ms | Yes. `finishTour` stops the music but not the VO element, so the last 921 ms plays out over the held end card, with 1679 ms to spare before the replay overlay |

### File inventory cross-check

- Every key in `VO_TEXT` (hook, address, dash, postjob, chat, booked, end) has a matching MP3 on disk. No caption is scheduled for a missing clip.
- Every MP3 in `public/demo-vo/` is scheduled. The `public/demo-vo/pro/` subdirectory belongs to the pro-side video and is out of scope here.

## 2026-09-04 OakTend re-record

The brand in the app changed from Hearth to OakTend, so every clip whose line spoke the brand was re-recorded. Only three of the seven did: `hook`, `dash` and `end`.

Settings, identical to the August generation: npm package `msedge-tts` v2.0.7 (no API key), voice `en-US-AvaNeural`, prosody rate `-8%`, output format `audio-24khz-96kbitrate-mono-mp3`. The pipeline was proved out first by re-generating the three OLD Hearth lines as a control: each control file came back with the same byte length, frame count and millisecond duration as the file already on disk, which is what pins the voice and rate.

| Clip | Old line | New line | Old duration | New duration | Delta |
|---|---|---|---|---|---|
| hook.mp3 | This is Hearth. Your home, looked after. | This is OakTend. Your home, looked after. | 3360 ms | 3384 ms | +24 ms |
| dash.mp3 | Hearth gives your home a health score, ... | OakTend gives your home a health score, ... | 5160 ms | 5112 ms | -48 ms |
| end.mp3 | Hearth. Free for homeowners. | OakTend. Free for homeowners. | 2976 ms | 3096 ms | +120 ms |

Codec profile of the three new files, from the same frame walk: MPEG-2 Layer III, 24 kHz, 96 kbps CBR, mono, no ID3, no junk bytes, one bitrate throughout. That matches the four untouched clips exactly, and the `bytes / 12000 = sec` convention the component's comment relies on still holds.

Window headroom after the change (see the table above): hook 791 ms, dash 888 ms, end 1679 ms before the replay overlay. Every clip still fits, so no rate change or tail trim was needed on the homeowner side. `VO_EST_MS` in `src/components/HeroDemoPlayer.tsx` was updated to the three new durations.

### Verdict

All timings check out. No sync bugs. The only code change was the three `VO_EST_MS` constants. Two harmless non-timing observations, left as-is on purpose:

- A stale comment near the top of the component says "78 beats = 29.25 seconds" and "the BOOKED payoff lands on beat 63"; the actual scene budgets sum to 80 beats (30.000 s) and the payoff lands on global beat 65 (which is what the music's `WIN = 65` constant already uses). Comment only, behavior is correct.
- The final caption chunk ("for homeowners.") stays painted after the audio ends at 00:30.921 because `finishTour` cancels the caption-driving animation frame at 00:30.000. The words on screen match the tail of the audio, and the replay overlay covers them at 00:32.600, so nothing reads out of sync.
