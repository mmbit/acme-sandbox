// The live call's microphone for recorders that can use their own copy without opening another input: a promise of it,
// waited for while the call's is still starting (on iOS a second microphone silences the first), null with no call or
// none live.
let read = () => null;

export const shareCallMicrophone = microphone => (read = microphone);
export const callMicrophone = async () => {
  const stream = await read();
  return stream?.getAudioTracks().some(track => track.readyState === 'live') ? stream : null;
};
