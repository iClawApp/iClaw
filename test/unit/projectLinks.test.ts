/**
 * projectLinks.listProjectLinkGroups walks a project's transcripts, extracts
 * URLs and filesystem paths, dedupes them, and groups web vs files.
 *
 * Direct extraction helpers are internal; we drive everything through the
 * public DB-bound function for end-to-end coverage.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetTestDb } from '../helpers/db';
import { chats, messages, projects } from '../../src/services/store';
import { listProjectLinkGroups } from '../../src/services/projectLinks';

beforeAll(() => resetTestDb());
afterEach(() => resetTestDb());

function setupProjectWithMessage(content: string) {
  const p = projects.create('LinksProject');
  const c = chats.create('openclaw/default', p.id);
  messages.append(c.id, 'assistant', content);
  return { projectId: p.id, chatId: c.id };
}

describe('listProjectLinkGroups — web URLs', () => {
  it('picks up raw http(s) URLs', () => {
    const { projectId } = setupProjectWithMessage(
      'Visit https://example.com/docs for the manual.',
    );
    const { web, files } = listProjectLinkGroups(projectId);
    expect(web.map((e) => e.url)).toContain('https://example.com/docs');
    expect(files).toEqual([]);
  });

  it('picks up markdown link targets', () => {
    const { projectId } = setupProjectWithMessage(
      'See [the API docs](https://api.example.com/v2) for endpoints.',
    );
    const { web } = listProjectLinkGroups(projectId);
    expect(web.map((e) => e.url)).toContain('https://api.example.com/v2');
  });

  it('strips trailing punctuation (.,;:!?)', () => {
    const { projectId } = setupProjectWithMessage(
      'Check https://github.com/anthropics/anthropic-sdk-python.',
    );
    const { web } = listProjectLinkGroups(projectId);
    expect(web.map((e) => e.url)).toContain(
      'https://github.com/anthropics/anthropic-sdk-python',
    );
  });

  it('dedupes the same URL across messages and tracks both sources', () => {
    const p = projects.create('DD');
    const a = chats.create('openclaw/default', p.id);
    const b = chats.create('openclaw/default', p.id);
    messages.append(a.id, 'user', 'Found at https://shared.example.com');
    messages.append(b.id, 'user', 'Same link https://shared.example.com here too');
    const { web } = listProjectLinkGroups(p.id);
    const entry = web.find((e) => e.url === 'https://shared.example.com');
    expect(entry).toBeDefined();
    expect(entry!.sources.length).toBe(2);
    expect(entry!.sources.map((s) => s.chatId).sort()).toEqual(
      [a.id, b.id].sort((x, y) => x - y),
    );
  });

  it('multiple URLs in one message all surface', () => {
    const { projectId } = setupProjectWithMessage(
      'See https://a.example.com and https://b.example.com — both are needed.',
    );
    const { web } = listProjectLinkGroups(projectId);
    expect(web.map((e) => e.url).sort()).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });
});

describe('listProjectLinkGroups — files / paths', () => {
  it('picks up absolute unix paths', () => {
    const { projectId } = setupProjectWithMessage(
      'Open /etc/nginx/sites-available/default to edit.',
    );
    const { files } = listProjectLinkGroups(projectId);
    expect(files.map((e) => e.url)).toContain('/etc/nginx/sites-available/default');
  });

  it('picks up file:// URIs', () => {
    const { projectId } = setupProjectWithMessage(
      'Local: file:///Users/me/project/README.md is the entry.',
    );
    const { files } = listProjectLinkGroups(projectId);
    expect(files.some((e) => e.url.startsWith('file://'))).toBe(true);
  });

  it('does NOT confuse URL paths as filesystem paths', () => {
    const { projectId } = setupProjectWithMessage(
      'GitHub: https://github.com/user/repo/blob/main/README.md',
    );
    const { web, files } = listProjectLinkGroups(projectId);
    expect(web.map((e) => e.url)).toContain(
      'https://github.com/user/repo/blob/main/README.md',
    );
    // The URL path "/blob/main/README.md" must NOT leak into files
    expect(files.find((e) => e.url === '/blob/main/README.md')).toBeUndefined();
  });
});

describe('listProjectLinkGroups — sort + dedupe', () => {
  it('returns each unique URL once per kind', () => {
    const p = projects.create('Sort');
    const a = chats.create('openclaw/default', p.id);
    messages.append(a.id, 'user', 'http://a.test http://a.test http://a.test');
    const { web } = listProjectLinkGroups(p.id);
    expect(web.filter((e) => e.url === 'http://a.test')).toHaveLength(1);
  });

  it('empty project → empty groups', () => {
    const p = projects.create('Empty');
    expect(listProjectLinkGroups(p.id)).toEqual({ web: [], files: [] });
  });
});
