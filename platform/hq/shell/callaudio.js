// A call's audio in the browser, for HQ's call screen (call.js) and the join link's page
// (platform/coordinator/src/joinpage.js): the microphone out to the voice line, the line's audio played as it comes, and
// the screen kept on. The join page loads this same file from /join/assets/ (joinpage.ts).
// The voice plays from an <audio> element fed by a MediaStream, never straight to the speakers: the echo canceller only
// takes out what it knows was played, and on Safari (iOS and Mac) that is a MediaStream played while the microphone is
// on (WebKit renders it through the microphone's voice-processing unit), not Web Audio's own output. Played straight
// out, the phone's speaker puts the agent's words back in the microphone, and the voice line hears them as the
// person's. Some still gets through on some devices, so the microphone's frames carry the voice as it played too, and
// the voice line takes out what's left (mic-worklet.js).

const MICROPHONE = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
};
const TAPS = ['touchend', 'click'];
// (the silence watch, the context resumed in the tap and when its clock stops, a
// microphone checked as it starts, and one that couldn't be replaced kept while it still runs)
const MIC_SILENT_MS = 2500,
  MIC_START_MS = 5000;

export class CallAudio {
  // what a call's playback did, for its hang-up numbers (report())
  frames = 0;
  stutters = 0;
  interrupted = 0;
  stalls = 0;
  log = [];
  dropped = 0;
  // what's queued: the time the next frame starts at (0: nothing queued), the sources not yet ended, and the sentence
  // starts not yet reached ([when, kind, ...numbers])
  next = 0;
  playing = new Set();
  starting = [];
  closed = false;

  // worklet: mic-worklet.js's address on the page
  // send(frame): each 20 ms of the microphone, with what played after it (mic-worklet.js)
  // lead: how far ahead a frame starts when less than `margin` is queued (seconds); a frame that would start more than
  //   `late` ahead is dropped, so the call never lags behind
  // lost(error): the microphone stopped and no new one could be had
  // warn(why): what the page says about the call's sound, every 100 ms while the call's audio runs: null (nothing),
  //   'paused' (the audio clock stopped: a tap resumes it), 'silent' (the microphone gives nothing but silence),
  //   'starting' (the new one opened for it hasn't started) or the error a new one failed with (the old one goes on)
  // tick(): every 100 ms of the call, after the speaker's check
  constructor({ worklet, send, lead, margin = lead, late = Infinity, lost, warn = () => {}, tick = () => {} }) {
    Object.assign(this, { worklet, send, lead, margin, late, lost, warn, tick });
  }

  // The screen stays on for the whole call: when it goes off, iOS mutes the microphone (and the call loses what's said)
  // until the page is back. The browser lets go of a wake lock each time the page is hidden, and the system can let go
  // of it on its own, so it's asked for again a second after it's let go (if in view), and each time the page is back.
  // If the page comes back while a request is pending, it's asked once more when that settles: the browser may refuse
  // it because the page was hidden when it was made.
  // Safari grants the first one only within a few seconds of a tap (later ones on the page without), and the microphone
  // can take longer than that to start: the page asks before start(), in the tap. Each answer goes in the timeline.
  async keepAwake() {
    if (this.closed || document.hidden || (this.lock && !this.lock.released)) return;
    if (this.locking) return void (this.lockAgain = true);
    this.locking = true;
    let lock;
    try {
      lock = await navigator.wakeLock?.request('screen');
      this.mark(lock ? 'wake lock held' : 'no wake lock');
    } catch {
      this.mark('wake lock refused');
    }
    this.locking = false;
    if (this.closed) return lock?.release();
    if (lock) {
      this.lock = lock;
      lock.addEventListener('release', () => {
        if (this.closed) return;
        this.mark('wake lock released');
        setTimeout(() => this.keepAwake(), 1000);
      });
    }
    if (this.lockAgain) {
      this.lockAgain = false;
      this.keepAwake();
    }
  }

