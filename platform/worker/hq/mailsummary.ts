// hq mail summary: a month's books to the board's own address (platform/coordinator/src/mailforward.ts sendReport),
// its state, and a send that may have gone confirmed as arrived. Its help is hq mail's.
import { readFileSync } from 'node:fs';
import * as api from './api.ts';
import type { ReportReceipt, ReportState } from '../../coordinator/src/mailforward.ts';
import { isReadable, readWords } from './files.ts';
import { minute, oneLine, print, stop, text, warn } from './output.ts';

const SUMMARY_USAGE =
  'usage: hq mail summary --month YYYY-MM --kind preview|closed --records YYYY-MM-DD --attach <file.txt> [--again] <body-file | ->, hq mail summary --month YYYY-MM --kind preview|closed --arrived, or hq mail summary [--month YYYY-MM]';
// Each state's exit code, as the help says
const SUMMARY_EXIT: Record<ReportState, number> = {
  accepted: 0,
  arrived: 0,
  'not ready': 2,
  failed: 1,
  uncertain: 3,
  sending: 3,
};

export async function summary(args: string[]) {
  const options: Record<string, string> = {};
  let body = '',
    again = false,
    arrived = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--month', '--kind', '--records', '--attach'].includes(arg)) {
      if (i + 1 >= args.length) stop(SUMMARY_USAGE);
      options[arg.slice(2)] = args[++i];
    } else if (arg === '--again') again = true;
    else if (arg === '--arrived') arrived = true;
    else if (!body && (arg === '-' || isReadable(arg))) body = readWords(arg);
    else stop(SUMMARY_USAGE);
  }
  const { month, kind, records, attach } = options;
  if (arrived) {
    if (!month || !kind || records || attach || body || again) stop(SUMMARY_USAGE);
    return confirmArrival(month, kind);
  }
  if (!kind && !records && !attach && !body && !again) {
    const route = `mail-summary${month ? `?month=${api.uri(month)}` : ''}`;
    const list: ReportReceipt[] = JSON.parse(
      await api.orStop(api.getUnlessRefused(route), "hq mail summary: couldn't read the deliveries."),
    );
    return print(...(list.length ? list.map(receiptLine) : ['None asked yet.']));
  }
  if (!month || !kind || !records || !attach || !body) stop(SUMMARY_USAGE);
  if (!isReadable(attach)) stop(`hq mail summary: can't read ${attach}.`);
  const file = readFileSync(attach).toString('base64');
  const answer = await api.orNoAnswer(
    api.call('mail-summary', { body: { month, kind, records, file, body, again }, timeoutMs: 120_000 }),
  );
  if (answer.status === 200) {
    const receipt: ReportReceipt = JSON.parse(answer.body);
    print(`${receipt.already ? 'Asked before, nothing sent now: ' : ''}${receiptLine(receipt)}`);
    if (receipt.state === 'uncertain' || receipt.state === 'sending')
      warn('It may have gone: ask the board whether it arrived, then --arrived if it did, --again if it never did.');
    const code = SUMMARY_EXIT[receipt.state];
    if (code) stop('', code);
    return;
  }
  if (api.isRefusal(answer.status)) stop(`hq mail summary: ${api.errorIn(answer.body, 'refused')}. Nothing was sent.`);
  stop(
    `hq mail summary: no answer from HQ (HTTP ${api.httpCode(answer.status)}): it may have gone. Its state: hq mail summary --month ${month}`,
    3,
  );
}

// hq mail summary --arrived: the board found a send that may have gone in its inbox
async function confirmArrival(month: string, kind: string) {
  const answer = await api.orStop(
    api.call('mail-summary/arrived', { body: { month, kind } }),
    "hq mail summary: couldn't reach HQ: nothing recorded.",
  );
  if (api.isRefusal(answer.status)) stop(`hq mail summary: ${api.errorIn(answer.body, 'refused')}. Nothing recorded.`);
  if (!api.isSuccess(answer.status)) stop(`hq mail summary: HTTP ${api.httpCode(answer.status)}: check its state.`);
  print(receiptLine(JSON.parse(answer.body)));
}

const receiptLine = (receipt: ReportReceipt) =>
  [
    `${text(receipt.month)} ${text(receipt.kind)}: ${text(receipt.state)}`,
    ...(receipt.records ? [`records as of ${text(receipt.records)}`] : []),
    ...(receipt.tried ? [`asked ${minute(text(receipt.tried))} UTC`] : []),
    ...(receipt.receipt ? [`receipt ${oneLine(text(receipt.receipt))}`] : []),
    ...(receipt.failure ? [`(${oneLine(text(receipt.failure))})`] : []),
    ...(receipt.confirmed ? [`arrival confirmed ${minute(text(receipt.confirmed))} UTC`] : []),
  ].join(', ');
