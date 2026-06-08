// ═══════════════════════════════════════════════════════════════════
// routes/health.js · health checks + diagnóstico de correo
// ═══════════════════════════════════════════════════════════════════

import express from 'express';
import { env } from '../config/env.js';
import { enviarPrueba } from '../services/email.js';

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    service: 'BioNova Webhook',
    status: 'running',
    version: '1.0.0',
    source: 'bionova'
  });
});

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'bionova-webhook',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    resendConfigurada: !!env.resendApiKey,
    newsdataConfigurada: !!env.newsdataApiKey
  });
});

// GET /test-correo?to=correo@dominio.com
// Prueba el envío SIN gastar pagos ni cupones. Indica si la API key está
// presente y devuelve la respuesta de Resend (útil para depurar el correo).
router.get('/test-correo', async (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).json({ ok: false, error: 'Falta ?to=correo@dominio.com' });
  if (!env.resendApiKey) {
    return res.json({ ok: false, resendApiKey: false, mensaje: 'RESEND_API_KEY no configurada en Railway' });
  }
  const r = await enviarPrueba({ to });
  res.json({ resendApiKey: true, mailFrom: env.mailFrom, resultado: r });
});

export default router;
