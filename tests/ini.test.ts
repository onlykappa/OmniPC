import { describe, expect, it } from 'vitest';
import { IniDocument } from '../src/main/config/ini';
import { checkIni, checkJson, checkXml } from '../src/main/config/formats';

describe('IniDocument', () => {
  const sample = '; PCSX2 settings\r\n[UI]\r\nTheme = dark\r\nConfirmShutdown = true\r\n\r\n[Folders]\r\nBios = bios\r\n';

  it('reads values case-insensitively and preserves layout', () => {
    const doc = IniDocument.parse(sample);
    expect(doc.get('ui', 'theme')).toBe('dark');
    expect(doc.toString()).toBe(sample);
  });

  it('updates existing keys in place and keeps comments and CRLF', () => {
    const doc = IniDocument.parse(sample);
    expect(doc.set('UI', 'ConfirmShutdown', false)).toBe(true);
    const out = doc.toString();
    expect(out).toContain('; PCSX2 settings');
    expect(out).toContain('ConfirmShutdown = false\r\n');
    expect(out.indexOf('ConfirmShutdown')).toBeLessThan(out.indexOf('[Folders]'));
  });

  it('reports unchanged writes', () => {
    const doc = IniDocument.parse(sample);
    expect(doc.set('UI', 'Theme', 'dark')).toBe(false);
  });

  it('appends new keys to the end of their section and creates sections', () => {
    const doc = IniDocument.parse(sample);
    doc.set('UI', 'StartFullscreen', true);
    doc.set('EmuCore/GS', 'upscale_multiplier', 3);
    const text = doc.toString();
    expect(text.indexOf('StartFullscreen')).toBeLessThan(text.indexOf('[Folders]'));
    expect(text).toMatch(/\[EmuCore\/GS\]\r\nupscale_multiplier = 3/);
    expect(IniDocument.parse(text).get('EmuCore/GS', 'upscale_multiplier')).toBe('3');
  });

  it('detects malformed content and repairs it', () => {
    const broken = '[UI]\nTheme = dark\ngarbage line without equals\n[UI]\nExtra = 1\n';
    const doc = IniDocument.parse(broken);
    expect(doc.validate().length).toBe(2);
    const changes = doc.repair();
    expect(changes.join('\n')).toMatch(/unparseable/);
    expect(changes.join('\n')).toMatch(/duplicate section/);
    expect(doc.validate()).toEqual([]);
    expect(doc.get('UI', 'Extra')).toBe('1');
    expect(doc.sections()).toEqual(['UI']);
  });

  it('flags NUL bytes as corruption', () => {
    expect(checkIni('[a]\nb=1\n\u0000\u0000').ok).toBe(false);
  });
});

describe('format checks', () => {
  it('json', () => {
    expect(checkJson('{"a":1}').ok).toBe(true);
    expect(checkJson('{"a":').ok).toBe(false);
  });
  it('xml', () => {
    expect(checkXml('<?xml version="1.0"?><root><a x="1"/><b>t</b></root>').ok).toBe(true);
    expect(checkXml('<root><a></root>').ok).toBe(false);
    expect(checkXml('<root><a>').issues.join()).toMatch(/Unclosed/);
  });
});
