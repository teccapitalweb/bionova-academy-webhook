// ═══════════════════════════════════════════════════════════════════
// routes/news.js · endpoints del cron de noticias
// ═══════════════════════════════════════════════════════════════════

import express from 'express';
import { syncNewsData } from '../services/news.js';
import { getUltimaNoticia } from '../services/firestore.js';
import { env } from '../config/env.js';

const router = express.Router();

// GET /noticias/sync?secret=... → disparar manualmente el cron
router.get('/sync', async (req, res) => {
  if (req.query.secret !== env.cronSecret) {
    return res.status(401).json({ error: 'Secret inválido' });
  }
  try {
    const total = await syncNewsData();
    res.json({ ok: true, total });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /noticias/status → estado del cron y última actualización
router.get('/status', async (req, res) => {
  try {
    const ultima = await getUltimaNoticia();
    res.json({
      ok: true,
      cronActivo: true,
      hayCredenciales: !!env.newsdataApiKey,
      ultimaActualizacion: ultima?.createdAt || null
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
