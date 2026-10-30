// The shared Ink controls' mutations, restricted to the guest's own page before every action.
import { db } from './db.ts';
import * as guests from './notebookguests.ts';
import * as notebook from './notebook.ts';
import * as groups from './notebookgroups.ts';
import * as sending from './notebooksend.ts';
import * as rounds from './notebookrounds.ts';
import * as answers from './ink/bookanswer.ts';
import { type Refused } from './pagechecks.ts';

export async function act(action: string, b: any, name: string, stillSignedIn = () => true) {
  if (action === 'invite') return guests.inviteColleague(b, name);
  if (action === 'pages/create') return createPage(b, name);
  const page = actionPage(action, b),
    member = guests.pageMember(page, name);
  if (!member) return 404;
  if (action === 'move' && guests.pageMember(Number(b.page), name)?.notebook !== member.notebook) return 404;
  const round = rounds.roundOf(member.notebook);
  const answering = ['reply', 'replies/delete', 'answers/form', 'answers/tick'].includes(action);
  if (round?.closed && !answering) return [409, 'the round has closed', 'roundClosed'] as Refused;
  const who = guests.whoOf(member);
  if (action === 'restore' && round && notebook.pageRow(page, who)!.send_at !== null)
    return [409, 'un-send this round page before restoring a group', 'roundRestore'] as Refused;
  const stillOpen = () => stillSignedIn() && !!guests.pageMember(page, name);
  if (action === 'send') return rounds.handIn(page, who, stillOpen);
  if (action === 'undo') return rounds.takeBack(page, who);
  if (action === 'reply') return sending.replyTo(b, who, stillOpen);
  const actions: Record<string, (b: any, who: string) => unknown> = {
    create: groups.createGroup,
    edit: groups.editGroup,
    delete: groups.deleteGroup,
    restore: groups.restoreGroup,
    move: groups.moveGroup,
    resize: groups.resizeGroup,
    split: groups.splitGroup,
    'pages/title': notebook.titlePage,
    'replies/delete': sending.deleteReply,
    'answers/form': answers.answerForm,
    'answers/tick': answers.tickAnswer,
  };
  const write = actions[action];
  return write ? (write(b, who) ?? { ok: true }) : 404;
}

function actionPage(action: string, b: any) {
  if (action === 'create') return Number(b?.page);
  if (['send', 'undo', 'pages/title'].includes(action)) return Number(b?.id);
  if (['reply', 'answers/form', 'answers/tick'].includes(action)) {
    const group = db
      .prepare(
        `select g.page from notebook_groups g join book_slips s on s.grp = g.id or s.note = g.note where s.id = ? order by g.id limit 1`,
      )
      .get(Number(action === 'reply' ? b?.answer : b?.id)) as { page: number } | undefined;
    return group?.page ?? 0;
  }
  return groups.row(Number(b?.id))?.page ?? 0;
}
function createPage(b: any, name: string) {
  const member = guests.forGuest(name).find(m => m.notebook === Number(b?.notebook));
  if (!member) return 404;
  if (rounds.roundOf(member.notebook)) return [409, 'a round has one page per guest', 'roundPage'] as Refused;
  const id = notebook.newPage(member.notebook);
  db.prepare('update book_pages set who = ? where id = ?').run(guests.whoOf(member), id);
  return notebook.pageOf(notebook.pageRow(id, guests.whoOf(member))!);
}
