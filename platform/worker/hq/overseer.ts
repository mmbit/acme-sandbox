// The CEO's notes to the Overseer (the coordinator's overseer.ts), which HQ refuses from anyone else.
//
import * as api from './api.ts';
import { isReadable, readWords } from './files.ts';
import { minute, print, stop } from './output.ts';

export const overseer = {
  help: `
   hq overseer <file> | -                            the CEO only, from a run without team members: a note to the Overseer (the
                                                     board's Claude Code that merges the foundation in), let out to it
                                                     when the run ends; refused for anyone else
   hq overseer                                       the notes sent, newest first`,

  async run([file, ...rest]: string[]) {
    if (file === undefined) return listNotes();
    if (rest.length > 0 || (file !== '-' && !isReadable(file)))
      stop('usage: hq overseer <file> | - (the note on stdin)');
    const sent = await api.createOnce('overseer', api.withSpeaker({ text: readWords(file) }));
    if (!sent.made) {
      if (sent.refused) stop(`Not sent: ${sent.error || sent.failure || 'HQ refused it'}.`);
      stop("HQ didn't confirm the note. It may already be kept: check hq overseer before sending it again.", 3);
    }
    print(
      `Note #${sent.answer.id} is held: HQ lets it out to the Overseer when this run ends, if it started no team members.`,
    );
  },
};

type Note = { id: number; at: string; job: number; text: string; held: boolean };

async function listNotes() {
  const { notes } = (await api.orStop(api.getJson('overseer'), "Couldn't list the notes.")) as { notes: Note[] };
  if (notes.length === 0) return print('No notes to the Overseer yet.');
  for (const note of notes)
    print(
      `#${note.id}, ${minute(note.at)}, job #${note.job}${note.held ? ' (held till its run ends)' : ''}: ${note.text.split('\n')[0]}`,
    );
}
