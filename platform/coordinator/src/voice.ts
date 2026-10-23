// Voice from the intercom: the board's recording goes to the speech-to-text container (whisper.cpp's own
// server, reachable only on the internal network) and the text comes back to the directive field for review.
// Nothing is stored: the clip lives in memory for the length of the request.
import type { IncomingMessage } from 'node:http';
import { org, names } from './company.ts';

const STT_URL = process.env.STT_URL ?? 'http://stt:8080';
const MAX_BYTES = 5 * 1024 * 1024; // about two minutes of opus or AAC, with room to spare
const LANGS = new Set(['en', 'nl', 'de', 'auto']);

// Names whisper can't guess: they bias the spelling, not the content.
const vocabulary = () => {
  const o = org(), people = (o.departments ?? []).flatMap((d: any) => (d.agents ?? []).map((a: any) => a.name));
  return `${names().name} ${names().hq}. ${people.join(', ')}.`;
};
// Sound tags ([BLANK_AUDIO], (music), *laughs*) are whisper's formatting, never the board's words. Whisper also makes
// up words from silence and noise ("Thank you.", "Thanks for watching"): the STT server's voice activity detection
// (platform/stt) keeps anything but speech from reaching it, so no transcript is dropped here for what it says (a board
// that says just "Thank you." is heard).
const clean = (s: string) => s.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();

// lang: the language it's heard in, else the request's own (?lang=), else whisper guesses
export async function transcribe(req: IncomingMessage, lang?: string) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!/^(audio|video)\/[\w.+-]+$/.test(type)) return 415; // iOS labels its AAC recordings video/mp4 at times
  if (Number(req.headers['content-length'] ?? 0) > MAX_BYTES) return 413;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { if ((size += c.length) > MAX_BYTES) return 413; chunks.push(c); }
  if (size < 200) return 400;
  return speechToText(Buffer.concat(chunks), type, lang ?? new URL(req.url ?? '/', 'http://x').searchParams.get('lang') ?? 'auto');
}

export async function speechToText(audio: Buffer, type: string, lang: string) {
  const form = new FormData();
  form.append('file', new Blob([audio], { type }), 'clip');
  form.append('language', LANGS.has(lang) ? lang : 'auto');
  form.append('prompt', vocabulary());
  form.append('response_format', 'json');
  form.append('temperature', '0');
  try {
    const res = await fetch(`${STT_URL}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const { text } = await res.json() as { text?: string };
    return { text: clean(text ?? '') };
  } catch (err) {
    console.error('stt:', (err as Error).message);
    return 503;
  }
}
