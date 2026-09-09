import nodemailer from 'nodemailer';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function emailShell({ eyebrow, title, body, actionLabel, actionUrl, footnote }) {
  const button = actionLabel && actionUrl
    ? `<p style="margin:28px 0"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:#f4c86b;color:#111318;text-decoration:none;font-weight:800;padding:14px 22px;border-radius:12px">${escapeHtml(actionLabel)}</a></p>`
    : '';
  return `<!doctype html>
<html lang="es"><body style="margin:0;background:#08090b;color:#f8f8f8;font-family:Arial,sans-serif">
  <div style="max-width:620px;margin:0 auto;padding:40px 20px">
    <div style="border:1px solid #2b2d32;border-radius:20px;padding:32px;background:#111318">
      <p style="margin:0 0 14px;color:#f4c86b;font-size:12px;font-weight:800;letter-spacing:1.5px">${escapeHtml(eyebrow)}</p>
      <h1 style="margin:0 0 18px;font-size:28px;line-height:1.15">${escapeHtml(title)}</h1>
      ${body}
      ${button}
      <p style="margin:26px 0 0;color:#969aa3;font-size:13px;line-height:1.5">${escapeHtml(footnote)}</p>
    </div>
  </div>
</body></html>`;
}

function renderMessage(kind, payload) {
  if (kind === 'access_code') {
    return {
      subject: 'Tu código de acceso — Abuelo Emilio Academy',
      text: `Tu código de acceso de por vida es ${payload.code}. Accede en ${payload.accessUrl}. No compartas este código.`,
      html: emailShell({
        eyebrow: 'ABUELO EMILIO ACADEMY',
        title: 'Tu acceso está listo',
        body: `<p style="color:#d8d9dc;line-height:1.6">Gracias por tu compra. Este código queda vinculado a tu email cuando lo activas.</p>
          <div style="margin:24px 0;padding:18px;border-radius:14px;background:#08090b;border:1px solid #3a3c42;text-align:center;font-family:monospace;font-size:24px;font-weight:800;letter-spacing:2px;color:#f4c86b">${escapeHtml(payload.code)}</div>`,
        actionLabel: 'ACTIVAR MI ACCESO',
        actionUrl: payload.accessUrl,
        footnote: 'No publiques ni reenvíes el código. Los dispositivos nuevos requieren verificación por email.'
      })
    };
  }

  if (kind === 'otp') {
    return {
      subject: 'Código de verificación — Abuelo Emilio Academy',
      text: `Tu código de verificación es ${payload.otp}. Caduca en ${payload.minutes} minutos.`,
      html: emailShell({
        eyebrow: 'VERIFICACIÓN DE DISPOSITIVO',
        title: 'Confirma que eres tú',
        body: `<p style="color:#d8d9dc;line-height:1.6">Introduce este código para autorizar el dispositivo:</p>
          <div style="margin:24px 0;padding:18px;border-radius:14px;background:#08090b;border:1px solid #3a3c42;text-align:center;font-family:monospace;font-size:30px;font-weight:800;letter-spacing:8px;color:#f4c86b">${escapeHtml(payload.otp)}</div>`,
        footnote: `El código caduca en ${payload.minutes} minutos y solo puede utilizarse una vez. Si no fuiste tú, ignora este mensaje.`
      })
    };
  }

  if (kind === 'recovery') {
    return {
      subject: 'Recupera tu acceso — Abuelo Emilio Academy',
      text: `Abre este enlace para recuperar tu acceso: ${payload.recoveryUrl}. Caduca en ${payload.minutes} minutos.`,
      html: emailShell({
        eyebrow: 'RECUPERACIÓN SEGURA',
        title: 'Recupera tu código',
        body: '<p style="color:#d8d9dc;line-height:1.6">Has solicitado recuperar tu acceso. El enlace es de un solo uso.</p>',
        actionLabel: 'RECUPERAR ACCESO',
        actionUrl: payload.recoveryUrl,
        footnote: `Este enlace caduca en ${payload.minutes} minutos. Si no solicitaste la recuperación, ignora este mensaje.`
      })
    };
  }

  throw new Error(`Unsupported email kind: ${kind}`);
}

export function createMailer(config) {
  let transport = null;
  if (config.emailProvider === 'smtp') {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.password },
      pool: true,
      maxConnections: 3
    });
  }

  return {
    async send({ kind, to, payload }) {
      const message = renderMessage(kind, payload);
      if (config.emailProvider === 'console') {
        console.info('[development email]', { kind, to, ...payload });
        return;
      }

      if (config.emailProvider === 'resend') {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.emailApiKey}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ from: config.emailFrom, to: [to], ...message })
        });
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 300);
          throw new Error(`Email provider returned ${response.status}: ${detail}`);
        }
        return;
      }

      await transport.sendMail({ from: config.emailFrom, to, ...message });
    },
    async close() {
      if (transport) transport.close();
    }
  };
}
