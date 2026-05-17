import { afterEach, describe, expect, it } from 'vitest';
import { db, resetTestDb } from '../helpers/db';
import {
  projects,
  projectFacts,
  projectFactSuggestions,
  chats,
  enrichFactWithSourceChatTitle,
  enrichFactsWithSourceChatTitles,
} from '../../src/services/store';

afterEach(() => resetTestDb());

describe('store.projects', () => {
  it('create() trims name and falls back to "Untitled"', () => {
    const p1 = projects.create('  My Project  ');
    expect(p1.name).toBe('My Project');
    const p2 = projects.create('');
    expect(p2.name).toBe('Untitled');
  });

  it('rename() and setDescription() update + bump updated_at', () => {
    const p = projects.create('Old Name');
    db.prepare("UPDATE projects SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(p.id);
    projects.rename(p.id, 'New Name');
    const after = projects.get(p.id)!;
    expect(after.name).toBe('New Name');
    expect(after.updated_at > '2020-01-01 00:00:00').toBe(true);

    projects.setDescription(p.id, 'A short description.');
    expect(projects.get(p.id)!.description).toBe('A short description.');
    projects.setDescription(p.id, null);
    expect(projects.get(p.id)!.description).toBeNull();
  });

  it('remove() cascades facts but detaches chats (ON DELETE SET NULL)', () => {
    const p = projects.create('Cascade Project');
    const c = chats.create('openclaw/default', p.id);
    const f = projectFacts.append({ projectId: p.id, content: 'a fact' });
    projects.remove(p.id);
    expect(projects.get(p.id)).toBeUndefined();
    expect(projectFacts.get(f.id)).toBeUndefined();   // cascaded
    const detached = chats.get(c.id);
    expect(detached?.project_id).toBeNull();          // SET NULL
  });

  it('setLogoAppearance clamps emoji + color indices to valid ranges', () => {
    const p = projects.create('LP');
    projects.setLogoAppearance(p.id, { emoji: 999, color: -5 });
    const after = projects.get(p.id)!;
    expect(Number.isInteger(after.logo_emoji)).toBe(true);
    expect(Number.isInteger(after.logo_color)).toBe(true);
    expect(after.logo_emoji).toBeGreaterThanOrEqual(0);
    expect(after.logo_color).toBeGreaterThanOrEqual(0);
  });
});

describe('store.projectFacts', () => {
  it('append() persists fact + bumps owning project updated_at', () => {
    const p = projects.create('P');
    db.prepare("UPDATE projects SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(p.id);
    const f = projectFacts.append({
      projectId: p.id,
      content: '  trimmed content  ',
      sourceChatId: null,
      sourceMessageId: null,
    });
    expect(f.content).toBe('trimmed content');
    expect(projects.get(p.id)!.updated_at > '2020-01-01 00:00:00').toBe(true);
  });

  it('append() with empty content throws', () => {
    const p = projects.create('P');
    expect(() => projectFacts.append({ projectId: p.id, content: '   ' })).toThrow(/required/);
  });

  it('listByProject + countByProject reflect insertion order', () => {
    const p = projects.create('P');
    projectFacts.append({ projectId: p.id, content: 'fact A' });
    projectFacts.append({ projectId: p.id, content: 'fact B' });
    projectFacts.append({ projectId: p.id, content: 'fact C' });
    expect(projectFacts.countByProject(p.id)).toBe(3);
    expect(projectFacts.listByProject(p.id).map((f) => f.content)).toEqual([
      'fact A',
      'fact B',
      'fact C',
    ]);
  });

  it('edit() updates content + project updated_at', () => {
    const p = projects.create('P');
    const f = projectFacts.append({ projectId: p.id, content: 'original' });
    db.prepare("UPDATE projects SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(p.id);
    projectFacts.edit(f.id, 'edited');
    expect(projectFacts.get(f.id)!.content).toBe('edited');
    expect(projects.get(p.id)!.updated_at > '2020-01-01 00:00:00').toBe(true);
  });

  it('remove() drops a fact and touches the parent project', () => {
    const p = projects.create('P');
    const f = projectFacts.append({ projectId: p.id, content: 'gone soon' });
    projectFacts.remove(f.id);
    expect(projectFacts.get(f.id)).toBeUndefined();
  });

  it('replaceAll() atomically swaps the fact set for one project', () => {
    const p1 = projects.create('P1');
    const p2 = projects.create('P2');
    projectFacts.append({ projectId: p1.id, content: 'p1-A' });
    projectFacts.append({ projectId: p1.id, content: 'p1-B' });
    projectFacts.append({ projectId: p2.id, content: 'p2-A' });
    projectFacts.replaceAll(p1.id, ['merged-1', 'merged-2']);
    expect(projectFacts.listByProject(p1.id).map((f) => f.content)).toEqual([
      'merged-1',
      'merged-2',
    ]);
    // Other project untouched
    expect(projectFacts.listByProject(p2.id).map((f) => f.content)).toEqual(['p2-A']);
  });

  it('enrichFactWithSourceChatTitle pulls title from chats', () => {
    const p = projects.create('P');
    const c = chats.create('openclaw/default', p.id);
    chats.rename(c.id, 'Source chat', { manual: true });
    const f = projectFacts.append({
      projectId: p.id,
      content: 'derived from chat',
      sourceChatId: c.id,
    });
    const enriched = enrichFactWithSourceChatTitle(f);
    expect(enriched.source_chat_title).toBe('Source chat');
  });

  it('enrichFactsWithSourceChatTitles maps an array', () => {
    const p = projects.create('P');
    const c = chats.create('openclaw/default', p.id);
    chats.rename(c.id, 'C1', { manual: true });
    const a = projectFacts.append({ projectId: p.id, content: 'a', sourceChatId: c.id });
    const b = projectFacts.append({ projectId: p.id, content: 'b', sourceChatId: null });
    const enriched = enrichFactsWithSourceChatTitles([a, b]);
    expect(enriched[0].source_chat_title).toBe('C1');
    expect(enriched[1].source_chat_title).toBeUndefined();
  });
});

describe('store.projectFactSuggestions', () => {
  it('insert + listByChat + remove flow', () => {
    const p = projects.create('P');
    const c = chats.create('openclaw/default', p.id);
    const s = projectFactSuggestions.insert({
      projectId: p.id,
      chatId: c.id,
      content: 'suggested fact',
      assistantMessageId: null,
    });
    expect(s.id).toBeGreaterThan(0);
    expect(projectFactSuggestions.listByChat(c.id).map((x) => x.id)).toEqual([s.id]);
    projectFactSuggestions.remove(s.id);
    expect(projectFactSuggestions.listByChat(c.id)).toEqual([]);
  });

  it('insert() trims content and throws on blank', () => {
    const p = projects.create('P');
    const c = chats.create('openclaw/default', p.id);
    const s = projectFactSuggestions.insert({
      projectId: p.id,
      chatId: c.id,
      content: '  trim me  ',
      assistantMessageId: null,
    });
    expect(s.content).toBe('trim me');
    expect(() =>
      projectFactSuggestions.insert({
        projectId: p.id,
        chatId: c.id,
        content: '   ',
        assistantMessageId: null,
      }),
    ).toThrow(/required/);
  });

  it('cascade: deleting the chat drops its suggestions', () => {
    const p = projects.create('P');
    const c = chats.create('openclaw/default', p.id);
    projectFactSuggestions.insert({
      projectId: p.id,
      chatId: c.id,
      content: 'doomed',
      assistantMessageId: null,
    });
    chats.remove(c.id);
    expect(projectFactSuggestions.listByChat(c.id)).toEqual([]);
  });
});
