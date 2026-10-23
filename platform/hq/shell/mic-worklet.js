// A call's microphone: the audio thread averages the device's rate down to 16 kHz and hands the page
// 20 ms frames of 16-bit PCM, ready for the voice line.
// Its second input is the agent's voice as it plays. While any plays, a frame carries that too, after the microphone's
// 320 samples, so the voice line can take it out of what the microphone heard: the browser's echo canceller misses some
// of it on some devices (calls #45, #91). Both are read in the same render quantum, so they line up.
class Mic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000; this.acc = 0; this.played = 0; this.n = 0; this.pos = 0;
    this.frame = new Int16Array(640); this.i = 0; this.voiced = false;
  }
  process([input, voice]) {
    const ch = input[0], playing = voice[0];
    if (!ch) return true;
    for (let k = 0; k < ch.length; k++) {
      this.acc += ch[k]; this.played += playing ? playing[k] : 0; this.n++; this.pos++;
      if (this.pos < this.step) continue;
      this.pos -= this.step;
      this.frame[this.i] = Math.max(-1, Math.min(1, this.acc / this.n)) * 32767;
      const played = this.frame[320 + this.i] = Math.max(-1, Math.min(1, this.played / this.n)) * 32767;
      this.voiced ||= played !== 0;
      this.i++; this.acc = 0; this.played = 0; this.n = 0;
      if (this.i === 320) { this.port.postMessage(this.frame.buffer.slice(0, this.voiced ? 1280 : 640)); this.i = 0; this.voiced = false; }
    }
    return true;
  }
}
registerProcessor('mic', Mic);
