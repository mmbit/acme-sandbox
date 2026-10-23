// The thank-you an outside reviewer sees on their next preview page once something they pinned as broken is fixed and
// live (the coordinator's feedback.ts thanksFor fills in FIXED and serves this after the tool, or alone once they've sent
// their notes). Thanks, it's fixed, refresh and try again, in the page's language, with a few words of their note. It
// tells the coordinator it showed, so each fix is thanked for once; × closes it. Nothing else on the page changes.
(() => {
  const FIXED = JSON.parse('{{FIXED}}'); // { ids, notes: a few words of each, crew: the company's name }
  if (window.top !== window || window.__reviewThanks) return;
  window.__reviewThanks = true;
  const ROUTE = new URL('.', document.currentScript?.src || new URL('/__review/review.js', location.href));
  const WORDS = {
    en: {
      title: n => (n === 1 ? 'Thanks for spotting it!' : 'Thanks for spotting them!'),
      body: (n, crew) =>
        `The ${crew} crew has fixed ${n === 1 ? 'it' : 'them'}. Refresh the page and give ${n === 1 ? 'it' : 'them'} another try.`,
      refresh: 'Refresh',
      close: 'Close',
    },
    nl: {
      title: () => 'Dank je wel voor het melden!',
      body: (n, crew) =>
        `De crew van ${crew} heeft ${n === 1 ? 'het' : 'ze'} opgelost. Ververs de pagina en probeer het nog eens.`,
      refresh: 'Verversen',
      close: 'Sluiten',
    },
    de: {
      title: () => 'Danke fürs Entdecken!',
      body: (n, crew) =>
        `Die ${crew}-Crew hat ${n === 1 ? 'es' : 'sie'} repariert. Lade die Seite neu und probier es noch einmal.`,
      refresh: 'Neu laden',
      close: 'Schließen',
    },
  };

  const CARD = `<style>
    :host { all: initial; }
    * { box-sizing: border-box; }
    .card { position: fixed; z-index: 2147483647; top: max(12px, env(safe-area-inset-top)); left: 50%; width: min(360px, calc(100vw - 24px));
      transform: translateX(-50%); display: grid; grid-template-columns: auto 1fr auto; gap: 4px 12px; align-items: start; padding: 14px 12px 14px 14px;
      background: #fff; color: #2b2230; border-radius: 18px; box-shadow: 0 10px 30px rgba(43,34,48,.22), 0 0 0 1px rgba(43,34,48,.06);
      font: 15px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; animation: drop .55s cubic-bezier(.3,1.4,.5,1) both; }
    .tick { grid-row: span 3; width: 34px; height: 34px; border-radius: 50%; background: #ff5a5f; color: #fff; display: grid; place-items: center;
      animation: pop .5s .25s cubic-bezier(.3,1.6,.5,1) both; }
    .tick svg { width: 18px; height: 18px; }
    b { font-size: 16px; padding-top: 6px; }
    p { margin: 0; grid-column: 2; }
    q { display: block; font-style: italic; color: #6b6170; font-size: 14px; }
    button { font: inherit; color: inherit; cursor: pointer; border: 0; background: none; }
    .x { grid-row: 1; grid-column: 3; width: 40px; height: 40px; margin: -6px -4px 0 0; border-radius: 50%; font-size: 20px; line-height: 1; color: #6b6170; }
    .again { grid-column: 2; justify-self: start; margin-top: 6px; min-height: 36px; padding: 0 16px; border-radius: 18px; background: #2b2230; color: #fff; font-weight: 600; }
    .card.away { animation: lift .3s ease-in both; }
    @keyframes drop { from { opacity: 0; transform: translate(-50%, -24px) scale(.96); } }
    @keyframes pop { from { transform: scale(0); } }
    @keyframes lift { to { opacity: 0; transform: translate(-50%, -16px); } }
    @media (prefers-reduced-motion: reduce) { .card, .tick, .card.away { animation-duration: .01s; animation-delay: 0s; } }
  </style>
  <div class="card" role="status">
    <span class="tick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    <b></b><button class="x" type="button">×</button>
    <p class="said"></p><p class="body"></p>
    <button class="again" type="button"></button>
  </div>`;

  // a beat after the page is up, in the language it set by then (a shop sets its <html lang> from its own script)
  function show() {
    const langs = [document.documentElement.lang, ...(navigator.languages ?? [])].map(l =>
      String(l).slice(0, 2).toLowerCase(),
    );
    const w = WORDS[langs.find(l => Object.hasOwn(WORDS, l))] ?? WORDS.en;
    const host = document.createElement('div'),
      root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = CARD;
    const $ = s => root.querySelector(s),
      n = FIXED.ids.length;
    $('b').textContent = w.title(n);
    $('.body').textContent = w.body(n, FIXED.crew);
    for (const note of FIXED.notes)
      $('.said').append(Object.assign(document.createElement('q'), { textContent: note }));
    $('.x').setAttribute('aria-label', w.close);
    $('.again').textContent = w.refresh;
    $('.again').onclick = () => location.reload();
    $('.x').onclick = () => {
      $('.card').classList.add('away');
      setTimeout(() => host.remove(), 300);
    };
    document.documentElement.append(host);
    // shown: not again for these
    fetch(new URL('thanked', ROUTE), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: FIXED.ids }),
    }).catch(() => {
      /* it shows once more on the next page */
    });
  }
  // ...and only once it's in view: a tab opened in the background doesn't use up the thanks
  const soon = () =>
    document.visibilityState === 'visible'
      ? setTimeout(show, 600)
      : document.addEventListener('visibilitychange', soon, { once: true });
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', soon, { once: true });
  else soon();
})();
