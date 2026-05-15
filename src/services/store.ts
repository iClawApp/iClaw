import { randomUUID } from 'node:crypto';
import { db } from '../db/database';
import type { Project, Task, Note, Message } from '../types';

export const projects = {
  list(): Project[] {
    return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Project[];
  },
  get(id: number): Project | undefined {
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
  },
  create(name: string, description: string | null): Project {
    const info = db
      .prepare('INSERT INTO projects (name, description) VALUES (?, ?)')
      .run(name, description);
    return this.get(Number(info.lastInsertRowid))!;
  },
  remove(id: number): void {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  },
};

export const tasks = {
  listByProject(projectId: number): Task[] {
    return db
      .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as Task[];
  },
  get(id: number): Task | undefined {
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
  },
  create(projectId: number, title: string): Task {
    const info = db
      .prepare('INSERT INTO tasks (project_id, title) VALUES (?, ?)')
      .run(projectId, title);
    return this.get(Number(info.lastInsertRowid))!;
  },
  setStatus(id: number, status: string): void {
    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id);
  },
  remove(id: number): void {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  },
  startChat(id: number, agent: string): Task {
    const sessionKey = randomUUID();
    db.prepare(
      'UPDATE tasks SET openclaw_session_id = ?, agent = ? WHERE id = ?',
    ).run(sessionKey, agent, id);
    return this.get(id)!;
  },
};

export const notes = {
  listByTask(taskId: number): Note[] {
    return db
      .prepare('SELECT * FROM notes WHERE task_id = ? ORDER BY pinned DESC, created_at DESC')
      .all(taskId) as Note[];
  },
  create(taskId: number, body: string, pinned = true): Note {
    const info = db
      .prepare('INSERT INTO notes (task_id, body, pinned) VALUES (?, ?, ?)')
      .run(taskId, body, pinned ? 1 : 0);
    return db.prepare('SELECT * FROM notes WHERE id = ?').get(info.lastInsertRowid) as Note;
  },
  remove(id: number): void {
    db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  },
  togglePin(id: number): void {
    db.prepare('UPDATE notes SET pinned = 1 - pinned WHERE id = ?').run(id);
  },
};

export const messages = {
  listByTask(taskId: number): Message[] {
    return db
      .prepare('SELECT * FROM messages WHERE task_id = ? ORDER BY id ASC')
      .all(taskId) as Message[];
  },
  append(taskId: number, role: string, content: string, finishReason: string | null = null): Message {
    const info = db
      .prepare('INSERT INTO messages (task_id, role, content, finish_reason) VALUES (?, ?, ?, ?)')
      .run(taskId, role, content, finishReason);
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid) as Message;
  },
};
