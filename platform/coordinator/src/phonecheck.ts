// hq phone --check: the line as Twilio has it (phone.ts takes the calls).
import { ORIGIN } from './config.ts';
import { secret } from './secrets.ts';
import { twilioAccount, askTwilio } from './calls.ts';
import { international } from './phonelines.ts';

type IncomingNumber = {
  phone_number: string;
  status?: string;
  capabilities?: { voice?: boolean };
  voice_url?: string | null;
  voice_method?: string;
  voice_application_sid?: string | null;
  trunk_sid?: string | null;
};
// hq phone --check: the line as Twilio has it, asked with the coordinator's own keys. Whether Twilio's API takes the
// keys (a webhook signed with another token is refused above, and a caller hears Twilio's error), the account's state
// and where the number sends a call. It never shows a key, a caller's number or a call.
export async function checkLine() {
  const account = twilioAccount(),
    hq = `${ORIGIN}/api/twilio/voice`;
  const reached = [`A signed call has reached HQ for this account: ${account?.signed ? 'yes' : 'no'}.`];
  if (account?.signedAccount && !account.signed)
    reached.push('A signed call named another account than the saved TWILIO_ACCOUNT_SID.');
  if (!account)
    return [
      `No account to ask: save Twilio's Account SID as TWILIO_ACCOUNT_SID, or a signed call names it.`,
      ...reached,
    ];
  if (!secret('TWILIO_AUTH_TOKEN')) return ['No TWILIO_AUTH_TOKEN saved.', ...reached];
  const accountName = account.signed ? 'the account a signed call named' : 'the saved TWILIO_ACCOUNT_SID';
  try {
    const accountResponse = await askTwilio(account.sid, '.json');
    if (accountResponse.status === 401)
      return [
        `Twilio refused HQ's keys for ${accountName}: the saved auth token isn't that account's (or the SID is another account's).`,
        ...reached,
      ];
    if (!accountResponse.body) return [`Twilio answered ${accountResponse.status} for ${accountName}.`, ...reached];
    const lines = [
      `Twilio took HQ's keys for ${accountName}: the account is ${accountResponse.body.status} (${accountResponse.body.type}).`,
    ];
    const configuredNumber = international(secret('TWILIO_PHONE_NUMBER'));
    if (!configuredNumber) return [...lines, 'No TWILIO_PHONE_NUMBER saved.', ...reached];
    const number = await onAccount(account.sid, configuredNumber);
    if (typeof number === 'string') return [...lines, number, ...reached];
    lines.push(
      `The number: on the account (${number.status ?? 'no status'}), ${number.capabilities?.voice ? 'takes' : "doesn't take"} voice calls.`,
    );
    const voiceRoute = describeVoiceRoute(number, hq);
    lines.push(`A call comes in: ${voiceRoute}.`);
    return [...lines, ...reached];
  } catch (err) {
    return [`Couldn't reach Twilio: ${(err as Error).message}`, ...reached];
  }
}

// The saved number on the account's list of numbers, or why it isn't there
async function onAccount(sid: string, configuredNumber: string): Promise<IncomingNumber | string> {
  const numbersResponse = await askTwilio(sid, '/IncomingPhoneNumbers.json?PageSize=1000');
  if (!numbersResponse.body) return `Twilio answered ${numbersResponse.status} for the account's numbers.`;
  if (!Array.isArray(numbersResponse.body.incoming_phone_numbers))
    return "Twilio returned an invalid list of the account's numbers.";
  const numbers = numbersResponse.body.incoming_phone_numbers as IncomingNumber[];
  const number = numbers.find(candidate => {
    const listedNumber = international(candidate.phone_number);
    return configuredNumber.startsWith('0')
      ? listedNumber.endsWith(configuredNumber.slice(1))
      : listedNumber === configuredNumber;
  });
  return (
    number ??
    `TWILIO_PHONE_NUMBER isn't on this account (it has ${numbers.length} ${numbers.length === 1 ? 'number' : 'numbers'}).`
  );
}

const describeVoiceRoute = (number: IncomingNumber, hq: string) => {
  if (number.trunk_sid) return 'a SIP trunk takes it, not a URL';
  if (number.voice_application_sid) return "a TwiML app takes it (the app's voice URL, not the number's)";
  if (!number.voice_url) return 'no voice URL';
  const method = number.voice_method?.toUpperCase() || 'no method';
  const methodNote = method === 'POST' ? 'POST' : `${method}, but HQ takes only POST`;
  if (number.voice_url === hq) return `HQ's ${hq}, ${methodNote}`;
  return `another URL, ${withoutSecrets(number.voice_url, hq)}, ${methodNote} (HQ's is ${hq}, POST)`;
};

// Another service's path or query can hold its key, so only the host shows and whether the path is HQ's.
const withoutSecrets = (url: string, hq: string) => {
  try {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname === new URL(hq).pathname ? "HQ's path" : 'another path';
    return `${parsedUrl.protocol}//${parsedUrl.host} (${path}${parsedUrl.search ? ', with a query' : ''})`;
  } catch {
    return 'not a URL';
  }
};
