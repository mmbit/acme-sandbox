// window.hq on localhost, for the console and for tests: drive the clock, the simulation and single frames.
import * as world from '../world/world.js';
import { setHour } from '../world/clock.js';
import { scene, frame, paused, pause, mount } from './stage.js';
import { onEvent } from './events.js';
import { picturesLoaded } from '../util.js';
import { refreshOrg, checkHealth } from './main.js';

export function devHooks() {
  const hooks = {
    refreshOrg,
    checkHealth,
    setHour,
    frame,
    world: Object.create(world, { paused: { get: () => paused, set: pause } }), // (tests hold the loop with world.paused)
    rebuild: org => {
      world.setOrg(org);
      return scene.dev.rebuild();
    },
    event: onEvent,
    swap: name => mount(name), // a hot swap to a renderer, by name
    emote: world.emote, // hq.emote(id, kind, s): someone feels something (world/emotes.js has the kinds)
    picturesLoaded, // the canvas's pictures, loaded or failed
  };
  // the rest are the scene's (S, L, R, cam, hit, tick, walls…): the one on the stage now, across swaps
  return new Proxy(hooks, { get: (h, k) => (k in h ? h[k] : scene.dev?.[k]) });
}
