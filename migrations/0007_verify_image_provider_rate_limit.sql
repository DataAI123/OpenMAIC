ALTER TABLE user_api_rate_limits
  DROP CONSTRAINT user_api_rate_limits_route_key_check;

ALTER TABLE user_api_rate_limits
  ADD CONSTRAINT user_api_rate_limits_route_key_check
  CHECK (route_key IN (
    'provider_probe_models',
    'verify_model',
    'azure_voices',
    'verify_pdf_provider',
    'verify_image_provider'
  ));
