import { describe, expect, it } from 'vitest';
import { resetTestDb } from '../helpers/db';
import { chats, projectSecrets, projects } from '../../src/services/store';
import { resolveInlineSecretMarkersInContent } from '../../src/services/inlineSecrets';

describe('secret label uniqueness', () => {
  it('rejects duplicate labels (case-insensitive)', () => {
    resetTestDb();
    const p = projects.create('P');
    const c = chats.create('openclaw/default', p.id);
    projectSecrets.insert({
      projectId: p.id,
      label: 'OpenAI API key',
      value: 'sk-one',
      sourceChatId: c.id,
      sourceMessageId: null,
    });
    expect(() =>
      projectSecrets.insert({
        projectId: p.id,
        label: 'openai api key',
        value: 'sk-two',
        sourceChatId: c.id,
        sourceMessageId: null,
      }),
    ).toThrow('Secret name already exists');
  });

  it('rejects the same label in another project', () => {
    resetTestDb();
    const p1 = projects.create('P1');
    const p2 = projects.create('P2');
    const c1 = chats.create('openclaw/default', p1.id);
    const c2 = chats.create('openclaw/default', p2.id);
    projectSecrets.insert({
      projectId: p1.id,
      label: 'Deploy token',
      value: 'tok-a',
      sourceChatId: c1.id,
      sourceMessageId: null,
    });
    expect(() =>
      projectSecrets.insert({
        projectId: p2.id,
        label: 'Deploy token',
        value: 'tok-b',
        sourceChatId: c2.id,
        sourceMessageId: null,
      }),
    ).toThrow('Secret name already exists');
  });

  it('allows resolveForChat copy when the label exists in another project', () => {
    resetTestDb();
    const p1 = projects.create('P1');
    const p2 = projects.create('P2');
    const c1 = chats.create('openclaw/default', p1.id);
    const c2 = chats.create('openclaw/default', p2.id);
    const foreign = projectSecrets.insert({
      projectId: p2.id,
      label: 'Shared name',
      value: 'sk-shared',
      sourceChatId: c2.id,
      sourceMessageId: null,
    });
    const local = projectSecrets.resolveForChat(
      { chatId: c1.id, projectId: p1.id },
      foreign.id,
    );
    expect(local.project_id).toBe(p1.id);
    expect(local.label).toBe('Shared name');
  });

  it('blocks inline secret markers when the label is taken', () => {
    resetTestDb();
    const p = projects.create('P');
    const c = chats.create('openclaw/default', p.id);
    projectSecrets.insert({
      projectId: p.id,
      label: 'Deploy token',
      value: 'tok-a',
      sourceChatId: c.id,
      sourceMessageId: null,
    });
    expect(() =>
      resolveInlineSecretMarkersInContent({
        content: 'use [[iclaw:s0]]',
        inlineSecrets: [{ slot: 0, label: 'deploy token', plain: 'tok-b' }],
        projectId: p.id,
        sourceChatId: c.id,
      }),
    ).toThrow('Secret name already exists');
  });
});
