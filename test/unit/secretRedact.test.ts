import { describe, expect, it } from 'vitest';
import { resetTestDb } from '../helpers/db';
import { chats, messages, projectSecrets, projects } from '../../src/services/store';
import {
  findSelectionSpanInMessageContent,
  redactSecretValuesForChat,
  redactSelectionInMessageContent,
} from '../../src/services/inlineSecrets';

describe('message secret redact', () => {
  it('finds selection when the browser omits the newline', () => {
    const content = 'prefix sk-test\nsuffix';
    const span = findSelectionSpanInMessageContent(content, 'prefix sk-testsuffix');
    expect(span).toEqual({ start: 0, end: 21 });
  });

  it('rejects spans that overlap an existing placeholder', () => {
    const content = 'before [[iclaw:secret:1|k|3]] after';
    expect(findSelectionSpanInMessageContent(content, 'secret:1')).toBeNull();
    expect(findSelectionSpanInMessageContent(content, '[[iclaw:secret:1|k|3]]')).toBeNull();
  });

  it('redacts and stores a placeholder', () => {
    resetTestDb();
    const p = projects.create('P');
    const c = chats.create('openclaw/default', p.id);
    const m = messages.append(c.id, 'assistant', 'My API key is sk-test-abc123 here.');
    const { content, secretId } = redactSelectionInMessageContent({
      content: m.content,
      selection: 'sk-test-abc123',
      label: 'API key',
      projectId: p.id,
      sourceChatId: c.id,
      sourceMessageId: m.id,
    });
    expect(content).toContain('[[iclaw:secret:' + secretId + '|');
    expect(content).not.toContain('sk-test-abc123');
    const sec = projectSecrets.get(secretId);
    expect(sec?.value).toBe('sk-test-abc123');
    expect(sec?.source_message_id).toBe(m.id);
  });
});

describe('redactSecretValuesForChat', () => {
  it('replaces a project-scoped secret value wherever the model echoed it', () => {
    resetTestDb();
    const p = projects.create('P');
    const c = chats.create('openclaw/default', p.id);
    projectSecrets.insert({ projectId: p.id, label: 'GitHub PR', value: 'ghp_E4I0Hzmuk5buuYDgO6MX' });
    const text = 'curl -H "Authorization: token ghp_E4I0Hzmuk5buuYDgO6MX" https://api.github.com';
    const out = redactSecretValuesForChat(text, c);
    expect(out).not.toContain('ghp_E4I0');
    expect(out).toContain('[secret:GitHub PR]');
  });

  it('does not redact secrets from another project', () => {
    resetTestDb();
    const p1 = projects.create('P1');
    const p2 = projects.create('P2');
    const c = chats.create('openclaw/default', p1.id);
    projectSecrets.insert({ projectId: p2.id, label: 'Other', value: 'sk-other-project-secret' });
    const text = 'value sk-other-project-secret stays';
    expect(redactSecretValuesForChat(text, c)).toBe(text);
  });

  it('catches a clip-truncated prefix of the value (≥16 chars)', () => {
    resetTestDb();
    const p = projects.create('P');
    const c = chats.create('openclaw/default', p.id);
    const full = 'ghp_AsXF' + 'x'.repeat(32); // 40-char PAT
    projectSecrets.insert({ projectId: p.id, label: 'GitHub PR', value: full });
    // The 70-char detail clip cuts the token at 36 chars — exact match misses it.
    const clipped = 'curl -s -H "Authorization: token ' + full.slice(0, 36) + '…';
    const out = redactSecretValuesForChat(clipped, c);
    expect(out).not.toContain('ghp_AsXF');
    expect(out).toContain('[secret:GitHub PR]…');
  });

  it('leaves sub-16-char fragments alone (too collision-prone)', () => {
    resetTestDb();
    const p = projects.create('P');
    const c = chats.create('openclaw/default', p.id);
    projectSecrets.insert({ projectId: p.id, label: 'tok', value: 'ghp_' + 'y'.repeat(36) });
    const text = 'prefix ghp_yyyyyyy only-11-chars';
    expect(redactSecretValuesForChat(text, c)).toBe(text);
  });

  it('skips too-short values and handles chat-local secrets', () => {
    resetTestDb();
    const c = chats.create('openclaw/default', null);
    projectSecrets.insert({ projectId: null, label: 'pin', value: '12345', sourceChatId: c.id });
    projectSecrets.insert({ projectId: null, label: 'tok', value: 'long-enough-token', sourceChatId: c.id });
    const out = redactSecretValuesForChat('pin 12345 tok long-enough-token', c);
    expect(out).toContain('12345'); // < 6 chars — too collision-prone to scrub
    expect(out).toContain('[secret:tok]');
    expect(out).not.toContain('long-enough-token');
  });
});
