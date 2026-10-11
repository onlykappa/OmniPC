// Xbox 360 box art from Microsoft's Xbox Marketplace image service, looked up
// by the title ID read from the disc's default.xex. These are the same
// images Xbox 360 dashboards and Aurora show. Best effort: Microsoft no
// longer documents this service, so a missing image simply means no cover.

import type { MetadataProvider } from './providers';

export const XBOX_ART_HOSTS = ['download.xbox.com'];

export function xbox360BoxArtUrl(titleId: string, size: 'lg' | 'sm' = 'lg'): string | null {
  if (!/^[0-9A-F]{8}$/i.test(titleId)) return null;
  return `https://download.xbox.com/content/images/66acd000-77fe-1000-9115-d802${titleId.toLowerCase()}/1033/boxart${size}.jpg`;
}

export const xbox360MarketplaceProvider: MetadataProvider = {
  id: 'xbox-marketplace',
  label: 'Xbox Marketplace box art (Xbox 360)',
  online: true,
  description: 'Box art for Xbox 360 games from Microsoft\'s Xbox Marketplace image service, matched by the title ID inside the game.',
  async lookup(s) {
    if (s.systemId !== 'x360' || !s.serial) return null;
    const url = xbox360BoxArtUrl(s.serial);
    return url ? { artwork: [{ kind: 'cover', location: url, allowedHosts: XBOX_ART_HOSTS }], sourceId: s.serial.toUpperCase() } : null;
  },
};
