// The CLI records feature membership, an agent's expected cost and observed board milestones.
import * as api from './api.ts';
import { readTextOrStdin } from './files.ts';
import { print, stop } from './output.ts';
import { takeValues } from './flags.ts';

export const help = `
   hq deliverable feature <member> <original>        group initial deliverables under one feature for cost accounting
   hq deliverable feedback <member> <original> --round <label>
                                                     count this feedback deliverable under the original feature.
                                                     Use the same round label for pieces of one board feedback round
   hq deliverable cost <original> <file.json | ->    save your expected cost through board approval, reasoned from past
                                                     jobs: {tokens:{work,reviews,fixes,feedback},seat_weeks,
                                                     feedback_rounds,refs:[jobs],why,confidence:{level,why}}.
                                                     Confidence is your judgment: low, medium or high, based on the
                                                     number and closeness of examples. Use null seat_weeks when unknown.
                                                     Reads show recorded cost beside ETA. No cost is inferred by HQ
   hq deliverable milestone <feature> delivered|approved <file.json | ->
                                                     record an observed milestone: {at:ISO instant,evidence:source}.
                                                     A merge or an owner's done is never inferred to be board approval`;

export async function record(action: string, given: string[]) {
  if (action === 'feature' || action === 'feedback') return link(action, given);
  const [id, value, file, ...rest] = given;
  const milestone = action === 'milestone';
  if (!id || !value || rest.length || (milestone ? !file : file !== undefined))
    stop(
      `usage: hq deliverable ${action} <feature> ${milestone ? 'delivered|approved <file.json | ->' : '<file.json | ->'}`,
    );
  const contents = JSON.parse(readTextOrStdin(milestone ? file : value));
  const body = milestone
    ? { id, milestone: value, at: contents.at, evidence: contents.evidence }
    : { id, expected: contents };
  const answer = await api.change(`threads/${milestone ? 'milestone' : 'cost'}`, { body: api.withSpeaker(body) });
  if (!api.isSuccess(answer.status)) stop(`Nothing recorded: ${api.errorIn(answer.body, 'no answer')}`);
  print(`Recorded ${id}'s ${milestone ? value : 'expected feature cost'}.`);
}

async function link(action: string, given: string[]) {
  const {
    values,
    args: [id, feature, ...rest],
  } = takeValues(given, ['--round'], 'Nothing linked');
  if (!id || !feature || rest.length || (action === 'feedback' && !values.round?.trim()))
    stop(`usage: hq deliverable ${action} <member> <original>${action === 'feedback' ? ' --round <label>' : ''}`);
  const answer = await api.change('threads/feature', {
    body: api.withSpeaker({
      id,
      feature,
      round: action === 'feedback' ? values.round!.trim() : '',
      feedback: action === 'feedback',
    }),
  });
  if (!api.isSuccess(answer.status)) stop(`Nothing linked: ${api.errorIn(answer.body, 'no answer')}`);
  print(`Linked ${id} under feature ${feature}.`);
}
