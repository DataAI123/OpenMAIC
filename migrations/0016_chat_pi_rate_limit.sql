-- Extend the fixed-window route-key CHECK for the batch-13 opened Pi director
-- chat turn handler, which shares the 5-req/60s action budget with the other
-- stateless LLM turn routes.
-- Forward-only.
ALTER TABLE user_api_rate_limits
  DROP CONSTRAINT user_api_rate_limits_route_key_check;

ALTER TABLE user_api_rate_limits
  ADD CONSTRAINT user_api_rate_limits_route_key_check
  CHECK (route_key IN (
    'provider_probe_models',
    'verify_model',
    'azure_voices',
    'verify_pdf_provider',
    'verify_image_provider',
    'verify_video_provider',
    'api_chat',
    'chat_pi',
    'generate_scene_content',
    'generate_scene_actions',
    'generate_scene_outlines_stream',
    'generate_agent_profiles',
    'generate_voice',
    'quiz_grade',
    'pbl_v2_instructor',
    'pbl_v2_evaluate',
    'pbl_v2_open_task',
    'pbl_v2_simulator',
    'pbl_v2_task_update',
    'extract_document',
    'transcription',
    'parse_pdf',
    'proxy_media',
    'classroom_store',
    'generate_classroom',
    'web_search'
  ));