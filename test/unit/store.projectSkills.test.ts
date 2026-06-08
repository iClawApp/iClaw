import { afterEach, describe, expect, it } from 'vitest';
import { resetTestDb } from '../helpers/db';
import {
  projects,
  projectSkills,
  projectSkillSuggestions,
  chats,
  enrichSkillWithSourceChatTitle,
} from '../../src/services/store';
import {
  extractJsonObject,
  parseReviewedSkills,
} from '../../src/services/projectSkills';

afterEach(() => resetTestDb());

describe('store.projectSkills', () => {
  it('create() persists a project skill and serializes tags', () => {
    const p = projects.create('P');
    const s = projectSkills.create({
      projectId: p.id,
      name: 'deploy-flow',
      description: 'How to deploy the service',
      body: '# Deploy\nSteps...',
      tags: ['ops', 'deploy'],
    });
    expect(s.name).toBe('deploy-flow');
    expect(s.project_id).toBe(p.id);
    expect(s.version).toBe(1);
    expect(JSON.parse(s.tags!)).toEqual(['ops', 'deploy']);
  });

  it('create() supports global skills (project_id null) and listForProject merges them', () => {
    const p = projects.create('P');
    projectSkills.create({ projectId: p.id, name: 'local-skill', description: 'd', body: 'b' });
    projectSkills.create({ projectId: null, name: 'global-skill', description: 'd', body: 'b' });
    const forProject = projectSkills.listForProject(p.id);
    const names = forProject.map((s) => s.name).sort();
    expect(names).toEqual(['global-skill', 'local-skill']);
    expect(projectSkills.listGlobal().map((s) => s.name)).toEqual(['global-skill']);
  });

  it('getByName() distinguishes project scope from global scope', () => {
    const p = projects.create('P');
    projectSkills.create({ projectId: p.id, name: 'dup', description: 'proj', body: 'b' });
    projectSkills.create({ projectId: null, name: 'dup', description: 'glob', body: 'b' });
    expect(projectSkills.getByName(p.id, 'dup')?.description).toBe('proj');
    expect(projectSkills.getByName(null, 'dup')?.description).toBe('glob');
  });

  it('update() bumps version + updated_at and can rewrite tags', () => {
    const p = projects.create('P');
    const s = projectSkills.create({ projectId: p.id, name: 'n', description: 'd', body: 'b' });
    projectSkills.update(s.id, { description: 'd2', body: 'b2', tags: ['x'] });
    const after = projectSkills.get(s.id)!;
    expect(after.version).toBe(2);
    expect(after.description).toBe('d2');
    expect(after.body).toBe('b2');
    expect(JSON.parse(after.tags!)).toEqual(['x']);
  });

  it('listIndex() returns id/name/description only', () => {
    const p = projects.create('P');
    projectSkills.create({ projectId: p.id, name: 'n', description: 'summary', body: 'long body' });
    const idx = projectSkills.listIndex(p.id);
    expect(idx).toHaveLength(1);
    expect(idx[0]).toMatchObject({ name: 'n', description: 'summary' });
    expect(idx[0]).not.toHaveProperty('body');
  });

  it('remove() deletes the skill; project removal cascades skills', () => {
    const p = projects.create('P');
    const s = projectSkills.create({ projectId: p.id, name: 'n', description: 'd', body: 'b' });
    projectSkills.remove(s.id);
    expect(projectSkills.get(s.id)).toBeUndefined();

    const p2 = projects.create('P2');
    projectSkills.create({ projectId: p2.id, name: 'n', description: 'd', body: 'b' });
    projects.remove(p2.id);
    expect(projectSkills.listByProject(p2.id)).toHaveLength(0);
  });

  it('enrichSkillWithSourceChatTitle pulls the source chat title', () => {
    const p = projects.create('P');
    const c = chats.create('openclaw/default', p.id);
    chats.rename(c.id, 'My Chat');
    const s = projectSkills.create({
      projectId: p.id,
      name: 'n',
      description: 'd',
      body: 'b',
      sourceChatId: c.id,
    });
    expect(enrichSkillWithSourceChatTitle(s).source_chat_title).toBe('My Chat');
  });
});

describe('store.projectSkillSuggestions', () => {
  it('insert() persists a suggestion with kind + untrusted flag', () => {
    const p = projects.create('P');
    const c = chats.create('openclaw/default', p.id);
    const sug = projectSkillSuggestions.insert({
      projectId: p.id,
      chatId: c.id,
      kind: 'new',
      name: 'n',
      description: 'd',
      body: 'b',
      untrusted: true,
      assistantMessageId: null,
    });
    expect(sug.kind).toBe('new');
    expect(sug.untrusted).toBe(1);
    expect(projectSkillSuggestions.listByChat(c.id)).toHaveLength(1);
    expect(projectSkillSuggestions.listByProject(p.id)).toHaveLength(1);
    projectSkillSuggestions.remove(sug.id);
    expect(projectSkillSuggestions.get(sug.id)).toBeUndefined();
  });
});

describe('projectSkills reviewer parsing', () => {
  it('extractJsonObject pulls a balanced object from fenced output', () => {
    const raw = 'Sure!\n```json\n{"skills":[{"name":"a"}]}\n```\nDone';
    expect(extractJsonObject(raw)).toBe('{"skills":[{"name":"a"}]}');
  });

  it('extractJsonObject returns null for NONE / no object', () => {
    expect(extractJsonObject('NONE')).toBeNull();
    expect(extractJsonObject('no json here')).toBeNull();
  });

  it('parseReviewedSkills accepts well-formed skills and kebab-cases names', () => {
    const raw = JSON.stringify({
      skills: [
        {
          action: 'new',
          name: 'Deploy Flow',
          description: 'How to deploy',
          tags: ['ops'],
          body: '# Deploy\nstep',
        },
      ],
    });
    const out = parseReviewedSkills(raw);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('deploy-flow');
    expect(out[0].action).toBe('new');
    expect(out[0].tags).toEqual(['ops']);
  });

  it('parseReviewedSkills drops entries missing name/description/body', () => {
    const raw = JSON.stringify({
      skills: [
        { action: 'new', name: 'ok', description: '', body: 'b' },
        { action: 'new', name: 'good', description: 'd', body: 'b' },
      ],
    });
    const out = parseReviewedSkills(raw);
    expect(out.map((s) => s.name)).toEqual(['good']);
  });

  it('parseReviewedSkills returns [] for empty skills array', () => {
    expect(parseReviewedSkills('{"skills":[]}')).toEqual([]);
  });

  it('parseReviewedSkills keeps patch action + target', () => {
    const raw = JSON.stringify({
      skills: [{ action: 'patch', target: 'Existing Skill', name: 'existing-skill', description: 'd', body: 'b' }],
    });
    const out = parseReviewedSkills(raw);
    expect(out[0].action).toBe('patch');
    expect(out[0].target).toBe('existing-skill');
  });
});
