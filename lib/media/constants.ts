/**
 * Image and video provider catalogs.
 *
 * These registries are what the settings dialog, the generation toolbar and the
 * settings store render, so this module must stay free of any Node-only
 * dependency. The adapters that actually open a provider connection live behind
 * image-providers.ts / video-providers.ts and pull the connect-time SSRF
 * transport (lib/media/provider-fetch -> lib/server/audio-provider-fetch ->
 * node:dns); importing the catalog from one of those modules drags that
 * transport into the browser bundle, which Turbopack rejects outright.
 */
import type {
  ImageProviderConfig,
  ImageProviderId,
  VideoProviderConfig,
  VideoProviderId,
} from './types';

/** Shared OpenRouter endpoint: used by both catalogs and the image adapter. */
export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Normalise a user-entered base URL to the API root.
 *
 * The settings field is labelled "Base URL" but reads like a request URL, so
 * pasting the full endpoint (`.../api/v1/images`) is the natural mistake — and
 * it silently builds `.../api/v1/images/images`, which 404s. Trim a trailing
 * slash and a trailing `/images` or `/videos` so both forms work.
 */
export function openRouterBaseUrl(baseUrl?: string): string {
  const raw = baseUrl?.trim() || OPENROUTER_DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, '').replace(/\/(images|videos)$/, '');
}

