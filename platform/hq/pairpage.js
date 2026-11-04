// /pair's form: a one-time pair code opens the page it was made for on this device (pair.ts), never HQ.
const form = document.querySelector('form'),
  error = document.querySelector('[role=alert]');
const code = new URLSearchParams(location.hash.slice(1)).get('code');
if (code) {
  form.elements.code.value = code;
  history.replaceState(null, '', location.pathname);
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  form.querySelector('button').disabled = true;
  error.textContent = '';
  try {
    const response = await fetch('/api/pair-codes/open', {
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
    location.assign((await response.json()).url);
  } catch (failure) {
    error.textContent = failure.message;
  } finally {
    form.querySelector('button').disabled = false;
  }
});
