// The board accepts a one-time device sign-in, without synchronizing app annotations.
const form = document.querySelector('form'),
  error = document.querySelector('[role=alert]');
// (view: a preview HQ's viewer opens once signed in, the QR in the viewer's bar: shell/viewer.js)
const asked = new URLSearchParams(location.hash.slice(1)),
  code = asked.get('code'),
  view = asked.get('view');
if (code) {
  form.elements.code.value = code;
  history.replaceState(null, '', location.pathname);
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  form.querySelector('button').disabled = true;
  error.textContent = '';
  try {
    const response = await fetch('/api/notebooks/pair/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: form.elements.code.value }),
    });
    if (!response.ok)
      throw new Error(
        response.status === 429
          ? 'Too many tries. Wait a minute, then ask for a fresh code.'
          : 'This code has expired or was used. Ask for a fresh code.',
      );
    location.assign(view ? `/?${new URLSearchParams({ open: 'viewer', url: view })}` : '/');
  } catch (failure) {
    error.textContent = failure.message;
  } finally {
    form.querySelector('button').disabled = false;
  }
});
