// Guest notebook invitations and session refusals in the page's language, through the real coordinator.
import assert from 'node:assert/strict';
import { until } from '../../shared/browser/browser.mjs';
import { readyNotebook } from './bookguestscreen.mjs';

export async function refusalStory(state, visitor, lang, name) {
  const { createNotebook } = await import('../coordinator/src/notebookguests.ts');
  const created = {
    status: 200,
    body: createNotebook({
      kind: 'round',
      name: 'Colleague invitations',
      colleagues: true,
      people: [{ name, email: `${name.toLowerCase()}@example.org` }],
    }),
  };
  assert.equal(created.status, 200);
  const page = visitor.page;
  await page.goto(`${state.origin}/guest/notebooks/?notebook=${created.body.notebook.id}`);
  await readyNotebook(page);
  await page
    .locator('#book .bk-island')
    .getByRole('button', { name: lang === 'nl' ? 'Collega uitnodigen' : 'Kollegen einladen', exact: true })
    .click();
  await page.locator('.bk-guest-invite').waitFor({ state: 'visible' });
  await inviteColleague(page, 'Faye', 'faye@gmail.com');
  await until(
    page,
    '[data-invite-error]',
    lang === 'nl'
      ? /Nodig iemand uit met een e-mailadres van je eigen bedrijf/
      : /Lade jemanden mit einer E-Mail-Adresse deines eigenen Unternehmens ein/,
  );
  await page.locator('[data-invite-error]').scrollIntoViewIfNeeded();
  if (state.shots) await page.screenshot({ path: `${state.shots}/guest-refusal-${lang}-phone.png` });
  await inviteColleague(page, name, `${name.toLowerCase()}@example.org`);
  await until(
    page,
    '[data-invite-error]',
    lang === 'nl' ? /Deze persoon heeft al een pagina in de ronde/ : /Diese Person hat bereits eine Seite in der Runde/,
  );
  await visitor.context.clearCookies();
  await until(
    page,
    '[data-notebook-status]',
    lang === 'nl' ? /Meld je opnieuw aan via je uitnodigingslink/ : /Melde dich über deinen Einladungslink erneut an/,
  );
  assert.equal(await page.locator('#book').count(), 0);
}

async function inviteColleague(page, name, email) {
  await page.locator('.bk-guest-invite [name=name]').fill(name);
  await page.locator('.bk-guest-invite [name=email]').fill(email);
  await page.locator('.bk-guest-invite button:not([data-close])').click();
}
