import { describe, expect, it } from 'vitest';
import {
  CHARACTERS,
  DEFAULT_CHARACTER_ID,
  applyCharacterPrompt,
  buildCharacterPromptBlock,
  buildCharacterSystemPrompt,
  characterToolAllowlist,
  getCharacter,
  isKnownCharacter,
  resolveCharacterPanels,
  PANEL_REGISTRY,
} from '../../src/services/characters';

describe('characters', () => {
  it('exposes a generalist default with no persona injection', () => {
    expect(DEFAULT_CHARACTER_ID).toBe('generalist');
    const gen = getCharacter('generalist');
    expect(gen.persona).toBe('');
    expect(buildCharacterPromptBlock('generalist')).toBeNull();
  });

  it('falls back to the generalist for null / unknown ids', () => {
    expect(getCharacter(null).id).toBe('generalist');
    expect(getCharacter('nope').id).toBe('generalist');
    expect(isKnownCharacter('nope')).toBe(false);
    expect(isKnownCharacter('researcher')).toBe(true);
  });

  it('builds a persona block (gateway bracket framing) for the character', () => {
    const block = buildCharacterPromptBlock('researcher');
    expect(block).toContain('[Character —');
    expect(block).toContain('You are Remi');
    expect(block).toContain("the user's message follows");
  });

  it('builds a runtime system prompt for a real character, null for generalist', () => {
    expect(buildCharacterSystemPrompt('generalist')).toBeNull();
    const sys = buildCharacterSystemPrompt('researcher');
    expect(sys).toContain('You are Remi');
    // System prompt is plain (no gateway bracket framing).
    expect(sys).not.toContain('[Character');
    // The specialist's method playbook is injected, incl. the tool-selection
    // guidance (which research tool fits which job) + the triangulation method.
    expect(sys).toContain('How you work:');
    expect(sys).toContain('web_search');
    expect(sys).toContain('triangulate at least two independent sources');
  });

  it('prepends the persona only for non-generalist characters', () => {
    const msg = 'hello';
    expect(applyCharacterPrompt(msg, 'generalist')).toBe(msg);
    const withPersona = applyCharacterPrompt(msg, 'smm');
    expect(withPersona.endsWith('\n\n' + msg)).toBe(true);
    expect(withPersona).toContain('You are Soshie');
  });

  it('every character has the required preset fields', () => {
    for (const c of CHARACTERS) {
      expect(c.id).toMatch(/^[a-z-]+$/);
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.greeting.length).toBeGreaterThan(0);
      expect(c.emoji.length).toBeGreaterThan(0);
      expect(c.color).toBeGreaterThanOrEqual(0);
      // Palette has 12 hues (0–11; see [data-logo-color] in style.css).
      expect(c.color).toBeLessThanOrEqual(11);
      expect(['execute', 'work', 'secure', 'incognito']).toContain(c.defaultMode);
      // Non-default characters are personified (have a role + persona).
      if (c.id !== 'generalist') {
        expect(c.role.length).toBeGreaterThan(0);
        expect(c.persona.length).toBeGreaterThan(0);
        // avatar is optional — a new agent with no photo yet falls back to its
        // emoji face; if present it must be a real svg under /img/characters.
        if (c.avatar) expect(c.avatar).toMatch(/^\/img\/characters\/.+\.svg$/);
        // Every specialist carries a concrete method playbook (vertical depth).
        expect((c.playbook ?? '').length).toBeGreaterThan(0);
      }
    }
  });

  it('tailors a tool allowlist per character (none for full-access roles)', () => {
    // Generalist imposes no restriction.
    expect(characterToolAllowlist('generalist')).toBeNull();
    // Remi runs with the full work-mode toolset (read + write + run) — its
    // research focus is steered by the playbook, not enforced by withholding tools.
    expect(characterToolAllowlist('researcher')).toBeNull();
    // Emmie drafts email replies — reads + writes, but never runs code.
    const emmie = characterToolAllowlist('email')!;
    expect(emmie).toContain('write_file');
    expect(emmie).not.toContain('run_command');
  });

  it('covers the core roles (researcher, smm, email, assistant)', () => {
    for (const id of ['researcher', 'smm', 'email', 'assistant']) {
      expect(isKnownCharacter(id)).toBe(true);
    }
    // The planner-style specialists carry the calendar panel.
    expect(getCharacter('assistant').panels).toContain('calendar');
    expect(getCharacter('smm').panels).toContain('calendar');
  });

  it('resolves panels through the registry (modular — no hardcoded switch)', () => {
    // Every panel id a character declares must resolve to a registered partial.
    for (const c of CHARACTERS) {
      for (const pid of c.panels ?? []) {
        expect(PANEL_REGISTRY[pid], `panel "${pid}" on ${c.id} is unregistered`).toBeTruthy();
      }
    }
    const soshie = resolveCharacterPanels('smm');
    expect(soshie.map((p) => p.id)).toContain('calendar');
    expect(soshie[0]!.partial).toBe('partials/panelCalendar');
    expect(soshie[0]!.label.length).toBeGreaterThan(0);
    // No panels → empty (generalist), and unknown ids are dropped.
    expect(resolveCharacterPanels('generalist')).toEqual([]);
  });

  it('derives UI capability labels from the tool set', () => {
    // Soshie has a tailored allowlist → chips are derived from it.
    const soshie = getCharacter('smm');
    expect(soshie.capabilities).toContain('Makes charts & images');
    expect(soshie.capabilities).toContain('Plans your content calendar');
    // Full-access roles impose no allowlist, so they derive no chips (same as the
    // generalist) — Remi's research identity is carried by its persona, not chips.
    expect(getCharacter('researcher').capabilities).toEqual([]);
    expect(getCharacter('generalist').capabilities).toEqual([]);
  });
});
