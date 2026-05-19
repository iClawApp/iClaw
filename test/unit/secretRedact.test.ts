import { describe, expect, it } from 'vitest';
import { resetTestDb } from '../helpers/db';
import { chats, messages, projectSecrets, projects } from '../../src/services/store';
import {
  findSelectionSpanInMessageContent,
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
