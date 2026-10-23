// What a job's briefing asks it to do before it stops.
// A review's fix job (stage 'fix': review notes, a merge with main, files the review sent back) changes only what it was
// sent back for, and the check after it reads only that, so it leaves the profile alone. Its summary stays in the
// agent's history (hq history). A profile line there made the merge check rule "changes" and cost a round.
// A job in a thread of a project its agent owns (the coordinator's ownsProject) also keeps the project's sentence true:
// the one line the board reads on where it stands and what's next.
export type OwnedProject = { id: string; name: string; sentence: string | null };
export const closing = (job: { stage?: string | null; ownsProject?: OwnedProject }) => job.stage === 'fix'
  ? '- Before you stop: this job fixes only what it was sent back for, so leave your profile as it is. End with a 1–3 line ' +
    'summary, with anything worth remembering in it: your history keeps it (`hq history`).'
  : `- Before you stop: update your profile's track record and working memory, and end with a 1–3 line summary.${projectStep(job.ownsProject)}`;

const projectStep = (project?: OwnedProject) => !project ? '' : project.sentence
  ? `\n  ${project.name} is yours, and its sentence for the board reads: "${project.sentence}" If that's no longer true ` +
    `after this job, write the new one: \`hq project say ${project.id} "..."\`.`
  : `\n  ${project.name} is yours and has no sentence for the board yet: write one on where it stands and what's next ` +
    `(\`hq project say ${project.id} "..."\`).`;
