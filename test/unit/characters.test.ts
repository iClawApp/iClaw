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

  it('builds a persona block naming the character and role', () => {
    const block = buildCharacterPromptBlock('researcher');
    expect(block).toContain('act as Remi, the Researcher');
    expect(block).toContain("the user's message follows");
  });

  it('builds a runtime system prompt for a real character, null for generalist', () => {
    expect(buildCharacterSystemPrompt('generalist')).toBeNull();
    const sys = buildCharacterSystemPrompt('researcher');
    expect(sys).toContain('You are Remi, the Researcher');
    // System prompt is plain (no gateway bracket framing).
    expect(sys).not.toContain('[Character');
  });

  it('prepends the persona only for non-generalist characters', () => {
    const msg = 'hello';
    expect(applyCharacterPrompt(msg, 'generalist')).toBe(msg);
    const withPersona = applyCharacterPrompt(msg, 'writer');
    expect(withPersona.endsWith('\n\n' + msg)).toBe(true);
    expect(withPersona).toContain('act as Wren, the Writer');
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
    // Cody gets the full dev kit including the shell.
    const cody = characterToolAllowlist('engineer')!;
    expect(cody).toContain('edit_file');
    expect(cody).toContain('run_command');
    // Support drafts replies — reads + writes, but never runs code.
    const cleo = characterToolAllowlist('support')!;
    expect(cleo).toContain('write_file');
    expect(cleo).not.toContain('run_command');
    // The bookkeeper crunches numbers, so it does get the shell.
    expect(characterToolAllowlist('bookkeeper')).toContain('run_command');
  });

  it('covers the essential SMB roles (support, email, assistant, seo, bookkeeper)', () => {
    for (const id of ['support', 'email', 'assistant', 'seo', 'bookkeeper']) {
      expect(isKnownCharacter(id)).toBe(true);
    }
    // The personal assistant carries the calendar panel, like Mia.
    expect(getCharacter('assistant').panel).toBe('calendar');
    // Support carries the saved-replies panel.
    expect(getCharacter('support').panel).toBe('replies');
  });

  it('derives UI capability labels from the tool set', () => {
    const remi = getCharacter('researcher');
    expect(remi.capabilities).toContain('Looks things up online');
    expect(remi.capabilities).toContain('Reads your files');
    expect(remi.capabilities).not.toContain('Runs code & tasks');
    const ada = getCharacter('analyst');
    expect(ada.capabilities).toContain('Runs code & tasks');
    expect(ada.capabilities).toContain('Makes charts & images');
    // Generalist has no tools, so no capability chips.
    expect(getCharacter('generalist').capabilities).toEqual([]);
  });
});