  // The audio context, the microphone and its worklet, then the call's sound: throws if the microphone doesn't start.
  async start() {
    const ctx = (this.ctx = new AudioContext());
    // (a tap brings back a context iOS stopped; the first one, in this tap: iOS starts a context back from the background
    // only in one)
    this.wake = () => {
      if (ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
    };
    this.wake();
    ctx.onstatechange = () => {
      this.mark(ctx.state);
      if (ctx.state === 'interrupted') this.interrupted++;
      if (ctx.state !== 'running') this.follow(); // (iOS took the audio away)
    };
    // (the call's sound starts first, in the tap: what the page plays into it is heard while the microphone starts, which
    // a Bluetooth car kit can take seconds over: HQ's ring.)
    this.startSpeaker(ctx);
    this.speak();
    const stream = await navigator.mediaDevices.getUserMedia(MICROPHONE);
    if (this.closed) return stream.getTracks().forEach(t => t.stop());
    this.stream = stream;
    await ctx.audioWorklet.addModule(this.worklet);
    if (this.closed) return;
    // (and plays again now the microphone is on, as it started once only after it: Safari's echo canceller takes out
    // the stream it plays while the microphone is on)
    this.speaker.pause();
    this.speak();
    this.watch = setInterval(() => {
      this.follow();
      this.watchSilence();
      this.tick();
    }, 100);
    for (const ev of TAPS) addEventListener(ev, this.wake, { capture: true, passive: true });
    this.mic = new AudioWorkletNode(ctx, 'mic', { numberOfInputs: 2 });
    this.voice.connect(this.mic, 0, 1);
    this.mic.port.onmessage = m => this.send(m.data);
    this.level = ctx.createAnalyser();
    this.level.fftSize = 512;
    this.hear(stream);
    this.checkMicrophone(); // (one that came muted or ended is replaced)
    this.keepAwake(); // (again: the page may have been hidden and back while the microphone started; no-op when held)
    // (back in view after the screen went off: the screen's lock, the audio and the microphone come back)
    this.shown = () => {
      if (document.hidden) return;
      this.keepAwake();
      this.wake();
      this.checkMicrophone();
    };
    document.addEventListener('visibilitychange', this.shown);
  }

  // The call's sound: the gain every frame plays through, silence under it, and the element that plays the stream.
  startSpeaker(ctx) {
    this.out = ctx.createMediaStreamDestination();
    this.voice = ctx.createGain(); // (every frame of the line's audio, and whatever else the page plays into the call)
    this.voice.connect(this.out);
    // (and how loud it plays, for a minimised call's face: callbubble.js).
    this.voiceMeter = ctx.createAnalyser();
    this.voiceMeter.fftSize = 512;
    this.voice.connect(this.voiceMeter);
    // (and something always plays into it, silence between replies: the context renders a MediaStream destination only
    // while a source is connected to it, and each frame's source lets go of it as it ends or is cut. Starved like that,
    // Safari plays the stream's last 50 ms over and over until the next reply connects one: a word cut off loops as a
    // buzz over whatever the person says)
    this.silence = ctx.createConstantSource();
    this.silence.offset.value = 0;
    this.silence.connect(this.out);
    this.silence.start();
    this.speaker = Object.assign(new Audio(), { srcObject: this.out.stream, playsInline: true });
    // (what the element and the stream's track do, for the timeline: Safari's renderer shows only here)
    for (const ev of ['pause', 'playing', 'waiting', 'stalled', 'ended', 'error', 'emptied'])
      this.speaker.addEventListener(ev, () => this.mark(`audio ${ev}`));
    for (const ev of ['mute', 'unmute', 'ended'])
      this.out.stream.getAudioTracks()[0]?.addEventListener(ev, () => this.mark(`track ${ev}`));
  }

  // (an AbortError is a pause of ours, follow()'s when the context stops before play() starts: it plays again once the
  // clock moves; anything else means the browser won't play the stream, and the voice goes straight out after all:
  // heard, echo and all, rather than silent. Before the microphone is on, a refusal is the autoplay rule outside a tap:
  // it plays once the microphone is)
  speak() {
    this.speaker.play().catch(e => {
      if (this.closed || e?.name === 'AbortError' || !this.stream) return;
      this.voice.disconnect(this.out);
      this.voice.connect(this.ctx.destination);
      this.direct = true;
      this.speaker.srcObject = null;
    });
  }

  // Safari plays the stream from a buffer the context fills as it renders. When the context stops (iOS interrupted or
  // suspended it, or it stalled) while the <audio> element still plays, it plays the buffer's last 50 ms over and over:
  // a word cut into a looping buzz until the context runs again. So the element plays only while the context's clock
  // moves: it pauses when the clock stops, and plays on (from fresh audio) once it moves again. Each stop counts as a
  // stall in the hang-up numbers.
  follow() {
    if (this.closed || !this.speaker) return;
    const t = this.ctx.currentTime,
      now = performance.now(),
      moving = this.ctx.state === 'running' && t !== this.clock;
    this.clock = t;
    this.moving = moving;
    if (!moving && !document.hidden) this.wake();
    if (this.speaker.srcObject) {
      if (!moving && !this.speaker.paused) {
        this.stalls++;
        this.speaker.pause();
        this.stall = this.mark('stall');
      } else if (moving && this.speaker.paused) this.speak();
    }
    if (moving && this.stall) {
      this.stall.push((now - this.stall[0]) / 1000);
      this.stall = null;
    }
    // (the timeline: what the clock has reached, when the queued audio ran out, and any second the clock ran slower than
    // real time: a context that renders too slowly feeds the stream too little without ever stopping, which the check
    // above can't see)
    this.logStarted(t, now);
    if (this.next && !this.dry && t > this.next) {
      this.dry = true;
      this.mark('dry', now - (t - this.next) * 1000);
    }
    if (!moving || !this.rate) this.rate = moving && { t, now };
    else if (now - this.rate.now >= 1000) {
      const clockRatio = ((t - this.rate.t) * 1000) / (now - this.rate.now);
      if (clockRatio >= 0.9) this.slow = null;
      else if (this.slow) {
        this.slow[2] = Math.min(this.slow[2], clockRatio);
        this.slow[3] = (now - this.slow[0]) / 1000;
      } else this.slow = this.mark('slow', this.rate.now, clockRatio, (now - this.rate.now) / 1000);
      this.rate = { t, now };
    }
  }

  // The microphone into the call: into the worklet that sends it, and the analyser micLevel() reads. What its track
  // does goes in the timeline; one that ends in view (a Bluetooth headset gone) is replaced at once.
  hear(stream) {
    this.source?.disconnect();
    if (this.stream !== stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.mic);
    this.source.connect(this.level);
    const track = stream.getAudioTracks()[0];
    for (const ev of ['mute', 'unmute', 'ended'])
      track?.addEventListener(ev, () => {
        if (this.closed || this.stream !== stream) return;
        this.mark(`mic ${ev}`);
        if (ev === 'ended') this.replaceMicrophone();
      });
  }

  // Back in view, the microphone iOS muted while the screen was off: it usually unmutes by itself, but not always (an
  // installed app, a Bluetooth headset), and a track that stays muted or ended sends silence for the rest of the call.
  // So one still muted after a second, or ended, is replaced by a new one.
  async checkMicrophone() {
    const track = this.stream.getAudioTracks()[0];
    if (track?.readyState === 'live' && !track.muted) return;
    if (track?.readyState === 'live') await new Promise(r => setTimeout(r, 1000));
    const still = this.stream.getAudioTracks()[0] === track && (track?.readyState !== 'live' || track.muted);
    if (!this.closed && still) this.replaceMicrophone();
  }

  async replaceMicrophone() {
    if (this.closed || document.hidden || this.reopening) return; // (hidden: once it's back in view)
    this.reopening = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(MICROPHONE);
      if (this.closed) return stream.getTracks().forEach(t => t.stop());
      this.hear(stream);
      this.mark('mic restarted');
    } catch (err) {
      if (this.closed) return;
      // (one replaced because it heard nothing may still work, in a quiet room: the call goes on with it, and says why)
      const track = this.stream.getAudioTracks()[0];
      if (track?.readyState === 'live' && !track.muted) this.micError = err;
      else this.lost(err);
    } finally {
      this.reopening = false;
    }
  }

