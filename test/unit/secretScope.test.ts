import { describe, expect, it } from 'vitest';
import { resetTestDb } from '../helpers/db';
import { chats, projectSecrets, secretUsableInChat } from '../../src/services/store';
import { expandStoredSecretPlaceholdersForGateway } from '../../src/services/inlineSecrets';

describe('secretUsableInChat', () => {
  it('scopes orphan secrets to the chat that owns them', () => {
    resetTestDb();
    const a = chats.create('openclaw/default');
    const b = chats.create('openclaw/default');
    const rowA = projectSecrets.insert({
      projectId: null,
      label: 'key-a',
      value: 'sk-a',
      sourceChatId: a.id,
      sourceMessageId: null,
    });
    projectSecrets.insert({
      projectId: null,
      label: 'key-b',
      value: 'sk-b',
      sourceChatId: b.id,
      sourceMessageId: null,
    });
    const chatA = chats.get(a.id)!;
    const chatB = chats.get(b.id)!;
    expect(secretUsableInChat(rowA, chatA)).toBe(true);
    expect(secretUsableInChat(rowA, chatB)).toBe(false);
  });

  it('does not expand another chat orphan placeholder', () => {
    resetTestDb();
    const a = chats.create('openclaw/default');
    const b = chats.create('openclaw/default');
    const rowB = projectSecrets.insert({
      projectId: null,
      label: 'key',
      value: 'sk-other',
      sourceChatId: b.id,
      sourceMessageId: null,
    });
    const ph = `[[iclaw:secret:${rowB.id}|key|8]]`;
    const chatA = chats.get(a.id)!;
    expect(expandStoredSecretPlaceholdersForGateway(ph, chatA)).toBe(ph);
  });
});
