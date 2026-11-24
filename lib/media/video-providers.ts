/**
 * Video Generation Service -- routes to provider adapters
 *
 * The provider catalog itself is browser-safe and lives in ./constants: this
 * module reaches the server-side transport through the adapters, so importing
 * the catalog from here would pull Node-only code into the client bundle.
 */

import type {
  VideoProviderId,
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from './types';
import { VIDEO_PROVIDERS } from './constants';
import { generateWithSeedance, testSeedanceConnectivity } from './adapters/seedance-adapter';
import { generateWithKling, testKlingConnectivity } from './adapters/kling-adapter';
import { generateWithVeo, testVeoConnectivity } from './adapters/veo-adapter';
import {
  generateWithMiniMaxVideo,
  testMiniMaxVideoConnectivity,
} from './adapters/minimax-video-adapter';
import { generateWithGrokVideo, testGrokVideoConnectivity } from './adapters/grok-video-adapter';
import { generateWithHappyHorse, testHappyHorseConnectivity } from './adapters/happyhorse-adapter';
import {
  generateWithOpenRouterVideo,
  testOpenRouterVideoConnectivity,
  OPENROUTER_VIDEO_KEY_PROBE,
} from './adapters/openrouter-video-adapter';
import type { ProviderKeyProbe } from './provider-key-probe';

export async function testVideoConnectivity(
  config: VideoGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  switch (config.providerId) {
    case 'seedance':
      return testSeedanceConnectivity(config);
    case 'kling':
      return testKlingConnectivity(config);
    case 'veo':
      return testVeoConnectivity(config);
    case 'minimax-video':
      return testMiniMaxVideoConnectivity(config);
    case 'grok-video':
      return testGrokVideoConnectivity(config);
    case 'happyhorse':
      return testHappyHorseConnectivity(config);
    case 'openrouter-video':
      return testOpenRouterVideoConnectivity(config);
    default:
      return {
        success: false,
        message: `Unsupported video provider: ${config.providerId}`,
      };
  }
}

/**
 * Resolve the neutral key probe a capability route may use to verify a BYOK
 * key without generating anything. Returns undefined for providers that have no
 * verification surface.
 */
export function resolveVideoKeyProbe(providerId: string): ProviderKeyProbe | undefined {
  switch (providerId) {
    case 'openrouter-video':
      return OPENROUTER_VIDEO_KEY_PROBE;
    default:
      return undefined;
  }
}

/**
 * Normalize video generation options against provider capabilities.
 * Ensures duration, aspectRatio, and resolution are valid for the given provider.
 * Falls back to the first supported value when the requested value is unsupported.
 */
export function normalizeVideoOptions(
  providerId: VideoProviderId,
  options: VideoGenerationOptions,
): VideoGenerationOptions {
  const provider = VIDEO_PROVIDERS[providerId];
  if (!provider) return options;

  const normalized = { ...options };

  // Duration: use first supported value if unset or unsupported
  if (provider.supportedDurations && provider.supportedDurations.length > 0) {
    if (!normalized.duration || !provider.supportedDurations.includes(normalized.duration)) {
      normalized.duration = provider.supportedDurations[0];
    }
  }

  // Aspect ratio: use first supported value if unset or unsupported
  if (provider.supportedAspectRatios && provider.supportedAspectRatios.length > 0) {
    if (
      !normalized.aspectRatio ||
      !provider.supportedAspectRatios.includes(normalized.aspectRatio)
    ) {
      normalized.aspectRatio = provider
        .supportedAspectRatios[0] as VideoGenerationOptions['aspectRatio'];
    }
  }

  // Resolution: use first supported value if unset or unsupported
  if (provider.supportedResolutions && provider.supportedResolutions.length > 0) {
    if (!normalized.resolution || !provider.supportedResolutions.includes(normalized.resolution)) {
      normalized.resolution = provider.supportedResolutions[0];
    }
  }

  return normalized;
}

export async function generateVideo(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
): Promise<VideoGenerationResult> {
  switch (config.providerId) {
    case 'seedance':
      return generateWithSeedance(config, options);
    case 'kling':
      return generateWithKling(config, options);
    case 'veo':
      return generateWithVeo(config, options);
    case 'minimax-video':
      return generateWithMiniMaxVideo(config, options);
    case 'grok-video':
      return generateWithGrokVideo(config, options);
    case 'happyhorse':
      return generateWithHappyHorse(config, options);
    case 'openrouter-video':
      return generateWithOpenRouterVideo(config, options);
    default:
      throw new Error(`Unsupported video provider: ${config.providerId}`);
  }
}
