// Pictures for the board's next intercom line (request 0) or a desk-phone card's answer, each uploaded as it's added
import * as world from '../world/world.js';
import { loadWaitingPictures, forgetPicture, uploadPicture, pictureUrl } from './data.js';
import { sfx } from './audio.js';

const PICTURES_MAX = 6,
  MAX_SIDE = 2560;

// host() is the tray's element as drawn now (null while it isn't), say(text, error) the line that tells the board what
// happened (error: it went wrong)
export class Tray {
  list = []; // { key, url (what's shown here), pct, id once it's uploaded, done, sending, removed (until the coordinator lets go) }
  keys = 0;
  gone = new Set(); // the numbers that left the tray, sent or taken out: a slow restore mustn't bring them back
  goingUp = new Set(); // this tab's uploads under way, removed ones too (restore)
  uploadsStarted = 0;
  constructor(request, host, say) {
    Object.assign(this, { request, host, say });
  }

  add(files) {
    const images = [...files].filter(f => f.type.startsWith('image/')),
      room = PICTURES_MAX - this.list.length;
    if (!images.length) return;
    this.say(''); // (a new picture action starts without the last one's error)
    if (images.length > room) this.say(`One message takes up to ${PICTURES_MAX} pictures.`, true);
    for (const file of images.slice(0, Math.max(0, room))) this.upload(file);
    this.paint();
    sfx.blip();
  }
  // The line (or answer) sent carries the pictures' numbers: the coordinator reads them (chat.ts, jobs.ts's
  // answerRequest) and saves them (pictures.ts).
  upload(file) {
    const p = { key: ++this.keys, pct: 0 };
    this.list.push(p);
    this.goingUp.add(p);
    this.uploadsStarted++;
    p.done = shrink(file)
      .then(blob => {
        if (p.removed) {
          this.drop(p);
          return null;
        }
        p.url = URL.createObjectURL(blob);
        this.paint();
        return uploadPicture(world.dev, blob, {
          request: this.request,
          onProgress: pct => {
            p.pct = pct;
            this.paint();
          },
        });
      })
      .then(
        r => {
          if (!r) return;
          p.id = r.id;
          if (p.removed) return this.release(p);
          this.paint();
        },
        err => {
          const removed = p.removed;
          this.drop(p);
          if (!removed) this.say(pictureError(err), true);
        },
      )
      .finally(() => this.goingUp.delete(p));
  }
  // The pictures still waiting on the coordinator when the intercom (or the card) opens: what was in the tray before a
  // reload, or before it was closed with an upload still going. The board can send them or take them out.
  async restore() {
    this.paint(); // (what this tab already has, meanwhile)
    const waiting = await this.waiting();
    if (waiting) this.settle(waiting);
  }
  // The list is asked for once none of this tab's uploads is under way: one may already be on it before its number is
  // back here, and two tiles for one picture could be removed apart, the other keeping a deleted number. An upload begun
  // while this waits, or while the list is on its way, means waiting and asking again (the count is taken first).
  async waiting() {
    for (;;) {
      const started = this.uploadsStarted;
      await Promise.all([...this.goingUp].map(p => p.done));
      const waiting = await loadWaitingPictures(world.dev, this.request).catch(() => null);
      if (!waiting || this.uploadsStarted === started) return waiting; // (else one began meanwhile, and may be on the list already)
    }
  }
  // A list that came back is the truth about the uploaded tiles too: one not on it was removed in another tab, or went
  // unsent after a day, and leaves (a line with it would be refused). A list that didn't come back changes nothing.
  settle(waiting) {
    const listed = new Set(waiting.map(w => w.id));
    const unlisted = this.list.filter(p => p.id && !p.sending && !listed.has(p.id)); // (a line going settles its own)
    for (const p of unlisted) {
      p.removed = true;
      letGo(p);
    }
    this.list = this.list.filter(p => !unlisted.includes(p));
    const known = new Set(this.list.map(p => p.id));
    for (const w of waiting) {
      if (known.has(w.id) || this.gone.has(w.id) || this.list.length >= PICTURES_MAX) continue;
      this.list.push({
        key: ++this.keys,
        pct: 100,
        id: w.id,
        url: pictureUrl(world.dev, w.id),
        done: Promise.resolve(),
      });
    }
    this.paint();
  }
  paint() {
    const el = this.host();
    if (!el) return;
    el.hidden = !this.list.length;
    el.innerHTML = this.list
      .map(
        p => `<span class="pic${p.removed ? ' busy removing' : p.id ? '' : ' busy'}">${p.url ? `<img src="${p.url}" alt="">` : ''}${p.removed ? '<i>Removing</i>' : p.id ? '' : `<i>${p.pct}%</i>`}
      ${p.sending || p.removed ? '' : `<button type="button" data-unpick="${p.key}" aria-label="Remove this picture">×</button>`}</span>`,
      )
      .join('');
    el.querySelectorAll('[data-unpick]').forEach(
      b =>
        (b.onclick = () => {
          this.unpick(+b.dataset.unpick);
          sfx.blip();
        }),
    );
  }
  // The board takes a picture out, unless its line is on its way. Its tile stays, marked, until the coordinator has let
  // go of it (an upload still going, once it lands: upload), as it still counts against the pictures that may wait.
  unpick(key) {
    const p = this.list.find(x => x.key === key);
    if (!p || p.sending || p.removed) return;
    this.say('');
    p.removed = true;
    this.paint();
    if (p.id) this.release(p);
  }
  // Deleted on the coordinator, then out of the tray, and kept out of a waiting list asked for before. If the coordinator
  // can't, the tile is back for the board to send or take out again, and it's told why.
  release(p) {
    return forgetPicture(world.dev, p.id).then(
      () => {
        this.gone.add(p.id);
        this.drop(p);
      },
      err => {
        console.error('Could not remove a picture:', err);
        p.removed = false;
        this.paint();
        this.say('Couldn’t remove that picture. Try again in a minute.', true);
      },
    );
  }
  drop(p) {
    letGo(p);
    this.list = this.list.filter(x => x !== p);
    this.paint();
  }
  // Out of the tray for good, and kept out of a waiting list asked for before: pictures a line went with (the coordinator
  // keeps them with their line), or ones it no longer has
  takeOut(batch) {
    for (const p of batch) {
      letGo(p);
      this.gone.add(p.id);
    }
    this.list = this.list.filter(p => !batch.includes(p));
  }
  // The numbers of the batch's pictures, once every one is uploaded; null if one didn't make it (it's gone from the tray
  // and the board was told why, so it can look before sending)
  async sent(batch) {
    if (batch.some(p => !p.id)) this.say('Sending the pictures…');
    await Promise.all(batch.map(p => p.done));
    if (batch.some(p => !p.id)) return null;
    this.say('');
    return batch.map(p => p.id);
  }
  // what Send takes (the ones being removed stay behind), marked while it goes; a refusal's missing ones leave
  batch() {
    return this.list.filter(p => !p.removed);
  }
  sending(batch, on) {
    batch.forEach(p => {
      p.sending = on;
    });
    this.paint();
  }
  refused(batch, missing) {
    this.takeOut(batch.filter(p => missing.includes(p.id)));
    this.restore();
  }
}
const letGo = p => {
  if (p.url?.startsWith('blob:')) URL.revokeObjectURL(p.url);
};
const pictureError = err => {
  const status = +String(err?.message ?? '').match(/\d{3}$/)?.[0];
  return err === 'decode'
    ? 'Couldn’t read that picture. Try a screenshot, a photo or a JPEG.'
    : status === 413
      ? 'That picture is too big to send. Try a smaller one.'
      : status === 429
        ? 'Too many pictures are waiting. Send or remove some first.'
        : status
          ? `The server couldn’t take that picture (error ${status}). Try again in a minute.`
          : 'Could not reach the coordinator. Try the picture again.';
};

// Decode (honouring the camera's rotation), scale down to maxSide pixels on the long side, re-encode as JPEG: no camera
// metadata, and HEIC turned into JPEG. Throws 'decode' if the browser can't read it. (The desk phone's photo fields, a
// call's pictures and the studio's photos redraw theirs the same way.)
export async function shrink(file, maxSide = MAX_SIDE) {
  let src = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (!src)
    src = await new Promise(res => {
      const u = URL.createObjectURL(file),
        im = new Image();
      im.onload = () => {
        URL.revokeObjectURL(u);
        res(im);
      };
      im.onerror = () => {
        URL.revokeObjectURL(u);
        res(null);
      };
      im.src = u;
    });
  const w = src?.naturalWidth || src?.width,
    h = src?.naturalHeight || src?.height;
  if (!w || !h) throw 'decode';
  const k = Math.min(1, maxSide / Math.max(w, h)),
    c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  src.close?.();
  const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
  if (!blob) throw 'decode';
  return blob;
}
