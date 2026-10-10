// Optional AI troubleshooter ("Ask OmniDoctor"). Disabled by default and never
// required for diagnosis or repair. Only a structured, redacted summary of
// local diagnostic state is sent - never ROMs, BIOS, saves or keys - and the
// user can preview exactly what would be sent first.

import Anthropic from '@anthropic-ai/sdk';
import type { AiContextPreview, AppSettings, HardwareProfile } from '@shared/models';
import { redactPaths } from '../diagnostics/logs';
import { OmniFailure } from '../core/errors';

export interface AiContextInput {
  question: string;
  hardware: HardwareProfile | null;
  emulators: { id: string; name: string; version: string | null; health: string; renderer: string; resolutionScale: number; customConfig: boolean }[];
  game: { title: string; system: string; serial: string | null; emulator: string | null; compatibility: string | null; profileOverrides: unknown } | null;
  recentLaunches: { at: string; outcome: string; exitCode: number | null; emulator: string }[];
  latestFailure: { headline: string; probableCause: string | null; evidence: string[]; logExcerpt: string | null } | null;
  recentChanges: { at: string; summary: string }[];
  healthProblems: string[];
}

export function buildAiContext(input: AiContextInput): AiContextPreview & { payload: unknown } {
  const payload = {
    question: input.question,
    computer: input.hardware
      ? { os: input.hardware.osName, cpu: input.hardware.cpu.model, cpuFeatures: input.hardware.cpu.features, ramGB: Math.round(input.hardware.ramMB / 1024), gpus: input.hardware.gpus.map((g) => `${g.name} (${g.vramMB ?? '?'} MB, driver ${g.driverVersion ?? '?'})`), vulkan: input.hardware.graphicsApis.vulkan, directx12: input.hardware.graphicsApis.directx12 }
      : null,
    emulators: input.emulators,
    game: input.game,
    recentLaunches: input.recentLaunches,
    latestFailure: input.latestFailure,
    recentChanges: input.recentChanges,
    healthProblems: input.healthProblems,
  };
  const { text, redactions } = redactPaths(JSON.stringify(payload, null, 2));
  return { json: text, redactions: [...new Set(redactions)], bytes: Buffer.byteLength(text), payload: JSON.parse(text) };
}

const SYSTEM_PROMPT = `You are OmniDoctor, the troubleshooting assistant inside OmniPC, a Windows app that installs, configures and launches emulators (PCSX2, Dolphin and others) for the user's own legally obtained games.
You receive a JSON summary of the user's local diagnostic state. Explain likely causes in plain language, ranked by how well the evidence supports them, and say when the evidence is insufficient. Prefer fixes the user can apply inside OmniPC (renderer, resolution, per-game profiles, repairs, reinstall, rollback). Never suggest downloading BIOS files, firmware, keys or games from unofficial sources. Keep the answer under 250 words.`;

export async function askAssistant(settings: AppSettings, context: AiContextPreview, client?: Anthropic): Promise<{ answer: string; provider: string }> {
  if (!settings.aiEnabled || settings.aiProvider !== 'anthropic') {
    throw new OmniFailure({ code: 'AI_DISABLED', whatHappened: 'The AI troubleshooter is turned off.', userAction: ['Enable it in Settings > OmniDoctor > AI troubleshooter. All local diagnostics work without it.'] });
  }
  if (!settings.aiApiKey) throw new OmniFailure({ code: 'AI_NO_KEY', whatHappened: 'No Anthropic API key is configured for the AI troubleshooter.' });
  const c = client ?? new Anthropic({ apiKey: settings.aiApiKey });
  const model = settings.aiModel || 'claude-opus-5-5';
  let response;
  try {
    response = await c.messages.create({
      model,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: `Diagnostic context (JSON):\n${context.json}` }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new OmniFailure({ code: 'AI_AUTH', whatHappened: 'The Anthropic API rejected the API key.', userAction: ['Check the key in Settings > OmniDoctor.'] });
    if (err instanceof Anthropic.RateLimitError) throw new OmniFailure({ code: 'AI_RATE_LIMIT', whatHappened: 'The Anthropic API is rate limiting requests. Try again shortly.' });
    if (err instanceof Anthropic.APIConnectionError) throw new OmniFailure({ code: 'AI_OFFLINE', whatHappened: 'Could not reach the Anthropic API. Local diagnostics still work offline.' });
    throw OmniFailure.wrap(err, 'AI_FAILED', 'The AI troubleshooter request failed.');
  }
  if (response.stop_reason === 'refusal') return { answer: 'The assistant declined to answer this request. The local OmniDoctor diagnosis above is unaffected.', provider: `Anthropic (${model})` };
  const answer = response.content.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.text : '')).join('\n').trim();
  return { answer: answer || 'No answer was returned.', provider: `Anthropic (${model})` };
}
