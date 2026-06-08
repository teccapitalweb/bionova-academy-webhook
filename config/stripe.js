// ═══════════════════════════════════════════════════════════════════
// config/stripe.js · inicialización del cliente Stripe
// ═══════════════════════════════════════════════════════════════════
import Stripe from 'stripe';
import { env } from './env.js';

export const stripe = new Stripe(env.stripeSecret, {
  apiVersion: '2024-06-20'
});

export const STRIPE_CONFIG = {
  webhookSecret: env.stripeWebhookSecret,
  priceMensual: env.stripePriceMensual,
  priceAnual: env.stripePriceAnual,
  panelUrl: env.panelUrl
};

// Esta cuenta de Stripe es COMPARTIDA con otras plataformas (IMDIIL, OdonTeck…).
// El webhook filtra por metadata.source para no cruzar pagos. Ver services/stripe.js
export const SOURCE = 'bionova';

// Detecta LIVE tanto con secret key (sk_live_) como restricted key (rk_live_)
const esLive = env.stripeSecret.startsWith('sk_live_')
  || env.stripeSecret.startsWith('rk_live_');
console.log('✅ Stripe inicializado · modo:', esLive ? 'LIVE' : 'TEST', '· source:', SOURCE);
