// A sound's level now: the root mean square of an analyser's latest samples, 0 (silence) to 1 (callaudio.js's meters)
export function rms(analyser, samples) {
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}
