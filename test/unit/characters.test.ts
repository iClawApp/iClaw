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
    // The specialist's method playbook is injected.
    expect(sys).toContain('How you work:');
    expect(sys).toContain('Triangulate at least two independent sources');
  });

  it('prepends the persona only for non-generalist characters', () => {
    const msg = 'hello';
    expect(applyCharacterPrompt(msg, 'generalist')).toBe(msg);
    const withPersona = applyCharacterPrompt(msg, 'writer');
    expect(withPersona.endsWith('\n\n' + msg)).toBe(true);
    expect(withPersona).toContain('You are Penn');
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
      // Non-default characters are personified (have a role + persona + avatar).
      if (c.id !== 'generalist') {
        expect(c.role.length).toBeGreaterThan(0);
        expect(c.persona.length).toBeGreaterThan(0);
        expect(c.avatar).toMatch(/^\/img\/characters\/.+\.svg$/);
        // Every specialist carries a concrete method playbook (vertical depth).
        expect((c.playbook ?? '').length).toBeGreaterThan(0);
      }
    }
  });

  it('tailors a real tool allowlist per character (research is read-only)', () => {
    // Generalist imposes no restriction.
    expect(characterToolAllowlist('generalist')).toBeNull();
    // Remi researches but never writes or runs code.
    const remi = characterToolAllowlist('researcher')!;
    expect(remi).toContain('web_search');
    expect(remi).toContain('read_file');
    expect(remi).not.toContain('write_file');
    expect(remi).not.toContain('edit_file');
    expect(remi).not.toContain('run_command');
    // Support drafts replies — reads + writes, but never runs code.
    const cleo = characterToolAllowlist('support')!;
    expect(cleo).toContain('write_file');
    expect(cleo).not.toContain('run_command');
    // The bookkeeper crunches numbers, so it does get the shell.
    expect(characterToolAllowlist('bookkeeper')).toContain('run_command');
  });

  it('covers the essential SMB roles (support, email, assistant, bookkeeper)', () => {
    for (const id of ['support', 'email', 'assistant', 'bookkeeper']) {
      expect(isKnownCharacter(id)).toBe(true);
    }
    // The personal assistant carries the calendar panel, like the social manager.
    expect(getCharacter('assistant').panels).toContain('calendar');
    // Support carries the saved-replies panel.
    expect(getCharacter('support').panels).toContain('replies');
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
    const remi = getCharacter('researcher');
    expect(remi.capabilities).toContain('Looks things up online');
    expect(remi.capabilities).toContain('Reads your files');
    expect(remi.capabilities).not.toContain('Runs code & tasks');
    const milli = getCharacter('bookkeeper');
    expect(milli.capabilities).toContain('Runs code & tasks');
    // Soshie makes visuals and plans the content calendar.
    const soshie = getCharacter('smm');
    expect(soshie.capabilities).toContain('Makes charts & images');
    expect(soshie.capabilities).toContain('Plans your content calendar');
    // Generalist has no tools, so no capability chips.
    expect(getCharacter('generalist').capabilities).toEqual([]);
  });
});