  // A microphone that gives the call nothing but exact silence may be dead: iOS can do that to a home-screen app back
  // from the background, without a prompt or an error. It may also be a quiet room, so silence alone never ends the
  // call. After MIC_SILENT_MS of it the page is told (warn) and a new microphone is opened, once each time the page
  // comes into view; the one it has goes on until the new one starts. One that hasn't started MIC_START_MS later (a
  // permission prompt left open) is told too. The warning goes as soon as any sound is heard. Silence counts only while
  // the audio clock moves: a stopped one holds the analyser's last buffer, so the page is told the sound is paused.
  watchSilence() {
    const now = performance.now();
    if (document.hidden) {
      this.retried = false;
      this.stoppedAt = undefined;
    }
    if (document.hidden || !this.moving) {
      this.soundAt = now;
      if (!document.hidden && now - (this.stoppedAt ??= now) >= MIC_SILENT_MS) this.warn('paused');
      return;
    }
    this.stoppedAt = undefined;
    if (this.micLevel() > 0) {
      this.soundAt = now;
      this.silent = false;
      this.micError = undefined;
    }
    this.soundAt ??= now;
    if (!this.retried && now - this.soundAt >= MIC_SILENT_MS) {
      this.mark('mic silent');
      this.retried = this.silent = true;
      this.retryAt = now;
      this.replaceMicrophone();
    }
    const starting = this.reopening && now - this.retryAt >= MIC_START_MS;
    this.warn(this.silent ? (this.micError ?? (starting ? 'starting' : 'silent')) : null);
  }

