// Guest notebook invitations and session refusals in the page's language, through the real coordinator.
import assert from 'node:assert/strict';
import { until } from '../../shared/browser/browser.mjs';

export async function refusalStory(state, visitor, lang, name) {
  const created = await state.h.board('/api/notebooks/guests', {
    kind: 'round',
    name: 'Colleague invitations',
    colleagues: true,
    people: [{ name, email: `${name.toLowerCase()}@example.org` }],
  });
  assert.equal(created.status, 200);
  const page = visitor.page;
  await page.goto(`${state.origin}/guest/notebooks/?notebook=${created.body.notebook.id}`);
  await page.locator('.ng-invite').waitFor({ state: 'visible' });
  await page.locator('.ng-invite [name=name]').fill('Faye');
  await page.locator('.ng-invite [name=email]').fill('faye@gmail.com');
  await page.locator('.ng-invite button').click();
  await until(
    page,
    '.ng-error',
    lang === 'nl'
      ? /Nodig iemand uit met een e-mailadres van je eigen bedrijf/
      : /Lade jemanden mit einer E-Mail-Adresse deines eigenen Unternehmens ein/,
  );
  await page.locator('.ng-error').scrollIntoViewIfNeeded();
  if (state.shots) await page.screenshot({ path: `${state.shots}/guest-refusal-${lang}-phone.png` });
  await page.locator('.ng-invite [name=name]').fill(name);
  await page.locator('.ng-invite [name=email]').fill(`${name.toLowerCase()}@example.org`);
  await page.locator('.ng-invite button').click();
  await until(
    page,
    '.ng-error',
    lang === 'nl' ? /Deze persoon heeft al een pagina in de ronde/ : /Diese Person hat bereits eine Seite in der Runde/,
  );
  await visitor.context.clearCookies();
  await until(
    page,
    '.ng-state',
    lang === 'nl' ? /Meld je opnieuw aan via je uitnodigingslink/ : /Melde dich über deinen Einladungslink erneut an/,
  );
  assert.equal(await page.locator('.ng-compose').isVisible(), false);
}
