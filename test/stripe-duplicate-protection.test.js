import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const service = fs.readFileSync(new URL('../services/stripe.js', import.meta.url), 'utf8');
const route = fs.readFileSync(new URL('../routes/stripe.js', import.meta.url), 'utf8');

test('BIONOVA autentica la identidad y bloquea otra suscripción antes del checkout', () => {
  assert.match(route, /firebaseAuth\.verifyIdToken\(token\)/);
  assert.doesNotMatch(route, /const \{ plan, uid, email \} = req\.body/);
  const check = service.indexOf('listarSuscripcionesStripeBionova(');
  const create = service.indexOf('stripe.checkout.sessions.create({');
  assert.ok(check >= 0 && create > check);
  assert.match(service, /stripe\.customers\.list\(\{ email: normalizedEmail, limit: 20 \}\)/);
  assert.match(service, /STRIPE_SUBSCRIPTION_BLOCKING_STATUSES/);
  assert.match(service, /duplicate-subscriptions-detected/);
  assert.match(service, /subscription-already-exists/);
  assert.match(service, /bionova-checkout-v3-/);
});

test('BIONOVA reconoce renovaciones modernas y reconcilia el acceso local', () => {
  assert.match(service, /function subscriptionPeriodEnd\(subscription\)/);
  assert.match(service, /subscription\?\.items\?\.data/);
  assert.match(service, /function invoiceSubscriptionId\(invoice\)/);
  assert.match(service, /invoice\?\.parent\?\.subscription_details\?\.subscription/);
  assert.match(service, /case 'invoice\.paid':/);
  assert.match(service, /case 'invoice\.payment_succeeded':/);
  const paid = service.slice(service.indexOf('export async function handleInvoicePaid'), service.indexOf('export async function handleInvoiceFailed'));
  assert.match(paid, /updateMiembroBySubscription\(subscriptionId/);
  assert.match(paid, /upsertMiembro/);
  assert.match(paid, /subscriptionPeriodEnd\(sub\)/);
});
