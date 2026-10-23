# Signs


The small signs a screen shows of work under way and of what waits, as HQ's keys show them: the ring that turns round a
face at work, times in words, the unread count and the pulse of jobs running. Nothing here has a colour of its own or a
sound: the page's CSS colours the marks by their classes (`.ring`, `.turning` while it turns; `.voice` for a job running and its three `.beat` bars),
and the ring takes the colour `ringColour` picks.

```js
import { ring, ringColour, ago, lasted, glance, clock, fromNow, countText, pulseMarks } from '/shared/signs/signs.js';

face.insertAdjacentHTML('beforeend', ring({ working: true })); // over the face's box, --ring its stroke
face.style.setProperty('--ring', ringColour(agent.shirt, keyColour)); // their colour, deepened if the key would hide it
badge.textContent = ago(since); // now, 4m, 2h, 3d
state.textContent = `At work · ${lasted(Date.now() - since)}`; // 47 min, 1 h 5 min, 2 d
chip.textContent = fromNow(finish, { timeZone }); // 25 min, 1½ h, Thu, Thu 29 Oct; a time past as 16:40
count.textContent = countText(n); // '' for none, 99+ past 99
pulse.innerHTML = pulseMarks(running); // a voice of three bars for each job running, on its own beat
```

- `ring({ working })`: an `<svg class="ring">` on a 76 grid, 5 thick, `RING_ARC` of its circle drawn; `--ring-turn` is
  `RING_TURN_MS`.
- `ringColour(colour, key, floor)`: the colour itself where it stands out from the key by `RING_FLOOR` (2:1), else the same
  colour deepened (or lifted, on a dark key) by the least step that does.
- Times (`timeZone` the company's clock, Intl's name): `ago` short for a badge, `lasted` a duration in words, `glance`
  an estimate or a time ahead (to the five minutes, the half hour, from ten hours whole hours), `clock` a time of day
  (`16:40`, `Thu 09:00` on another day), `fromNow` when something's due.
- `countText(n)` and `pixelDigits(text)`: a count as shown, and its 5×7 pixel digits for a pixel look.
- `pulseMarks(n, now)`: HQ's projects view's voices, the beat set from the clock, so a repaint carries its rhythm on
  (`BEAT_MS`, `BEAT_SPREAD`; `--beat` and `--at` on each voice).

The timings and sizes are exported, so a design system can state them.
