export const RISK = Object.freeze({
  INVALID_CODE: 0,
  INVALID_EMAIL: 8,
  INVALID_OTP: 5,
  NEW_DEVICE: 2,
  DEVICE_LIMIT: 8,
  DEVICE_REPLACEMENT: 5,
  MANY_IPS: 15,
  RAPID_COUNTRY_CHANGE: 25,
  EXCESS_SESSIONS: 3,
  RECOVERY: 10
});

export async function recordSecurityEvent(db, {
  accessId = null,
  deviceId = null,
  sessionId = null,
  eventType,
  riskPoints = 0,
  ipHash = null,
  country = null,
  metadata = {}
}) {
  await db.query(
    `INSERT INTO security_events
       (access_id, device_id, session_id, event_type, risk_points, ip_hash, country, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [accessId, deviceId, sessionId, eventType, riskPoints, ipHash, country, JSON.stringify(metadata)]
  );
  if (accessId && riskPoints > 0) {
    await db.query(
      `UPDATE accesses
       SET risk_score = LEAST(100, risk_score + $2),
           suspicious = suspicious OR (risk_score + $2 >= 50)
       WHERE id = $1`,
      [accessId, riskPoints]
    );
  }
}

export async function evaluateVelocityRisk(db, { accessId, ipHash, country }) {
  const result = await db.query(
    `SELECT
       count(DISTINCT ip_hash) FILTER (WHERE ip_hash IS NOT NULL) AS ip_count,
       count(DISTINCT country) FILTER (WHERE country IS NOT NULL) AS country_count
     FROM security_events
     WHERE access_id = $1
       AND created_at > now() - interval '60 minutes'`,
    [accessId]
  );
  const ipCount = Number(result.rows[0]?.ip_count ?? 0);
  const countryCount = Number(result.rows[0]?.country_count ?? 0);
  let points = 0;
  const signals = [];
  if (ipCount >= 5) {
    points += RISK.MANY_IPS;
    signals.push('many_ips_60m');
  }
  if (countryCount >= 2) {
    points += RISK.RAPID_COUNTRY_CHANGE;
    signals.push('multiple_countries_60m');
  }
  if (points) {
    await recordSecurityEvent(db, {
      accessId,
      eventType: 'velocity_signal',
      riskPoints: points,
      ipHash,
      country,
      metadata: { signals, ipCount, countryCount }
    });
  }
  return { points, signals };
}
