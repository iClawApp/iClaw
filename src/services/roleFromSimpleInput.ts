import type { CreateTemplateInput } from './catalog';

function deriveTagline(title: string, promptTemplate: string): string {
  const firstLine = promptTemplate.trim().split(/\n/)[0]?.trim() ?? '';
  const source = firstLine || title.trim();
  return source.length > 240 ? `${source.slice(0, 237)}…` : source;
}

export function buildRoleFromInput(fields: {
  title: string;
  promptTemplate: string;
  category?: string;
}): CreateTemplateInput {
  const title = fields.title.trim();
  const promptTemplate = fields.promptTemplate.trim();
  return {
    title,
    tagline: deriveTagline(title, promptTemplate),
    promptTemplate,
    category: fields.category?.trim() || 'Other',
    forWhom: 'For you',
    agentId: 'openclaw/default',
    ask: [],
  };
}
