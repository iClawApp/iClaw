import { describe, expect, it } from 'vitest';
import { buildRoleFromInput } from '../../src/services/roleFromSimpleInput';

describe('buildRoleFromInput', () => {
  it('builds manifest with default agent', () => {
    const out = buildRoleFromInput({
      title: 'API Sales',
      promptTemplate: 'Use HubSpot API. You are a sales assistant.',
      category: 'Sales',
    });
    expect(out.title).toBe('API Sales');
    expect(out.tagline).toBe('Use HubSpot API. You are a sales assistant.');
    expect(out.promptTemplate).toContain('HubSpot API');
    expect(out.agentId).toBe('openclaw/default');
    expect(out.category).toBe('Sales');
  });
});
