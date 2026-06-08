// ═══════════════════════════════════════════════════════════════════
// services/email.js · correos transaccionales vía Resend (sin SDK, solo fetch)
// Apagado seguro: si no hay RESEND_API_KEY, NO truena; loguea y sigue.
// MAIL_FROM debe usar un dominio verificado en Resend (no onboarding@resend.dev).
// ═══════════════════════════════════════════════════════════════════

import { env } from '../config/env.js';

const FROM = env.mailFrom;                 // 'BioNova <noreply@bionovamexico.com>'
const PANEL_URL = env.panelUrl;

async function enviarCorreo({ to, subject, html }) {
  if (!env.resendApiKey) {
    console.warn('⚠️  RESEND_API_KEY no configurada · correo no enviado');
    return { ok: false, reason: 'no-api-key' };
  }
  if (!to) {
    console.warn('⚠️  Correo sin destinatario · skipping');
    return { ok: false, reason: 'no-recipient' };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: FROM, to, subject, html })
    });
    const body = await r.text();
    if (!r.ok) {
      console.error('⚠️  Resend error', r.status, '·', body.slice(0, 200));
      return { ok: false, status: r.status, detalle: body.slice(0, 200) };
    }
    console.log('📧 Correo enviado a', to, '·', subject);
    return { ok: true, detalle: body.slice(0, 120) };
  } catch (err) {
    console.error('⚠️  Error enviando correo:', err.message);
    return { ok: false, reason: err.message };
  }
}

// ───────────────────────────────────────────────────────────────
// Plantilla: bienvenida al activar membresía VIP (identidad BioNova)
// ───────────────────────────────────────────────────────────────
function plantillaBienvenida({ nombre, plan }) {
  const saludo = nombre ? `Hola ${nombre}` : 'Hola';
  const planTxt = plan === 'anual' ? 'Plan VIP Anual'
    : plan === 'mensual' ? 'Plan VIP Mensual'
    : 'Membresía VIP';
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Bienvenido a BioNova VIP</title></head>
<body style="margin:0;padding:0;background:#081225;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#081225;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#0b1530;border:1px solid #16294a;border-radius:20px;overflow:hidden;">

        <tr><td style="background:linear-gradient(135deg,#2a6df6,#10b981);padding:36px 32px;text-align:center;">
          <div style="font-size:26px;font-weight:800;color:#ffffff;letter-spacing:-.5px;">BioNova</div>
          <div style="font-size:12px;font-weight:600;color:#eaf2ff;opacity:.9;margin-top:6px;letter-spacing:1.5px;text-transform:uppercase;">Club VIP · Biomedicina · Microbiología</div>
        </td></tr>

        <tr><td style="padding:36px 32px;">
          <h1 style="margin:0 0 14px;font-size:22px;font-weight:800;color:#eaf2ff;letter-spacing:-.4px;">${saludo}, ¡bienvenido al Club VIP!</h1>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#aebfd6;">
            Tu <strong style="color:#69d2ff;">${planTxt}</strong> ya está activa. Desde hoy tienes acceso completo a todo lo que BioNova tiene para ti.
          </p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;">
            <tr><td style="padding:11px 0;border-bottom:1px solid #16294a;font-size:14px;color:#aebfd6;">Cursos con certificado verificable</td></tr>
            <tr><td style="padding:11px 0;border-bottom:1px solid #16294a;font-size:14px;color:#aebfd6;">Herramientas clínicas y de laboratorio</td></tr>
            <tr><td style="padding:11px 0;border-bottom:1px solid #16294a;font-size:14px;color:#aebfd6;">Clases en vivo y webinars del área</td></tr>
            <tr><td style="padding:11px 0;border-bottom:1px solid #16294a;font-size:14px;color:#aebfd6;">Directorio profesional y biblioteca técnica</td></tr>
            <tr><td style="padding:11px 0;font-size:14px;color:#aebfd6;">Noticias de biomedicina, microbiología y medicina</td></tr>
          </table>

          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;">
            <tr><td style="border-radius:12px;background:linear-gradient(135deg,#2a6df6,#10b981);">
              <a href="${PANEL_URL}/vip-panel.html" target="_blank" style="display:inline-block;padding:14px 30px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">
                Entrar a mi panel VIP
              </a>
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:24px 32px;border-top:1px solid #16294a;text-align:center;">
          <p style="margin:0 0 6px;font-size:12px;color:#5b6b86;line-height:1.6;">Recibiste este correo porque activaste tu membresía en BioNova.</p>
          <p style="margin:0;font-size:12px;color:#46566f;">BioNova · Biomedicina · Microbiología · Medicina general · Tehuacán, Puebla</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function enviarBienvenida({ to, nombre, plan }) {
  const html = plantillaBienvenida({ nombre, plan });
  const subject = '¡Bienvenido al Club VIP de BioNova!';
  return enviarCorreo({ to, subject, html });
}

// Correo de prueba (diagnóstico /test-correo) · sin gastar pagos ni cupones
export async function enviarPrueba({ to }) {
  const html = plantillaBienvenida({ nombre: 'prueba', plan: 'mensual' });
  return enviarCorreo({ to, subject: '✔ Prueba de correo · BioNova', html });
}

export { enviarCorreo };
