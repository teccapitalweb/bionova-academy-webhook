// ═══════════════════════════════════════════════════════════════════
// config/env.js · validación de variables de entorno
// Falla rápido si falta algo crítico en lugar de fallar en runtime
// ═══════════════════════════════════════════════════════════════════

const REQUIRED = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_MENSUAL',
  'STRIPE_PRICE_ANUAL',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_SERVICE_ACCOUNT'
];

const OPTIONAL = [
  'NEWSDATA_API_KEY',
  'RESEND_API_KEY',
  'MAIL_FROM',
  'CRON_SECRET',
  'PANEL_URL',
  'PORT'
];

export function validateEnv() {
  const missing = REQUIRED.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('❌ Variables de entorno faltantes:', missing.join(', '));
    console.error('   Configúralas en Railway → Settings → Variables');
    process.exit(1);
  }

  const missingOptional = OPTIONAL.filter(k => !process.env[k]);
  if (missingOptional.length) {
    console.warn('⚠️  Variables opcionales no configuradas:', missingOptional.join(', '));
    console.warn('   Algunas features estarán deshabilitadas (cron noticias, correo, etc.)');
  }

  console.log('✅ Variables de entorno validadas');
}

export const env = {
  stripeSecret: process.env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  stripePriceMensual: process.env.STRIPE_PRICE_MENSUAL,
  stripePriceAnual: process.env.STRIPE_PRICE_ANUAL,
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID || 'bionova-academy',
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT,
  newsdataApiKey: process.env.NEWSDATA_API_KEY,
  resendApiKey: process.env.RESEND_API_KEY,
  mailFrom: process.env.MAIL_FROM || 'BioNova <noreply@bionovamexico.com>',
  cronSecret: process.env.CRON_SECRET || 'bionova-secret-britney-2026',
  panelUrl: process.env.PANEL_URL || 'https://www.bionovamexico.com',
  port: parseInt(process.env.PORT || '3000', 10)
};
