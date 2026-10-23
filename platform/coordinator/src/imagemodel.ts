// The photo studio's image model (studio.ts): a photo and a prompt in, the edited photo out, through Google's Gemini
// API (its Interactions endpoint), with the key the board saved.
import { secret } from './secrets.ts';

export const KEY = 'STUDIO_GEMINI_API_KEY';
const ENDPOINT = process.env.STUDIO_MODEL_URL ?? 'https://generativelanguage.googleapis.com/v1beta/interactions';
const TIMEOUT_MS = 180_000;

export type Size = '1K' | '2K' | '4K';
export const SIZES: Size[] = ['1K', '2K', '4K'];
export const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
// USD per edited picture: the picture out, as Google prices each size (ai.google.dev/gemini-api/docs/pricing, read
// 2026-10-18), and about $0.002 for the photo and the prompt going in
const PRICES: Record<string, Record<Size, number>> = {
  'gemini-nano-banana-2.1': { '1K': 0.0336, '2K': 0.0504, '4K': 0.113 },
  'gemini-3.1-flash-image': { '1K': 0.067, '2K': 0.101, '4K': 0.226 },
  'gemini-3-pro-image': { '1K': 0.134, '2K': 0.134, '4K': 0.24 },
};
const INPUT_USD = 0.002;
export const MODELS = Object.keys(PRICES);
export const price = (model: string, size: Size) => PRICES[model][size] + INPUT_USD;
export const hasKey = () => secret(KEY) !== '';

// A refusal or failure of the model's, in words for the studio's keeper; billed: whether the edit may have been charged
// (false only when the model answered with an error, so made no picture)
export class ImageModelError extends Error {
  billed: boolean;
  constructor(message: string, billed = true) {
    super(message);
    this.billed = billed;
  }
}

export type Edit = { model: string; size: Size; ratio: string; prompt: string; picture: Buffer; type: string };

export async function edit(e: Edit): Promise<{ picture: Buffer; type: string }> {
  const key = secret(KEY);
  if (!key) throw new ImageModelError("the studio's image model has no key yet: the board adds it on the desk phone");
  // store: false, so Google keeps no copy of the board's photo or the edit for later turns (it would by default)
  const body = JSON.stringify({
    model: e.model,
    store: false,
    input: [
      { type: 'text', text: e.prompt },
      { type: 'image', mime_type: e.type, data: e.picture.toString('base64') },
    ],
    response_format: { type: 'image', mime_type: 'image/jpeg', image_size: e.size, aspect_ratio: e.ratio },
  });
  // No second try after a timeout or a dropped connection: the model may have made (and billed) that picture
  const answer = await send(key, body).catch(err => {
    throw new ImageModelError(
      `the image model couldn't be reached: ${err?.name === 'TimeoutError' ? 'no answer in 3 minutes' : err?.message}`,
    );
  });
  const reply = await answer.json().catch(() => null);
  if (!answer.ok)
    throw new ImageModelError(
      `the image model answered ${answer.status}: ${String(reply?.error?.message ?? 'no reason given').slice(0, 300)}`,
      false,
    );
  const content = (reply?.steps ?? [])
    .filter((s: any) => s?.type === 'model_output')
    .flatMap((s: any) => s.content ?? []);
  const image = content.findLast((c: any) => c?.type === 'image' && typeof c.data === 'string');
  if (!image) {
    const words = content
      .filter((c: any) => c?.type === 'text')
      .map((c: any) => String(c.text))
      .join(' ')
      .trim();
    throw new ImageModelError(`the image model sent no picture${words ? `: ${words.slice(0, 300)}` : ''}`);
  }
  return { picture: Buffer.from(image.data, 'base64'), type: String(image.mime_type ?? 'image/jpeg') };
}

const send = (key: string, body: string) =>
  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
