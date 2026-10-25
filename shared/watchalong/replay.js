// The replay page's own script: rrweb's replayer, for the player in the page that frames this one (player.js) to drive.
window.ready = (async () => {
  window.process = { env: {} }; // (replay.js reads process.env in its error paths)
  const { Replayer } = await import('./vendor/rrweb-replay.js');
  return Replayer;
})();
