import { describe, expect, it, beforeEach } from 'vitest';
import {
  buildContextSnapshot,
  formatAgentHumanAsk,
  parsePlanLines,
  parseTaskOutcome,
  stripTaskOutcomeMarkers,
} from '../../src/services/taskRunner';
import {
  chats,
  messages,
  projectFacts,
  projects,
  taskContextSnapshots,
} from '../../src/services/store';
import { resetTestDb } from '../helpers/db';

describe('taskRunner parsers', () => {
  it('parsePlanLines extracts agent and human steps', () => {
    const raw = [
      'agent: Set up repo',
      'human: Approve deploy',
      '1. agent: Run tests',
    ].join('\n');
    const steps = parsePlanLines(raw);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ actor: 'agent', title: 'Set up repo' });
    expect(steps[1]).toEqual({ actor: 'human', title: 'Approve deploy' });
    expect(steps[2]).toEqual({ actor: 'agent', title: 'Run tests' });
  });

  it('parseTaskOutcome detects markers', () => {
    expect(parseTaskOutcome('Done.\nNEEDS_HUMAN: paste API key')).toEqual({
      kind: 'needs_human',
      instruction: 'paste API key',
    });
    expect(parseTaskOutcome('All good\nTASK_DONE')).toEqual({
      kind: 'task_done',
      instruction: undefined,
    });
    expect(parseTaskOutcome('Please review\nNEEDS_REVIEW')).toEqual({
      kind: 'needs_review',
      instruction: undefined,
    });
    expect(parseTaskOutcome('no marker here')).toEqual({ kind: 'none' });
  });

  it('formatAgentHumanAsk splits context and question at NEEDS_HUMAN', () => {
    const raw = [
      'Текстовий список зафіксований.',
      'NEEDS_HUMAN',
      '"Усі на 20k" — глянь чи вже розгорнуто.',
    ].join('\n');
    expect(formatAgentHumanAsk(raw)).toEqual({
      preamble: 'Текстовий список зафіксований.',
      question: '"Усі на 20k" — глянь чи вже розгорнуто.',
    });
  });

  it('stripTaskOutcomeMarkers removes protocol lines', () => {
    expect(stripTaskOutcomeMarkers('Hello\nNEEDS_HUMAN\nWorld')).toBe('Hello\nWorld');
  });
});

describe('buildContextSnapshot', () => {
  beforeEach(() => {
    resetTestDb();
  });

  it('freezes chat messages and project facts', () => {
    const project = projects.create('P');
    const chat = chats.create('openclaw/default', project.id);
    messages.append(chat.id, 'user', 'hello', null);
    projectFacts.append({
      projectId: project.id,
      content: 'Uses Node 20',
      sourceChatId: chat.id,
    });

    const payload = buildContextSnapshot(chat.id);
    expect(payload.sourceChatId).toBe(chat.id);
    expect(payload.projectId).toBe(project.id);
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0].content).toBe('hello');
    expect(payload.projectFacts).toContain('Uses Node 20');

    const snap = taskContextSnapshots.create({
      projectId: project.id,
      sourceChatId: chat.id,
      payload,
    });
    const roundTrip = taskContextSnapshots.parsePayload(snap);
    expect(roundTrip.messages[0].content).toBe('hello');
  });
});