export const IMAGE_PROVIDERS: Record<ImageProviderId, ImageProviderConfig> = {
  seedream: {
    id: 'seedream',
    name: 'Seedream',
    requiresApiKey: true,
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com',
    models: [
      { id: 'doubao-seedream-5-0-260128', name: 'Seedream 5.0 Lite' },
      { id: 'doubao-seedream-5-0-lite-260128', name: 'Seedream 5.0 Lite (Alias)' },
      { id: 'doubao-seedream-4-5-251128', name: 'Seedream 4.5' },
      { id: 'doubao-seedream-4-0-250828', name: 'Seedream 4.0' },
      { id: 'doubao-seedream-3-0-t2i-250415', name: 'Seedream 3.0' },
    ],
    supportedAspectRatios: ['16:9', '4:3', '1:1', '9:16'],
  },
  'openai-image': {
    id: 'openai-image',
    name: 'OpenAI Image',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-image-2', name: 'GPT Image 2' },
      { id: 'gpt-image-2-2026-04-21', name: 'GPT Image 2 (2026-04-21)' },
      { id: 'gpt-image-1.5', name: 'GPT Image 1.5' },
      { id: 'gpt-image-1', name: 'GPT Image 1' },
      { id: 'gpt-image-1-mini', name: 'GPT Image 1 Mini' },
      { id: 'chatgpt-image-latest', name: 'ChatGPT Image Latest' },
    ],
    supportedAspectRatios: ['16:9', '4:3', '1:1', '9:16'],
  },
  'qwen-image': {
    id: 'qwen-image',
    name: 'Qwen Image',
    requiresApiKey: true,
    defaultBaseUrl: 'https://dashscope.aliyuncs.com',
    models: [
      { id: 'qwen-image-2.0-pro', name: 'Qwen Image 2.0 Pro' },
      { id: 'qwen-image-2.0-pro-2026-03-03', name: 'Qwen Image 2.0 Pro (2026-03-03)' },
      { id: 'qwen-image-2.0', name: 'Qwen Image 2.0' },
      { id: 'qwen-image-2.0-2026-03-03', name: 'Qwen Image 2.0 (2026-03-03)' },
      { id: 'qwen-image-max', name: 'Qwen Image Max' },
      { id: 'qwen-image-max-2025-12-30', name: 'Qwen Image Max (2025-12-30)' },
      { id: 'qwen-image-plus', name: 'Qwen Image Plus' },
      {
        id: 'qwen-image-plus-2026-01-09',
        name: 'Qwen Image Plus (2026-01-09)',
      },
      { id: 'qwen-image', name: 'Qwen Image' },
      { id: 'z-image-turbo', name: 'Z-Image Turbo' },
    ],
    supportedAspectRatios: ['16:9', '4:3', '1:1', '9:16'],
  },
  'nano-banana': {
    id: 'nano-banana',
    name: 'Nano Banana (Gemini)',
    requiresApiKey: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    models: [
      {
        id: 'gemini-3.1-flash-image-preview',
        name: 'Gemini 3.1 Flash Image (Nano Banana 2)',
      },
      {
        id: 'gemini-3-pro-image-preview',
        name: 'Gemini 3 Pro Image (Nano Banana Pro)',
      },
      {
        id: 'gemini-2.5-flash-image',
        name: 'Gemini 2.5 Flash Image (Nano Banana)',
      },
    ],
    supportedAspectRatios: ['16:9', '4:3', '1:1'],
  },
  'minimax-image': {
    id: 'minimax-image',
    name: 'MiniMax Image',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.minimaxi.com',
    models: [
      { id: 'image-01', name: 'Image 01' },
      { id: 'image-01-live', name: 'Image 01 Live' },
    ],
    supportedAspectRatios: ['16:9', '4:3', '1:1', '9:16'],
  },
  'grok-image': {
    id: 'grok-image',
    name: 'Grok Image (xAI)',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.x.ai/v1',
    models: [
      { id: 'grok-imagine-image', name: 'Grok Imagine Image' },
      { id: 'grok-imagine-image-pro', name: 'Grok Imagine Image Pro' },
    ],
    supportedAspectRatios: ['16:9', '4:3', '1:1', '9:16'],
  },
  'comfyui-image': {
    id: 'comfyui-image',
    name: 'ComfyUI Image',
    requiresApiKey: false,
    defaultBaseUrl: 'http://localhost:8188',
    // No static models here — real selectable workflows are discovered at
    // runtime from GET /api/comfyui-workflows (files in public/) and picked
    // in Settings. A placeholder id like "comfyui-image" doesn't correspond
    // to any real workflow file, so resolveSelectedModel() would resolve it
    // to a dead path the first time this provider became active (#P2).
    // With models: [], imageModelId resolves to '' when this provider is
    // selected with no workflow chosen yet. In that case (and on the
    // autonomous classroom-media path, which has no model id to pass) the
    // adapter's loadWorkflow() defaults to the first workflow file discovered
    // in public/ via listComfyuiWorkflowFilenames() — not a hard-coded
    // filename, since no particular workflow name is guaranteed to exist.
    models: [],
    supportedAspectRatios: ['16:9', '4:3', '1:1', '9:16'],
    maxResolution: { width: 1920, height: 1920 },
  },
  lemonade: {
    id: 'lemonade',
    name: 'Lemonade',
    requiresApiKey: false,
    defaultBaseUrl: 'http://localhost:13305/v1',
    icon: '/logos/lemonade.svg',
    models: [
      { id: 'Qwen-Image-GGUF', name: 'Qwen Image GGUF' },
      { id: 'sd-cpp', name: 'Stable Diffusion (sd-cpp)' },
    ],
    supportedAspectRatios: ['16:9', '4:3', '1:1', '9:16'],
    maxResolution: { width: 1024, height: 1024 },
  },
  'openrouter-image': {
    id: 'openrouter-image',
    name: 'OpenRouter Image',
    requiresApiKey: true,
    defaultBaseUrl: OPENROUTER_DEFAULT_BASE_URL,
    // Model list is fetched live from OpenRouter's public GET /images/models
    // catalog; this seed keeps the picker usable offline.
    models: [
      { id: 'google/gemini-3-pro-image', name: 'Gemini 3 Pro Image' },
      { id: 'openai/gpt-image-2', name: 'GPT Image 2' },
      { id: 'bytedance-seed/seedream-5-0-pro', name: 'Seedream 5.0 Pro' },
    ],
    supportedAspectRatios: ['16:9', '4:3', '1:1', '9:16'],
  },
};

