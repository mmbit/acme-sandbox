// The phone line's calls at Twilio (phone.ts): each call's record there holds the caller's number, so the hourly job
// deletes every call that ended 10 minutes ago. The privacy pages say "within two hours". It also asks Twilio about the
// account for hq phone --check.
import { db } from './db.ts';
import { secret } from './secrets.ts';

const API = process.env.TWILIO_API ?? 'https://api.twilio.com',
  PAUSE = Number(process.env.TWILIO_RETRY_MS) || 2000,
  SETTLE_MS = 600_000;
// (accountUrl, authOf: callsweep.ts's dial too)
export const accountUrl = (account: string) => `${API}/2010-04-01/Accounts/${account}`;
export const authOf = (account: string) => ({
  authorization: 'Basic ' + Buffer.from(`${account}:${secret('TWILIO_AUTH_TOKEN')}`).toString('base64'),
});

// Any signed webhook names the account; the hourly job needs it to list the calls.
export function rememberAccount(account: string | null) {
  if (account && /^AC[0-9a-f]{32}$/.test(account))
    db.prepare(
      `insert into settings (key, value) values ('twilio_account', ?)
      on conflict (key) do update set value = excluded.value`,
    ).run(account);
}

// The account to ask Twilio about: the Account SID the board saved, else the one a signed webhook named, so a replaced
// account wins and the hourly job and hq phone --check work before any call has reached HQ. The signed account comes
// along, so the check can say when it isn't the saved one.
export function twilioAccount() {
  const signedAccount = (
    db.prepare("select value from settings where key = 'twilio_account'").get() as { value: string } | undefined
  )?.value;
  const sid = secret('TWILIO_ACCOUNT_SID') || signedAccount;
  return sid ? { sid, signed: sid === signedAccount, signedAccount } : null;
}

// Account diagnostics need the HTTP status as well as the JSON.
export async function askTwilio(account: string, path: string) {
  try {
    const responseBody = await twilio(`${accountUrl(account)}${path}`, authOf(account));
    return { status: 200, body: JSON.parse(responseBody.toString()) as Record<string, unknown> };
  } catch (err) {
    if (err instanceof TwilioError) return { status: err.status, body: null };
    throw err;
  }
}

// Every call that ended 10 minutes ago. False if Twilio's list failed (the next hour tries again).
export async function deleteEndedCalls(now = Date.now()) {
  const account = twilioAccount()?.sid;
  if (!account || !secret('TWILIO_AUTH_TOKEN')) return true;
  const auth = authOf(account),
    ended = ['completed', 'busy', 'failed', 'no-answer', 'canceled'];
  type Listed = { sid: string; status: string; end_time: string | null };
  try {
    for await (const c of listed<Listed>(account, auth)) {
      if (
        !ended.includes(c.status) ||
        !/^CA[0-9a-f]{32}$/.test(c.sid) ||
        !(Date.parse(c.end_time ?? '') < now - SETTLE_MS)
      )
        continue;
      await twilio(`${accountUrl(account)}/Calls/${c.sid}.json`, auth, 'DELETE').catch(err =>
        console.error('calls: could not delete an ended call at Twilio:', err.message),
      );
    }
    return true;
  } catch (err) {
    console.error('calls: could not list calls at Twilio:', (err as Error).message);
    return false;
  }
}

// Every call of the account at Twilio, page by page. Throws when the list goes on past 20 pages of 100: a partial list
// must not pass for the whole one.
async function* listed<T>(account: string, auth: Record<string, string>) {
  let url = `${accountUrl(account)}/Calls.json?PageSize=100`;
  for (let page = 0; url && page < 20; page++) {
    const body = JSON.parse((await twilio(url, auth)).toString()) as { calls?: T[]; next_page_uri?: string };
    yield* body.calls ?? [];
    url = body.next_page_uri?.startsWith('/2010-04-01/') ? API + body.next_page_uri : '';
  }
  if (url) throw new Error('more than 20 pages of calls');
}

// Twilio can have a bad minute: three tries, then the next hour. Deleting something that's already gone is fine.
async function twilio(url: string, headers: Record<string, string>, method = 'GET') {
  for (let i = 0; ; i++) {
    let status = 0;
    try {
      const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(30_000) });
      if (res.ok || (method === 'DELETE' && res.status === 404)) return Buffer.from(await res.arrayBuffer());
      status = res.status;
      await res.body?.cancel();
    } catch (err) {
      if (i === 2) throw err;
    }
    if (i === 2 || (status && status !== 404 && status !== 429 && status < 500)) throw new TwilioError(method, status);
    await new Promise(r => setTimeout(r, PAUSE * (i + 1)));
  }
}

class TwilioError extends Error {
  status: number;
  constructor(method: string, status: number) {
    super(`Twilio ${method} ${status}`);
    this.status = status;
  }
}

const hourly = () => deleteEndedCalls().catch(err => console.error('calls:', err.message));
hourly();
setInterval(hourly, 3_600_000).unref();
