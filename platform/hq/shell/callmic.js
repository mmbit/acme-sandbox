// The live call's microphone for recorders that can use their own copy without opening another input.
let read = () => null;

export const shareCallMicrophone = microphone => (read = microphone);
export const callMicrophone = () => {
  const stream = read();
  return stream?.getAudioTracks().some(track => track.readyState === 'live') ? stream : null;
};