export const VIDEO_PROVIDERS: Record<VideoProviderId, VideoProviderConfig> = {
  seedance: {
    id: 'seedance',
    name: 'Seedance',
    requiresApiKey: true,
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com',
    models: [
      { id: 'doubao-seedance-2-0-260128', name: 'Seedance 2.0' },
      {
        id: 'doubao-seedance-2-0-fast-260128',
        name: 'Seedance 2.0 Fast',
      },
      {
        id: 'doubao-seedance-2-0-mini-260615',
        name: 'Seedance 2.0 Mini',
      },
      { id: 'doubao-seedance-1-5-pro-251215', name: 'Seedance 1.5 Pro' },
      { id: 'doubao-seedance-1-0-pro-250528', name: 'Seedance 1.0 Pro' },
      {
        id: 'doubao-seedance-1-0-pro-fast-251015',
        name: 'Seedance 1.0 Pro Fast',
      },
      {
        id: 'doubao-seedance-1-0-lite-t2v-250428',
        name: 'Seedance 1.0 Lite T2V',
      },
    ],
    supportedAspectRatios: ['16:9', '4:3', '1:1', '9:16', '3:4', '21:9'],
    supportedDurations: [5, 10],
    supportedResolutions: ['480p', '720p', '1080p'],
    maxDuration: 10,
  },
  kling: {
    id: 'kling',
    name: 'Kling',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api-beijing.klingai.com',
    models: [
      { id: 'kling-v2-6', name: 'Kling V2.6' },
      { id: 'kling-v1-6', name: 'Kling V1.6' },
    ],
    supportedAspectRatios: ['16:9', '1:1', '9:16'],
    supportedDurations: [5, 10],
    maxDuration: 10,
  },
  veo: {
    id: 'veo',
    name: 'Veo',
    requiresApiKey: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    models: [
      { id: 'veo-3.1-fast-generate-001', name: 'Veo 3.1 Fast' },
      { id: 'veo-3.1-generate-001', name: 'Veo 3.1' },
      { id: 'veo-3.0-fast-generate-001', name: 'Veo 3.0 Fast' },
      { id: 'veo-3.0-generate-001', name: 'Veo 3.0' },
      { id: 'veo-2.0-generate-001', name: 'Veo 2.0' },
    ],
    supportedAspectRatios: ['16:9', '1:1', '9:16'],
    supportedDurations: [8],
    supportedResolutions: ['720p'],
    maxDuration: 8,
  },
  'minimax-video': {
    id: 'minimax-video',
    name: 'MiniMax Video',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.minimaxi.com',
    // Hailuo 2.3 Fast requires Image-to-Video with first_frame_image; this
    // provider currently submits Text-to-Video requests only.
    models: [
      { id: 'MiniMax-Hailuo-2.3', name: 'Hailuo 2.3' },
      { id: 'MiniMax-Hailuo-02', name: 'Hailuo 02' },
      { id: 'T2V-01-Director', name: 'T2V-01 Director' },
      { id: 'T2V-01', name: 'T2V-01' },
    ],
    supportedAspectRatios: ['16:9', '4:3', '1:1', '9:16'],
    supportedDurations: [6, 10],
    supportedResolutions: ['720p', '1080p'],
    maxDuration: 10,
  },
  'grok-video': {
    id: 'grok-video',
    name: 'Grok Video (xAI)',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.x.ai/v1',
    models: [{ id: 'grok-imagine-video', name: 'Grok Imagine Video' }],
    supportedAspectRatios: ['16:9', '1:1', '9:16'],
    supportedDurations: [6],
    maxDuration: 6,
  },
  happyhorse: {
    id: 'happyhorse',
    name: 'HappyHorse',
    requiresApiKey: true,
    defaultBaseUrl: 'https://dashscope.aliyuncs.com',
    models: [{ id: 'happyhorse-1.0-t2v', name: 'HappyHorse 1.0 T2V' }],
    supportedAspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    supportedDurations: [5, 10, 15],
    supportedResolutions: ['720p', '1080p'],
    maxDuration: 15,
  },
  'openrouter-video': {
    id: 'openrouter-video',
    name: 'OpenRouter Video',
    requiresApiKey: true,
    defaultBaseUrl: OPENROUTER_DEFAULT_BASE_URL,
    // Model list is fetched live from OpenRouter's public GET /videos/models
    // catalog; this seed keeps the picker usable offline.
    models: [
      { id: 'google/veo-3.1', name: 'Veo 3.1' },
      { id: 'kwaivgi/kling-v3.0-pro', name: 'Kling v3.0 Pro' },
      { id: 'bytedance/seedance-2.5', name: 'Seedance 2.5' },
    ],
    supportedAspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    supportedDurations: [4, 5, 6, 8, 10],
    supportedResolutions: ['480p', '720p', '1080p'],
    maxDuration: 10,
  },
};
