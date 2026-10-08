import { describe, expect, it } from 'vitest';
import { normalizePsSerial, parseGameFileName, regionFromNintendoId, regionFromPsSerial } from '../src/main/library/names';

describe('parseGameFileName', () => {
  it('parses Redump-style names', () => {
    const p = parseGameFileName('Final Fantasy X (USA) (Disc 2).iso');
    expect(p.title).toBe('Final Fantasy X');
    expect(p.region).toBe('USA');
    expect(p.discNumber).toBe(2);
  });
  it('handles "Disc N of M" and articles', () => {
    const p = parseGameFileName('Legend of Dragoon, The (Europe) (Disc 1 of 4).bin');
    expect(p.title).toBe('The Legend of Dragoon');
    expect(p.discNumber).toBe(1);
    expect(p.discTotal).toBe(4);
    expect(p.region).toBe('Europe');
  });
  it('handles unbracketed disc suffixes', () => {
    const p = parseGameFileName('Xenosaga Episode II - Disc2.iso');
    expect(p.discNumber).toBe(2);
    expect(p.title).toBe('Xenosaga Episode II');
  });
  it('keeps a stable base title for grouping', () => {
    expect(parseGameFileName('Metal Gear Solid (USA) (Disc 1).cue').baseTitle).toBe(parseGameFileName('Metal Gear Solid (USA) (Disc 2).cue').baseTitle);
  });
  it('does not invent disc numbers', () => {
    expect(parseGameFileName('Disco Elysium Demo.iso').discNumber).toBeNull();
    expect(parseGameFileName('Ratchet & Clank 2.iso').discNumber).toBeNull();
  });
});

describe('serials and regions', () => {
  it('normalises PlayStation serials', () => {
    expect(normalizePsSerial('SLUS_203.12')).toBe('SLUS-20312');
    expect(normalizePsSerial('cdrom0:\\SCES_500.51;1')).toBe('SCES-50051');
    expect(normalizePsSerial('nothing')).toBeNull();
  });
  it('derives regions', () => {
    expect(regionFromPsSerial('SLUS-20312')).toBe('USA');
    expect(regionFromPsSerial('SCES-50051')).toBe('Europe');
    expect(regionFromPsSerial('SLPM-65000')).toBe('Japan');
    expect(regionFromNintendoId('GALE01')).toBe('USA');
    expect(regionFromNintendoId('RMCP01')).toBe('Europe');
  });
});
