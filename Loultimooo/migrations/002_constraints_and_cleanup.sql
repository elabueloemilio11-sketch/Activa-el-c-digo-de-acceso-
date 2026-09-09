CREATE UNIQUE INDEX IF NOT EXISTS one_live_recovery_token_per_access
  ON recovery_tokens (access_id)
  WHERE used_at IS NULL;

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS accesses_touch_updated_at ON accesses;
CREATE TRIGGER accesses_touch_updated_at
BEFORE UPDATE ON accesses
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
