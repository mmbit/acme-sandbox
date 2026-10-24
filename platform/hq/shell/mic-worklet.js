// A call's microphone: 20 ms frames of 16 kHz PCM for the voice line
// The second input is the agent's voice as it plays. While any plays, a frame carries it after the microphone's 320
// samples, so the voice line can take it out of what the microphone heard: the browser's echo canceller misses some of
// it on some devices. Both are read in the same render quantum, so they line up.
class Mic extends AudioWorkletProcessor {
  constructor() {
    super();
    // eslint-disable-next-line no-undef -- sampleRate is the audio worklet scope's own global
    this.step = sampleRate / 16000;
    this.acc = 0;
    this.played = 0;
    this.n = 0;
    this.pos = 0;
    this.frame = new Int16Array(640);
    this.i = 0;
    this.voiced = false;
  }
  process([input, voice]) {
    const ch = input[0],
      playing = voice[0];
    if (!ch) return true;
    for (let k = 0; k < ch.length; k++) {
      this.acc += ch[k];
      this.played += playing ? playing[k] : 0;
      this.n++;
      this.pos++;
      if (this.pos < this.step) continue;
      this.pos -= this.step;
      const played = pcm(this.played / this.n);
      this.frame[this.i] = pcm(this.acc / this.n);
      this.frame[320 + this.i] = played;
      this.voiced ||= played !== 0;
      this.i++;
      this.acc = 0;
      this.played = 0;
      this.n = 0;
      if (this.i === 320) {
        this.port.postMessage(this.frame.buffer.slice(0, this.voiced ? 1280 : 640));
        this.i = 0;
        this.voiced = false;
      }
    }
    return true;
  }
}

// A sample in -1..1 as 16-bit PCM
const pcm = v => Math.max(-1, Math.min(1, v)) * 32767;
registerProcessor('mic', Mic);
