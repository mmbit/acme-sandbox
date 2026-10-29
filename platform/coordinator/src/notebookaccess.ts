// Managed guest pages use their notebook's access lifetime, separate from ordinary guest sketches.
import { db } from './db.ts';
import './notebook.ts'; // (book_pages.notebook, joined below)
db.exec(`create table if not exists notebook_guests (id integer primary key autoincrement, notebook integer not null,
  guest text not null collate nocase, grant_id integer not null, page integer not null, link text not null,
  ends text, revoked text, invited_by text, unique(notebook, guest));
  create index if not exists notebook_guests_link on notebook_guests(link);
  create table if not exists notebook_colleagues (notebook integer primary key, allowed integer not null)`);
export const managedNotebook = (id: number) => !!db.prepare('select 1 from notebook_guests where notebook = ?').get(id);
export const managedPage = (id: number) =>
  !!db.prepare('select 1 from book_pages p join notebook_guests g on g.notebook = p.notebook where p.id = ?').get(id);
