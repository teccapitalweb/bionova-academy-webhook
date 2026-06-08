// ═══════════════════════════════════════════════════════════════════
// routes/membership.js · consulta de estado de membresía (paywall del panel)
// ═══════════════════════════════════════════════════════════════════

import express from 'express';
import { getMembership } from '../services/firestore.js';

const router = express.Router();

// GET /membership/:uid → { activa, plan, esRegalo, estado, cancelaAlFinal, proximaRenovacion }
router.get('/:uid', async (req, res) => {
  try {
    res.json(await getMembership(req.params.uid));
  } catch (err) {
    console.error('❌ /membership error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
