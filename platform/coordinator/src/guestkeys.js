// Guest passkey enrollment and sign-in use the guest desk's separate session.
const words = {
  en: {
    failed: 'The passkey could not open this page. You can use an email code.',
    saved: 'Passkey saved',
    enroll: 'Save a passkey',
    login: 'Use a passkey',
  },
  nl: {
    failed: 'De passkey kon deze pagina niet openen. Je kunt een e-mailcode gebruiken.',
    saved: 'Passkey opgeslagen',
    enroll: 'Passkey opslaan',
    login: 'Passkey gebruiken',
  },
  de: {
    failed: 'Der Passkey konnte diese Seite nicht öffnen. Du kannst einen E-Mail-Code verwenden.',
    saved: 'Passkey gespeichert',
    enroll: 'Passkey speichern',
    login: 'Passkey verwenden',
  },
};
const text = words[document.documentElement.lang] ?? words.en;
async function post(path, body = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(text.failed);
  return response.json();
}
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-guest-passkey]');
  if (!button) return;
  const enroll = button.dataset.guestPasskey === 'enroll';
  const path = enroll ? '/guest/passkeys/enroll' : `${location.pathname.replace(/\/$/, '')}/passkey`;
  button.disabled = true;
  let status =
    button.closest('[data-guest-passkey-prompt]')?.querySelector('[role=status]') ?? button.nextElementSibling;
  if (!status?.matches('[role="status"]')) {
    status = document.createElement('span');
    status.setAttribute('role', 'status');
    button.after(status);
  }
  status.textContent = '';
  try {
    const optionsJSON = await post(`${path}/options`);
    const credential = enroll
      ? await globalThis.SimpleWebAuthnBrowser.startRegistration({ optionsJSON })
      : await globalThis.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON });
    await post(`${path}/verify`, credential);
    if (enroll) {
      button.textContent = text.saved;
      button.hidden = true;
      status.textContent = text.saved;
    } else location.reload();
  } catch {
    status.textContent = text.failed;
  } finally {
    button.disabled = false;
  }
});

const prompt = document.querySelector('[data-guest-passkey-prompt]');
if (prompt && sessionStorage.getItem('guest.passkey.dismissed')) prompt.hidden = true;
document.addEventListener('click', event => {
  if (!event.target.closest('[data-guest-passkey-dismiss]')) return;
  event.target.closest('[data-guest-passkey-prompt]').hidden = true;
  sessionStorage.setItem('guest.passkey.dismissed', '1');
});