  // A frame of the line's audio (16 kHz PCM16), scheduled right after the one before: its start and end on the
  // context's clock, or null if it came too late to play. A frame that starts after a gap in the middle of a sentence (it
  // came after the one before had run out; sentence() marks a sentence's start, so the joins between them aren't
  // counted) is a stutter.
  play(pcm) {
    const ctx = this.ctx,
      now = ctx.currentTime;
    const start = this.next < now + this.margin ? now + this.lead : this.next;
    if (start > now + this.late) return null;
    const audio = ctx.createBuffer(1, pcm.length, 16000),
      channel = audio.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.connect(this.voice);
    // (for the timeline, once the clock gets there: the queued audio running out before this frame, and a sentence or a
    // tick starting, with what was queued ahead of it when it came: seconds of audio, and sources not yet ended)
    const gap = this.next && start > this.next + 1e-6;
    if (gap && !this.dry) this.starting.push([this.next, 'dry']);
    if (this.sentence) this.starting.push([start, this.sentence, Math.max(0, this.next - now), this.playing.size]);
    this.frames++;
    this.dry = false;
    if (gap && !this.sentence) this.stutters++;
    this.sentence = false;
    src.start(start);
    this.next = start + audio.duration;
    this.playing.add(src);
    src.onended = () => this.playing.delete(src);
    return { start, end: this.next };
  }

  // the next frame starts a sentence ('voice') or the line's tick while a tool step runs ('tick')
  startSentence(kind) {
    this.sentence = kind;
  }

  stopPlayback() {
    if (this.ctx) this.logStarted();
    if (this.playing.size) this.mark('cut');
    for (const src of this.playing)
      try {
        src.stop();
      } catch {
        /* ended */
      }
    this.playing.clear();
    this.starting = [];
    this.next = 0;
  }

  // how loud the microphone is now (RMS, 0 to 1)
  micLevel() {
    return rms(this.level, (this.samples ??= new Float32Array(this.level.fftSize)));
  }

  // how loud the agent's voice plays now (RMS, 0 to 1)
  voiceLevel() {
    return rms(this.voiceMeter, (this.voiceSamples ??= new Float32Array(this.voiceMeter.fftSize)));
  }

  // How the call's audio played, numbers only (never anything said): the hang-up numbers, and the timeline in seconds
  // after t0 (performance.now() when the line picked up), so a call that sounded wrong can be lined up afterwards with
  // the voice line's own times.
  report(t0) {
    if (this.ctx) this.logStarted();
    const played = {
      via: this.direct ? 'direct' : 'stream',
      rate: this.ctx?.sampleRate,
      frames: this.frames,
      stutters: this.stutters,
      interrupted: this.interrupted,
      stalls: this.stalls,
    };
    const hundredths = v => Math.round(v * 100) / 100;
    const timeline = this.log
      .map(([at, kind, ...numbers]) => [hundredths((at - (t0 ?? at)) / 1000), kind, ...numbers.map(hundredths)])
      .sort((a, b) => a[0] - b[0]);
    if (this.dropped && timeline.length) timeline.unshift([timeline[0][0], 'dropped', this.dropped]); // (the earlier ones a long call let go)
    return { played, timeline };
  }

  close() {
    if (this.closed) return;
    this.stopPlayback();
    this.closed = true;
    clearInterval(this.watch);
    if (this.wake) for (const ev of TAPS) removeEventListener(ev, this.wake, { capture: true });
    if (this.shown) document.removeEventListener('visibilitychange', this.shown);
    this.mic?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    this.silence?.stop();
    if (this.speaker) this.speaker.srcObject = null;
    this.ctx?.close().catch(() => {});
    this.lock?.release().catch(() => {});
  }

  // What played when, numbers only: [when (performance.now()), kind, ...numbers]. A long call keeps its last 300, and
  // counts the ones it let go.
  mark(kind, at = performance.now(), ...numbers) {
    const entry = [at, kind, ...numbers];
    if (this.log.push(entry) > 300) {
      this.log.shift();
      this.dropped++;
    }
    return entry;
  }

  // (what was queued goes in the timeline once the context's clock reaches it, timed back from there: audio cut before
  // it started never played, so it never shows)
  logStarted(t = this.ctx.currentTime, now = performance.now()) {
    while (this.starting.length && this.starting[0][0] <= t) {
      const [at, kind, ...numbers] = this.starting.shift();
      this.mark(kind, now - (t - at) * 1000, ...numbers);
    }
  }
}

function rms(analyser, samples) {
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}
