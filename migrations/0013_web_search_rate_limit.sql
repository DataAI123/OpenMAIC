-- Extend the fixed-window route-key CHECK for the batch-9 opened web-search
-- entry (a real per-request provider cost). Forward-only.
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
    'classroom_store',
    'generate_classroom',
    'web_search'
  ));
