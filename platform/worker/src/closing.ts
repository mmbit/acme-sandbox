// What a job's briefing asks it to do before it stops.
// A review's fix job (stage 'fix': review notes, a merge with main, files the review sent back) changes only what it was
// sent back for, and the check after it reads only that, so it leaves the profile alone. Its summary stays in the
// agent's history (hq history). A profile line there made the merge check rule "changes" and cost a round.
// A job that changed nothing (a sort, a judgment, findings already fixed) leaves it alone too: every later job of the
// agent reads the profile whole, so a line with nothing to learn from costs each of them.
// A job in a thread of a project its agent owns (the coordinator's ownsProject) also keeps the project's sentence true:
// the one line the board reads on where it stands and what's next.
// Working memory is rewritten to what's true now, never only added to, so an old belief doesn't outlive the change that
// ended it. The CEO's memory is its page (a run with `page`, the coordinator's pad.ts): its profile keeps who it is and
// its track record.
export type OwnedProject = { id: string; name: string; sentence: string | null };
export const closing = (job: { stage?: string | null; ownsProject?: OwnedProject; page?: string }) =>
  job.stage === 'fix'
    ? '- Before you stop: this job fixes only what it was sent back for, so leave your profile as it is. End with a 1–3 line ' +
      'summary, with anything worth remembering in it: your history keeps it (`hq history`).'
    : `- Before you stop: ${memoryStep(job.page)}, and end with a 1–3 line summary. A job ` +
      `that changed nothing (a sort, a judgment, findings already fixed) leaves the profile as it is: anything worth ` +
      `remembering goes in its summary, which your history keeps (\`hq history\`).${projectStep(job.ownsProject)}`;

const memoryStep = (page?: string) =>
  page
    ? "update your profile's track record (your lessons go on your page, never in the profile)"
    : "update your profile's track record, and rewrite its working memory to what's true now (change or remove what " +
      'no longer holds, rather than only adding)';

const projectStep = (project?: OwnedProject) =>
  !project
    ? ''
    : project.sentence
      ? `\n  ${project.name} is yours, and its sentence for the board reads: "${project.sentence}" If that's no longer true ` +
        `after this job, write the new one: \`hq project say ${project.id} "..."\`.`
      : `\n  ${project.name} is yours and has no sentence for the board yet: write one on where it stands and what's next ` +
        `(\`hq project say ${project.id} "..."\`).`;
