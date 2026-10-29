// A small, fully specified job its queuer puts on a lighter model (hq job --model), in the briefing's words: the
// queuer's line on choosing it, the light run's on handing the work up (hq up), and the run after a hand-up's. The
// coordinator's jobs.ts claimed says which apply (company.lighter, lighter, handedUp).
type Choice = { id: string; name: string };
type Light = { name: string; own: string };

// The queuer's line on a hand-off's model, when the company has a lighter one: its flag word is its name's first word
// (the coordinator's models.ts lighterChoice takes it).
export const lighterLine = (job: { company: { lighter?: Choice[] } }) => {
  const choices = job.company.lighter ?? [];
  const flags = choices.map(c => `\`--model ${c.name.split(/\s+/)[0].toLowerCase()}\``).join(' or ');
  return choices.length === 0
    ? ''
    : `
  Judge a hand-off's model from its scope too: a small, fully specified change (a sentence or label the brief quotes, a
  colour value, a margin or spacing it points at, a setting or count) goes ${flags}; diagnosis, design or judgment,
  a bug whose cause isn't known, changes across several parts, creative work (pictures, new copy, sound, films), market
  research and running the company stay on the default.`;
};

// A run on the lighter model its queuer chose, and how it hands the work up (the coordinator's jobs.ts handUp)
export const lightLines = (job: { lighter?: Light }) =>
  !job.lighter
    ? ''
    : `

This job runs on ${job.lighter.name}, a lighter model: its queuer judged it a small, fully specified change. If it turns
out bigger than it looked (the cause isn't where the brief says, it reaches many files, it needs design judgment, checks
fail for reasons you can't pin down), don't force it: while your context is warm, write what you found and did so far in
a short note, run \`hq up "<the note>"\` and end your turn. The same job goes on at once on ${job.lighter.own}, on this
branch and clone, with your note; this run opens no pull request.`;

// The run after a hand-up: a new session (the lighter model's can't go on on another) in the same clone, with its note
export const handedUpLines = ({ from, note }: { from: string; note: string }) =>
  `This job ran first on ${from} as a small job, and that run found it bigger than it looked and handed it up to you. ` +
  'This is a new session in the same clone: its work so far is in it (git log, git status), to build on or undo as you ' +
  `judge. Its note:\n\n${note}`;
