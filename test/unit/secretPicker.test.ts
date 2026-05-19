import { describe, expect, it } from 'vitest';
import { resetTestDb } from '../helpers/db';
import { chats, projectSecrets, projects } from '../../src/services/store';

describe('composer secret picker', () => {
  it('lists Other for secrets in another project', () => {
    resetTestDb();
    const p1 = projects.create('P1');
    const p2 = projects.create('P2');
    const c1 = chats.create('openclaw/default', p1.id);
    const c2 = chats.create('openclaw/default', p2.id);
    projectSecrets.insert({
      projectId: p1.id,
      label: 'a',
      value: 'sk-a',
      sourceChatId: c1.id,
      sourceMessageId: null,
    });
    projectSecrets.insert({
      projectId: p2.id,
      label: 'b',
      value: 'sk-b',
      sourceChatId: c2.id,
      sourceMessageId: null,
    });
    const list = projectSecrets.listForComposerPickerInProjectChat(c1.id, p1.id);
    const labels = list.sections.map((s) => s.label);
    expect(labels).toContain('Other');
    const other = list.sections.find((s) => s.label === 'Other');
    expect(other?.items.some((i) => i.label === 'b')).toBe(true);
  });

  it('omits Other when the same value is already in this project', () => {
    resetTestDb();
    const p1 = projects.create('P1');
    const p2 = projects.create('P2');
    const c1 = chats.create('openclaw/default', p1.id);
    const c2 = chats.create('openclaw/default', p2.id);
    const shared = 'sk-shared-key';
    projectSecrets.insert({
      projectId: p1.id,
      label: 'mine',
      value: shared,
      sourceChatId: c1.id,
      sourceMessageId: null,
    });
    projectSecrets.insert({
      projectId: p2.id,
      label: 'theirs',
      value: shared,
      sourceChatId: c2.id,
      sourceMessageId: null,
    });
    const list = projectSecrets.listForComposerPickerInProjectChat(c1.id, p1.id);
    expect(list.sections.find((s) => s.label === 'Other')).toBeUndefined();
  });
});
