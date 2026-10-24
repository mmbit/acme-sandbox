// HQ's weather: occasional rain (snow in winter), decided per three-hour block so everyone sees the same sky.
import { rng } from '../util.js';
import { season } from './clock.js';

// Tapping the roof garden's water tower picks the weather (an easter egg), in turn, then back to the real one
const PICKS = [null, 'rain', 'showers', 'snow', 'fog', 'cloudy', 'clear'];
let fixed = null,
  picked = null;

// q: the page's query. ?weather=rain holds the weather
export function init(q) {
  fixed = q.get('weather');
}
export const pickWeather = () => (picked = PICKS[(PICKS.indexOf(picked) + 1) % PICKS.length]);
export function weatherAt(d = new Date()) {
  const forced = fixed || picked;
  if (forced) return forced;
  const r = rng(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${(d.getHours() / 3) | 0}`)();
  const cold = season(d) === 'winter',
    h = d.getHours();
  if (r < 0.2) return cold ? 'snow' : 'rain';
  if (r < 0.26) return cold || h < 8 || h > 17 ? 'cloudy' : 'showers'; // sun and a light shower: a rainbow
  if (r < 0.34 && h >= 5 && h < 10 && (cold || season(d) === 'autumn')) return 'fog';
  return r < 0.5 ? 'cloudy' : 'clear';
}
