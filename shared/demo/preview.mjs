// Install the host-scoped preview pass supplied by hq preview in a Playwright context.
const preview = process.env.HQ_PREVIEW_URL;
const cookie = process.env.HQ_PREVIEW_COOKIE;

export async function authenticatePreview(context, target) {
  if (!preview && !cookie) return;
  if (!preview || !cookie || new URL(target).origin !== new URL(preview).origin)
    throw new Error('Preview access requires the matching URL and cookie from hq preview');
  const separator = cookie.indexOf('=');
  if (separator < 1) throw new Error('Preview cookie is malformed');
  await context.addCookies([
    {
      name: cookie.slice(0, separator),
      value: cookie.slice(separator + 1),
      url: new URL(preview).origin,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}
