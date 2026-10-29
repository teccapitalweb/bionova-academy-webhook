// ═══════════════════════════════════════════════════════════════════
// routes/stripe.js · endpoints relacionados con Stripe
// ═══════════════════════════════════════════════════════════════════

import express from 'express';
import { firebaseAuth } from '../config/firebase.js';
import {
  verifyWebhookSignature, processWebhookEvent,
  createCheckoutSession, retrieveSession,
  cancelarSuscripcion, reactivarSuscripcion, crearBillingPortal
} from '../services/stripe.js';

const router = express.Router();

async function authenticated(req) {
  const authorization = String(req.headers.authorization || '');
  if (!authorization.startsWith('Bearer ')) {
    const error = new Error('Inicia sesión para continuar');
    error.statusCode = 401;
    throw error;
  }
  const token = authorization.slice('Bearer '.length).trim();
  try {
    const decoded = await firebaseAuth.verifyIdToken(token);
    return {
      uid: decoded.uid,
      email: String(decoded.email || '').trim().toLowerCase()
    };
  } catch {
    const error = new Error('La sesión no es válida o ya venció');
    error.statusCode = 401;
    throw error;
  }
}

// POST /stripe/webhook · necesita raw body (sin JSON parser) para verificar firma
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = verifyWebhookSignature(req.body, sig);
  } catch (err) {
    console.error('⚠️  Webhook signature invalid:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    await processWebhookEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error('❌ Error procesando webhook:', err);
    res.status(500).send('Error interno');
  }
});

// POST /stripe/checkout · crea sesión Embedded Checkout → clientSecret
router.post('/checkout', express.json(), async (req, res) => {
  try {
    const { uid, email } = await authenticated(req);
    const { plan } = req.body;
    const result = await createCheckoutSession({ plan, uid, email });
    res.json(result);
  } catch (err) {
    console.error('❌ /stripe/checkout error:', err.message);
    res.status(err.statusCode || 400).json({ error: err.message, code: err.code });
  }
});

// GET /stripe/session/:id · estado de una sesión (página de éxito)
router.get('/session/:id', async (req, res) => {
  try {
    const identity = await authenticated(req);
    res.json(await retrieveSession(req.params.id, identity));
  } catch (err) {
    res.status(err.statusCode || 404).json({ error: err.message });
  }
});

// POST /stripe/cancel-subscription · cancela al final del periodo (usuario VIP)
router.post('/cancel-subscription', express.json(), async (req, res) => {
  try {
    const { uid, email } = await authenticated(req);
    res.json(await cancelarSuscripcion({ uid, email }));
  } catch (err) {
    console.error('❌ /stripe/cancel-subscription error:', err.message);
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

// POST /stripe/reactivate-subscription · revierte la cancelación programada
router.post('/reactivate-subscription', express.json(), async (req, res) => {
  try {
    const { uid, email } = await authenticated(req);
    res.json(await reactivarSuscripcion({ uid, email }));
  } catch (err) {
    console.error('❌ /stripe/reactivate-subscription error:', err.message);
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

// POST /stripe/create-billing-portal · portal de facturación de Stripe
router.post('/create-billing-portal', express.json(), async (req, res) => {
  try {
    const { uid, email } = await authenticated(req);
    res.json(await crearBillingPortal({ uid, email }));
  } catch (err) {
    console.error('❌ /stripe/create-billing-portal error:', err.message);
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

export default router;
