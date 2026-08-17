// ═══════════════════════════════════════════════════════════════════
// BioNova VIP · Webhook Stripe + cron NewsData
// Entry point: arma Express, carga rutas, programa cron, escucha.
//
//   config/    · inicialización de servicios externos
//   services/  · lógica de negocio (Stripe, Firestore, NewsData, email)
//   routes/    · endpoints HTTP
//
// Cuenta Stripe COMPARTIDA → filtro metadata.source === 'bionova'.
// Ver README.md para deploy en Railway.
// ═══════════════════════════════════════════════════════════════════

import express from 'express';
import cors from 'cors';
import cron from 'node-cron';

// Validar env vars ANTES de inicializar nada
import { validateEnv, env } from './config/env.js';
validateEnv();

// Inicializar servicios externos (imports con side-effects)
import './config/firebase.js';
import './config/stripe.js';

// Routes
import stripeRoutes from './routes/stripe.js';
import membershipRoutes from './routes/membership.js';
import newsRoutes from './routes/news.js';
import healthRoutes from './routes/health.js';
import adminRoutes from './routes/admin.js';
import bunnyRoutes from './routes/bunny.js';

// Cron
import { syncNewsData } from './services/news.js';

const app = express();
app.use(cors({ origin: true, credentials: true }));

// IMPORTANTE: /stripe va PRIMERO porque /stripe/webhook necesita raw body.
// El propio router maneja el raw body solo para ese endpoint.
app.use('/stripe', stripeRoutes);

// El resto sí puede usar express.json globalmente
app.use(express.json());
app.use('/membership', membershipRoutes);
app.use('/noticias', newsRoutes);
app.use('/admin', adminRoutes);
app.use('/api/bunny', bunnyRoutes);
app.use('/', healthRoutes);

// Cron: todos los días 7am CDMX (= 13:00 UTC)
cron.schedule('0 13 * * *', () => {
  console.log('⏰ Cron diario noticias · 7am CDMX');
  syncNewsData().catch(e => console.error('Cron error:', e));
}, { timezone: 'UTC' });

app.listen(env.port, () => {
  console.log(`🚀 BioNova webhook listening on port ${env.port}`);
  console.log('   Endpoints:');
  console.log('     POST /stripe/webhook                · recibe eventos Stripe');
  console.log('     POST /stripe/checkout               · crea sesión Embedded Checkout');
  console.log('     GET  /stripe/session/:id            · consulta sesión');
  console.log('     POST /stripe/cancel-subscription    · cancela (fin de periodo)');
  console.log('     POST /stripe/reactivate-subscription· reactiva');
  console.log('     POST /stripe/create-billing-portal  · portal de facturación');
  console.log('     GET  /membership/:uid               · paywall');
  console.log('     POST /admin/activar-manual          · activa/regala (admin)');
  console.log('     POST /admin/cancelar-stripe         · cancela suscripción (admin)');
  console.log('     POST /admin/eliminar-miembro        · borra miembro (admin)');
  console.log('     POST /api/bunny/embed-token         · reproductor Bunny protegido');
  console.log('     GET  /noticias/sync?secret=         · cron manual');
  console.log('     GET  /test-correo?to=               · prueba de correo');
  console.log('     GET  /health                        · health check');
});
