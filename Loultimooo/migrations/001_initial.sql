CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_code_hash text NOT NULL,
  access_code_lookup char(64) NOT NULL UNIQUE,
  access_code_last4 char(4) NOT NULL,
  access_code_ciphertext text,
  order_id text NOT NULL UNIQUE,
  order_name text,
  customer_email text NOT NULL,
  status text NOT NULL DEFAULT 'issued'
    CHECK (status IN ('issued', 'active', 'disabled')),
  activated_at timestamptz,
  last_used_at timestamptz,
  max_devices smallint NOT NULL DEFAULT 2 CHECK (max_devices BETWEEN 1 AND 10),
  activation_count integer NOT NULL DEFAULT 0 CHECK (activation_count >= 0),
  risk_score smallint NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  suspicious boolean NOT NULL DEFAULT false,
  risk_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS accesses_customer_email_idx
  ON accesses (customer_email);

CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_id uuid NOT NULL REFERENCES accesses(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  label text NOT NULL,
  user_agent text NOT NULL,
  last_ip_hash char(64),
  last_country char(2),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_reason text
);

CREATE INDEX IF NOT EXISTS devices_access_status_idx
  ON devices (access_id, status);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_id uuid NOT NULL REFERENCES accesses(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  ip_hash char(64),
  country char(2),
  user_agent text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text
);

CREATE INDEX IF NOT EXISTS sessions_access_active_idx
  ON sessions (access_id, created_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_token_idx ON sessions (token_hash);

CREATE TABLE IF NOT EXISTS activation_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash char(64) NOT NULL UNIQUE,
  access_id uuid NOT NULL REFERENCES accesses(id) ON DELETE CASCADE,
  purpose text NOT NULL DEFAULT 'activate'
    CHECK (purpose IN ('activate', 'device_replace')),
  otp_hash char(64),
  otp_expires_at timestamptz,
  otp_attempts smallint NOT NULL DEFAULT 0,
  email_sent_at timestamptz,
  email_verified_at timestamptz,
  management_authorized_at timestamptz,
  consumed_at timestamptz,
  ip_hash char(64),
  country char(2),
  user_agent text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS activation_challenges_access_idx
  ON activation_challenges (access_id, created_at DESC);

CREATE TABLE IF NOT EXISTS recovery_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_id uuid NOT NULL REFERENCES accesses(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  requested_ip_hash char(64)
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip_hash char(64),
  user_agent text NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id bigserial PRIMARY KEY,
  webhook_id text NOT NULL UNIQUE,
  topic text NOT NULL,
  shop_domain text NOT NULL,
  payload_sha256 char(64) NOT NULL,
  order_id text,
  outcome text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_events_order_idx
  ON webhook_events (order_id);

CREATE TABLE IF NOT EXISTS security_events (
  id bigserial PRIMARY KEY,
  access_id uuid REFERENCES accesses(id) ON DELETE SET NULL,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  risk_points smallint NOT NULL DEFAULT 0,
  ip_hash char(64),
  country char(2),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_events_access_time_idx
  ON security_events (access_id, created_at DESC);
CREATE INDEX IF NOT EXISTS security_events_ip_time_idx
  ON security_events (ip_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  key_hash char(64) PRIMARY KEY,
  route text NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  reset_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_limits_reset_idx ON rate_limits (reset_at);

CREATE TABLE IF NOT EXISTS email_outbox (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('access_code', 'otp', 'recovery')),
  access_id uuid REFERENCES accesses(id) ON DELETE CASCADE,
  recipient text NOT NULL,
  encrypted_payload text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE INDEX IF NOT EXISTS email_outbox_pending_idx
  ON email_outbox (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY,
  admin_session_id uuid REFERENCES admin_sessions(id) ON DELETE SET NULL,
  access_id uuid REFERENCES accesses(id) ON DELETE SET NULL,
  action text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash char(64),
  created_at timestamptz NOT NULL DEFAULT now()
);
