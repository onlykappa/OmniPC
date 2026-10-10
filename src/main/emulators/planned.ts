// Adapter for manifests whose integration is not implemented yet. It exists
// so the registry, library and UI can show these emulators honestly as
// "planned" without any fake install/launch behaviour.

import type { EmulatorManifest, EmulatorSettings, PerformancePreset, SetupImportCandidate, BiosStatus, Finding, RendererOption } from '@shared/models';
import type { AdapterCapabilities, AdapterPaths, ConfigInspection, ConfigWriteResult, EmulatorAdapter, LaunchCommand, SmokeTestResult } from './adapter';
import type { AppPaths } from '../core/paths';
import { OmniFailure } from '../core/errors';

export class PlannedAdapter implements EmulatorAdapter {
  readonly capabilities: AdapterCapabilities = { perGameProfiles: 'none', frameLimit: false, vsync: false, aspectRatios: [], hotkeys: [], smokeTest: false, maxResolutionScale: 1 };
  constructor(readonly manifest: EmulatorManifest, private readonly app: AppPaths) {}

  private notImplemented(): never {
    throw new OmniFailure({ code: 'ADAPTER_NOT_IMPLEMENTED', whatHappened: `${this.manifest.name} support is not implemented yet in this build of OmniPC.`, userAction: ['Watch for an OmniPC update. PCSX2 and Dolphin are fully supported today.'] });
  }

  paths(): AdapterPaths {
    const id = this.manifest.id;
    return { app: this.app.emulatorAppDir(id), data: this.app.emulatorDataDir(id), saves: this.app.emulatorSaveDir(id), bios: this.app.systemBiosDir(this.manifest.systems[0]), cache: this.app.emulatorCacheDir(id) };
  }
  async findExecutable(): Promise<string | null> { return null; }
  async detectVersion(): Promise<string | null> { return null; }
  renderers(): RendererOption[] { return []; }
  defaultSettings(_hw: unknown, preset: PerformancePreset): EmulatorSettings {
    return { preset, resolutionScale: 1, renderer: 'auto', aspectRatio: 'auto', fullscreen: true, frameLimit: true, vsync: true, advanced: {} };
  }
  configTargets() { return []; }
  async applyConfig(): Promise<ConfigWriteResult> { return this.notImplemented(); }
  async inspectConfig(): Promise<ConfigInspection> { return { files: [], drift: [] }; }
  async buildLaunch(): Promise<LaunchCommand> { return this.notImplemented(); }
  buildUiLaunch(): LaunchCommand { return this.notImplemented(); }
  async smokeTest(): Promise<SmokeTestResult> { return { ran: false, ok: false, checks: [] }; }
  async validateEnvironment(): Promise<Finding[]> { return []; }
  saveLocations() { return []; }
  async biosStatus(): Promise<BiosStatus[]> { return []; }
  logFile(): string | null { return null; }
  cacheDirs() { return []; }
  async recoverSession(): Promise<string[]> { return []; }
  async detectExistingSetups(): Promise<SetupImportCandidate[]> { return []; }
}
