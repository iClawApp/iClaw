import { describe, expect, it } from 'vitest';
import { substitutePrompt, type TemplateManifest } from '../../src/services/catalog';

const smmManifest: TemplateManifest = {
  id: 'smm-specialist',
  title: 'AI SMM',
  tagline: '',
  category: 'Marketing',
  icon: '📱',
  forWhom: '',
  search: [],
  agentId: 'openclaw/default',
  ask: [
    { key: 'platform', label: 'Platform', type: 'select', options: ['Instagram'] },
    { key: 'count', label: 'Count', type: 'select', options: ['5'] },
    { key: 'tone', label: 'Tone', type: 'select', options: ['Дружній'] },
  ],
  promptTemplate:
    'Platform: {{platform}}. Count: {{count}}. Tone: {{tone}}. Extra: {{evil}}.',
};

describe('substitutePrompt', () => {
  it('replaces only keys declared in ask', () => {
    const out = substitutePrompt(smmManifest, {
      platform: 'Instagram',
      count: '5',
      tone: 'Дружній',
      evil: 'DROP TABLE',
    });
    expect(out).toContain('Platform: Instagram');
    expect(out).toContain('Count: 5');
    expect(out).toContain('Tone: Дружній');
    expect(out).toContain('Extra: {{evil}}');
    expect(out).not.toContain('DROP TABLE');
  });

  it('uses empty string for missing answers', () => {
    const out = substitutePrompt(smmManifest, { platform: 'TikTok' });
    expect(out).toContain('Platform: TikTok');
    expect(out).toContain('Count: .');
    expect(out).toContain('Tone: .');
  });
});
