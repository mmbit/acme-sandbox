// The company's mascots (none, one or several), from its brand: who each is, where it belongs, how it behaves and what
// it's doing now. Never agents: no work, no status. How one looks, and where exactly it is, is the renderer's.
import { pick, rand } from '../util.js';
import { emit } from './world.js';

// [{ id, name, kind, role, about, home (a world room), favours (rooms), rules, activity (sleep, nap or one of
//    rules.day), want (the room it's off to), love (s left of a fuss made of it), moves (one more each time it moves on;
//    a renderer takes it somewhere new), stay (s before it moves on) }]
export let mascots = [];
// how a mascot behaves where the brand leaves a rule out
const RULES = { night: 'sleep', day: ['sit'], nap: 0, wander: [6, 14], visitedBy: null, visitChance: 0 };
const NAP_S = [20, 40];

// list: brand.yaml's mascots, each sitting where it is, about to move on
export function init(list = []) {
  mascots = list.map(m => {
    const home = m.home ?? 'board',
      favours = m.favours ?? [home];
    return {
      ...m,
      home,
      favours,
      rules: { ...RULES, ...m.rules },
      activity: 'sit',
      want: favours[0],
      love: 0,
      moves: 0,
      stay: 2,
    };
  });
}

// dark: how dark it is (clock.darkness). One that sleeps at night (rules.night) is asleep while it's dark, and sits a
// moment when it wakes. Awake, it moves on every so often (rules.wander s) to one of the rooms it favours, to do one
// of rules.day or, in full daylight, nap (rules.nap: the chance). Not while someone's making a fuss of it.
export function tick(dt, dark) {
  for (const m of mascots) {
    m.love = Math.max(0, m.love - dt);
    m.stay -= dt;
    if (m.rules.night === 'sleep' && dark > 0.6) m.activity = 'sleep';
    else if (m.activity === 'sleep') {
      if (dark < 0.5) Object.assign(m, { activity: 'sit', stay: 2 });
    } else if (m.stay <= 0 && !m.love) {
      m.activity = dark < 0.3 && Math.random() < m.rules.nap ? 'nap' : pick(Math.random, m.rules.day);
      m.stay = m.activity === 'nap' ? rand(...NAP_S) : rand(...m.rules.wander);
      m.want = pick(Math.random, m.favours);
      m.moves++;
    }
  }
}

const love = (id, s) => {
  const m = mascots.find(x => x.id === id);
  if (m) m.love = s;
};
// a pat: it stays put and enjoys it (feel love)
export function pet(id) {
  love(id, 3);
  emit('feel', { mascot: id, emote: 'love' });
}
// someone from the room it's visited by (rules.visitedBy) is on the way over: it stays put a while for them
export const visit = id => love(id, 4);
