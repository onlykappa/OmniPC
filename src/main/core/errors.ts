// Structured failures. Services throw OmniFailure with a human explanation so the
// UI can render "what happened / what we detected / what to do" instead of
// "Unknown error".

import type { OmniError, RepairSuggestion } from '@shared/models';

export class OmniFailure extends Error {
  readonly detail: OmniError;

  constructor(detail: Partial<OmniError> & { code: string; whatHappened: string }) {
    super(detail.whatHappened);
    this.name = 'OmniFailure';
    this.detail = {
      code: detail.code,
      whatHappened: detail.whatHappened,
      detected: detail.detected ?? [],
      probableCause: detail.probableCause ?? null,
      omniCanFix: detail.omniCanFix ?? null,
      userAction: detail.userAction ?? [],
      technical: detail.technical ?? null,
    };
  }

  static wrap(err: unknown, code: string, whatHappened: string, extra?: { userAction?: string[]; omniCanFix?: RepairSuggestion | null; probableCause?: string }): OmniFailure {
    if (err instanceof OmniFailure) return err;
    const e = err as NodeJS.ErrnoException;
    const detected: string[] = [];
    let probableCause = extra?.probableCause ?? null;
    if (e && typeof e === 'object' && 'code' in e && e.code) {
      detected.push(`System error code ${e.code}${e.path ? ` on ${e.path}` : ''}`);
      probableCause ??= explainErrno(e.code);
    }
    return new OmniFailure({
      code,
      whatHappened,
      detected,
      probableCause,
      userAction: extra?.userAction ?? [],
      omniCanFix: extra?.omniCanFix ?? null,
      technical: e instanceof Error ? `${e.name}: ${e.message}` : String(err),
    });
  }
}

export function explainErrno(code: string): string | null {
  switch (code) {
    case 'ENOENT': return 'A file or folder that was expected does not exist.';
    case 'EACCES':
    case 'EPERM': return 'Windows denied access. The file may be in use, read-only, or blocked by antivirus or folder permissions.';
    case 'EBUSY': return 'The file is locked by another program (often the emulator itself or antivirus scanning).';
    case 'ENOSPC': return 'The drive is out of free space.';
    case 'EEXIST': return 'Something already exists at the destination.';
    case 'ENOTDIR': return 'A path that should be a folder is a file.';
    case 'EXDEV': return 'The move crosses drives; a copy is required.';
    case 'ENETUNREACH':
    case 'ENOTFOUND':
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'ETIMEDOUT': return 'The network request failed. You may be offline or the download server is unreachable.';
    default: return null;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof OmniFailure) return err.detail.whatHappened;
  if (err instanceof Error) return err.message;
  return String(err);
}
