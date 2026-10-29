// ═══════════════════════════════════════════════════════════════════
// services/stripe.js · handlers de eventos de Stripe
// Cada función procesa un tipo específico de evento del webhook
// ═══════════════════════════════════════════════════════════════════

import { stripe, STRIPE_CONFIG, SOURCE } from '../config/stripe.js';
import {
  upsertMiembro, updateMiembroBySubscription, registrarPago,
  buscarMiembro, marcarCancelacionProgramada, marcarReactivacion,
  leerPreciosConfig
} from './firestore.js';
import { enviarBienvenida } from './email.js';
import crypto from 'node:crypto';

const STRIPE_SUBSCRIPTION_BLOCKING_STATUSES = new Set([
  'incomplete', 'active', 'trialing', 'past_due', 'unpaid', 'paused'
]);

function stripeId(value) {
  return typeof value === 'string' ? value : (value && typeof value.id === 'string' ? value.id : '');
}

function checkoutIdentityKey(email, uid) {
  const identity = String(email || uid || '').trim().toLowerCase();
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
}

function subscriptionPeriodEnd(subscription) {
  const direct = Number(subscription?.current_period_end);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return Math.max(0, ...(subscription?.items?.data || []).map(item => Number(item?.current_period_end) || 0));
}

function invoiceSubscriptionId(invoice) {
  return stripeId(invoice?.subscription)
    || stripeId(invoice?.parent?.subscription_details?.subscription);
}

async function listarSuscripcionesStripeBionova(email, customerIds = [], knownSubscriptionIds = []) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const ids = new Set((customerIds || []).map(stripeId).filter(Boolean));
  const knownIds = new Set((knownSubscriptionIds || []).map(stripeId).filter(Boolean));
  if (normalizedEmail) {
    const customers = await stripe.customers.list({ email: normalizedEmail, limit: 20 });
    (customers.data || []).forEach(customer => ids.add(customer.id));
  }
  const matches = new Map();
  for (const customerId of ids) {
    const list = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    (list.data || []).forEach(subscription => {
      if (esSubBionova(subscription) || knownIds.has(subscription.id)) matches.set(subscription.id, subscription);
    });
  }
  return Array.from(matches.values());
}

// ───────────────────────────────────────────────────────────────
// checkout.session.completed → activa la membresía en Firestore.
// ───────────────────────────────────────────────────────────────
export async function handleCheckoutCompleted(session) {
  // ⚠️ FILTRO MULTI-PROYECTO: esta cuenta Stripe es compartida por varios
  // proyectos (IMDIIL, OdonTeck, etc.). Solo procesamos pagos de BioNova.
  // Si el pago trae un source de OTRO proyecto, lo ignoramos para no activar
  // miembros ni mandar correos cruzados.
  const src = session.metadata?.source || '';
  if (src !== SOURCE) {
    console.log(`⏭️  Ignorado: pago de otro proyecto (source="${src}", esperaba "${SOURCE}")`);
    return;
  }

  const uid = session.client_reference_id || session.metadata?.uid;
  const email = session.customer_email || session.customer_details?.email;
  let customerId = session.customer;
  let subscriptionId = session.subscription;
  const plan = session.metadata?.plan || 'desconocido';

  // Cupón 100% / total $0: el evento puede llegar SIN customer/subscription.
  // Los resolvemos desde Stripe para poder cancelar después.
  if (!customerId && email) {
    try {
      const cust = await stripe.customers.list({ email: email.toLowerCase(), limit: 1 });
      if (cust.data.length) customerId = cust.data[0].id;
    } catch (e) { console.warn('⚠️  No se pudo resolver customer por email:', e.message); }
  }
  if (!subscriptionId && customerId) {
    subscriptionId = await subIdBionovaDeCustomer(customerId) || subscriptionId;
  }

  if (!uid && !email) {
    console.warn('⚠️  Checkout sin uid ni email · session:', session.id);
    return;
  }

  // Período de renovación
  let periodoFin = null;
  if (subscriptionId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      const periodEndSeconds = subscriptionPeriodEnd(sub);
      if (periodEndSeconds) periodoFin = new Date(periodEndSeconds * 1000);
    } catch (e) {
      console.warn('⚠️  No pudimos obtener detalles de suscripción:', e.message);
    }
  }

  const docId = await upsertMiembro({ uid, email, plan, customerId, subscriptionId, periodoFin });
  console.log('✅ Miembro activado:', docId, '·', plan, '·', email);

  // Correo de bienvenida (no bloquea ni truena el webhook si falla / no hay key)
  try {
    const nombre = session.customer_details?.name || (email ? email.split('@')[0] : '');
    await enviarBienvenida({ to: email, nombre, plan });
  } catch (e) {
    console.warn('⚠️  No se pudo enviar correo de bienvenida:', e.message);
  }
}

// ───────────────────────────────────────────────────────────────
// customer.subscription.updated / deleted
// ───────────────────────────────────────────────────────────────
export async function handleSubscriptionChange(subscription) {
  const subId = subscription.id;
  const status = subscription.status;
  const activa = ['active', 'trialing'].includes(status);
  const periodEndSeconds = subscriptionPeriodEnd(subscription);

  const docId = await updateMiembroBySubscription(subId, {
    activa,
    activo: activa,
    estado: status,
    cancelaAlFinal: !!subscription.cancel_at_period_end,
    cancelacionProgramada: !!subscription.cancel_at_period_end,
    fechaProximaRenovacion: periodEndSeconds
      ? new Date(periodEndSeconds * 1000) : null,
    fechaFinAcceso: subscription.cancel_at_period_end && periodEndSeconds
      ? new Date(periodEndSeconds * 1000) : null
  });

  if (!docId) {
    // Si no existe en nuestra colección, es de otro proyecto: lo ignoramos.
    console.log('⏭️  Suscripción cambió pero no es de BioNova:', subId);
    return;
  }
  console.log('🔄 Suscripción actualizada:', docId, '·', status, '· activa:', activa);
}

// ───────────────────────────────────────────────────────────────
// invoice.payment_succeeded / failed
// ───────────────────────────────────────────────────────────────
export async function handleInvoicePaid(invoice) {
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) return;
  const sub = await stripe.subscriptions.retrieve(subscriptionId).catch(() => null);
  if (!sub || !esSubBionova(sub)) {
    console.log('⏭️  Invoice de otro proyecto · ignorado');
    return;
  }
  const periodEndSeconds = subscriptionPeriodEnd(sub);
  const changes = sub ? {
    activa: ['active', 'trialing'].includes(sub.status),
    activo: ['active', 'trialing'].includes(sub.status),
    estado: sub.status,
    cancelaAlFinal: sub.cancel_at_period_end === true,
    cancelacionProgramada: sub.cancel_at_period_end === true,
    fechaProximaRenovacion: periodEndSeconds
      ? new Date(periodEndSeconds * 1000) : null,
    fechaFinAcceso: sub.cancel_at_period_end && periodEndSeconds
      ? new Date(periodEndSeconds * 1000) : null
  } : {};
  let docId = await updateMiembroBySubscription(subscriptionId, changes);
  if (!docId && sub) {
    const uid = String(sub.metadata?.uid || '');
    const email = String(invoice.customer_email || '').trim().toLowerCase();
    const hit = await buscarMiembro({ uid, email });
    if (hit) {
      await hit.ref.set({
        ...changes,
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId: stripeId(invoice.customer || sub.customer),
        updatedAt: new Date()
      }, { merge: true });
      docId = hit.ref.id;
    } else if ((uid || email) && changes.activa) {
      docId = await upsertMiembro({
        uid,
        email,
        plan: sub.metadata?.plan || 'mensual',
        customerId: stripeId(invoice.customer || sub.customer),
        subscriptionId,
        periodoFin: periodEndSeconds ? new Date(periodEndSeconds * 1000) : null
      });
    }
  }
  if (!docId) { console.log('⏭️  Invoice de otro proyecto · ignorado'); return; }

  await registrarPago({
    invoiceId: invoice.id,
    subscriptionId,
    customerId: invoice.customer,
    email: invoice.customer_email,
    monto: (invoice.amount_paid || 0) / 100,
    moneda: invoice.currency,
    estado: 'pagado',
    fechaPago: invoice.status_transitions?.paid_at
      ? new Date(invoice.status_transitions.paid_at * 1000) : new Date()
  });
  console.log('💰 Pago registrado:', invoice.id, '·', (invoice.amount_paid / 100), invoice.currency);
}

export async function handleInvoiceFailed(invoice) {
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) return;
  const docId = await updateMiembroBySubscription(subscriptionId, {});
  if (!docId) return;

  await registrarPago({
    invoiceId: invoice.id,
    subscriptionId,
    customerId: invoice.customer,
    email: invoice.customer_email,
    monto: (invoice.amount_due || 0) / 100,
    moneda: invoice.currency,
    estado: 'fallido',
    fechaPago: new Date()
  });
  console.log('⚠️  Pago falló:', invoice.id);
}

// ───────────────────────────────────────────────────────────────
// Crear sesión de Embedded Checkout (con cupones)
// ───────────────────────────────────────────────────────────────
// MODIFICADO (patrón SYNOVA): en vez de un Price ID fijo, arma el precio en
// el momento leyendo config/club — cambiar el precio en vip-admin cambia el
// cobro real desde la siguiente suscripción, sin tocar Stripe ni Railway.
export async function createCheckoutSession({ plan, uid, email }) {
  if (!['mensual', 'anual'].includes(plan)) {
    throw new Error('Plan inválido (debe ser mensual o anual)');
  }
  const { precioMes, precioAno } = await leerPreciosConfig();
  const montoMXN = plan === 'mensual' ? precioMes : precioAno;
  const interval = plan === 'mensual' ? 'month' : 'year';
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const memberHit = await buscarMiembro({ uid, email: normalizedEmail });
  const subscriptions = await listarSuscripcionesStripeBionova(
    normalizedEmail,
    [memberHit?.data?.stripeCustomerId, memberHit?.data?.customerId],
    [memberHit?.data?.stripeSubscriptionId, memberHit?.data?.subscriptionId]
  );
  const blockingSubscriptions = subscriptions.filter(subscription => (
    STRIPE_SUBSCRIPTION_BLOCKING_STATUSES.has(subscription.status)
  ));
  if (blockingSubscriptions.length) {
    const error = new Error('Ya existe una suscripción de BioNova en Stripe. No abrimos otro cobro.');
    error.statusCode = 409;
    error.code = blockingSubscriptions.length > 1
      ? 'duplicate-subscriptions-detected'
      : 'subscription-already-exists';
    throw error;
  }

  const session = await stripe.checkout.sessions.create({
    ui_mode: 'embedded',
    mode: 'subscription',
    line_items: [{
      price_data: {
        currency: 'mxn',
        unit_amount: Math.round(montoMXN * 100),
        recurring: { interval },
        product_data: {
          name: `BioNova VIP · Plan ${plan === 'mensual' ? 'Mensual' : 'Anual'}`,
          metadata: { plan, source: SOURCE }
        }
      },
      quantity: 1
    }],
    allow_promotion_codes: true,                       // campo de cupón en el checkout
    client_reference_id: uid || undefined,
    customer_email: normalizedEmail || undefined,
    metadata: { plan, uid: uid || '', source: SOURCE, precioAlCobrar: String(montoMXN) }, // ← marca de proyecto
    subscription_data: {
      metadata: { plan, uid: uid || '', source: SOURCE }
    },
    return_url: `${STRIPE_CONFIG.panelUrl}/vip-panel.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    locale: 'es-419',
    payment_method_types: ['card']
  }, {
    idempotencyKey: `bionova-checkout-v3-${checkoutIdentityKey(normalizedEmail, uid)}-${plan}-${new Date().toISOString().slice(0, 10)}`
  });

  return { clientSecret: session.client_secret, sessionId: session.id };
}

export async function retrieveSession(sessionId, identity = {}) {
  const s = await stripe.checkout.sessions.retrieve(sessionId);
  const ownerUid = String(s.client_reference_id || s.metadata?.uid || '');
  const ownerEmail = String(s.customer_details?.email || s.customer_email || '').trim().toLowerCase();
  const requesterUid = String(identity.uid || '');
  const requesterEmail = String(identity.email || '').trim().toLowerCase();
  if (!requesterUid || (ownerUid ? ownerUid !== requesterUid : (!requesterEmail || ownerEmail !== requesterEmail))) {
    const error = new Error('No autorizado para consultar esta sesión');
    error.statusCode = 403;
    throw error;
  }
  return {
    status: s.status,
    payment_status: s.payment_status,
    customer_email: s.customer_details?.email,
    plan: s.metadata?.plan
  };
}

// helper a prueba de balas: localiza el subId de un miembro;
// si no lo tiene guardado, lo busca en Stripe por customerId.
// ¿Esta suscripción es de BioNova? Por etiqueta source O por su precio.
// (La cuenta de Stripe es compartida entre consultoras; con cupón 100% el
//  metadata.source puede no quedar, así que el precio es el identificador firme.)
// NOTA MIGRACIÓN: las suscripciones nuevas usan price_data dinámico (sin Price
// ID fijo) pero SIEMPRE llevan metadata.source en subscription_data, así que
// pasan por la primera condición. El chequeo por Price ID queda solo para
// suscripciones viejas creadas antes de la migración.
function esSubBionova(s) {
  if ((s.metadata?.source || '') === SOURCE) return true;
  const ids = [STRIPE_CONFIG.priceMensual, STRIPE_CONFIG.priceAnual].filter(Boolean);
  return (s.items?.data || []).some(it => ids.includes(it.price?.id));
}

async function subIdBionovaDeCustomer(customerId) {
  if (!customerId) return null;
  try {
    const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
    const vivas = subs.data.filter(s => !['canceled', 'incomplete_expired'].includes(s.status));
    const bio = vivas.find(esSubBionova) || subs.data.find(esSubBionova) || vivas[0] || null;
    return bio ? bio.id : null;
  } catch (e) {
    console.warn('⚠️  No se pudo listar suscripciones por customer:', e.message);
    return null;
  }
}

async function resolverSubId(data) {
  let subId = data.stripeSubscriptionId || data.subscriptionId || null;
  if (subId) return subId;
  let customerId = data.stripeCustomerId || data.customerId;
  // Sin customer guardado (p.ej. activado con cupón 100%): búscalo por email.
  if (!customerId && data.email) {
    try {
      const cust = await stripe.customers.list({ email: data.email, limit: 1 });
      if (cust.data.length) customerId = cust.data[0].id;
    } catch (e) {
      console.warn('⚠️  No se pudo resolver customer por email:', e.message);
    }
  }
  return await subIdBionovaDeCustomer(customerId);
}

// ───────────────────────────────────────────────────────────────
// Cancelar suscripción (al final del periodo, conserva acceso)
// ───────────────────────────────────────────────────────────────
export async function cancelarSuscripcion({ uid, email }) {
  const miembro = await buscarMiembro({ uid, email });
  if (!miembro) throw new Error('No encontramos tu membresía');

  const subId = await resolverSubId(miembro.data);
  if (!subId) throw new Error('No hay suscripción activa que cancelar');

  const sub = await stripe.subscriptions.update(subId, { cancel_at_period_end: true });

  const periodEndSeconds = subscriptionPeriodEnd(sub);
  const finAcceso = periodEndSeconds
    ? new Date(periodEndSeconds * 1000)
    : (miembro.data.fechaProximaRenovacion?.toDate?.() || null);

  await marcarCancelacionProgramada(miembro.ref, finAcceso);
  return { finAcceso: finAcceso ? finAcceso.toISOString() : null };
}

// ───────────────────────────────────────────────────────────────
// Reactivar suscripción (revierte cancelación programada)
// ───────────────────────────────────────────────────────────────
export async function reactivarSuscripcion({ uid, email }) {
  const miembro = await buscarMiembro({ uid, email });
  if (!miembro) throw new Error('No encontramos tu membresía');

  const subId = await resolverSubId(miembro.data);
  if (!subId) throw new Error('No hay suscripción que reactivar');

  const sub = await stripe.subscriptions.update(subId, { cancel_at_period_end: false });
  await marcarReactivacion(miembro.ref);

  const periodEndSeconds = subscriptionPeriodEnd(sub);
  const proxRenov = periodEndSeconds
    ? new Date(periodEndSeconds * 1000).toISOString() : null;
  return { reactivada: true, proximaRenovacion: proxRenov };
}

// ───────────────────────────────────────────────────────────────
// Portal de facturación de Stripe (cambiar tarjeta, ver facturas)
// ───────────────────────────────────────────────────────────────
export async function crearBillingPortal({ uid, email }) {
  const miembro = await buscarMiembro({ uid, email });
  if (!miembro) throw new Error('No encontramos tu membresía');
  const customerId = miembro.data.stripeCustomerId || miembro.data.customerId;
  if (!customerId) throw new Error('No hay cliente de Stripe asociado');

  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${STRIPE_CONFIG.panelUrl}/vip-panel.html`
  });
  return { url: portal.url };
}

// ───────────────────────────────────────────────────────────────
// Verificar firma del webhook (seguridad)
// ───────────────────────────────────────────────────────────────
export function verifyWebhookSignature(rawBody, signature) {
  return stripe.webhooks.constructEvent(rawBody, signature, STRIPE_CONFIG.webhookSecret);
}

// ───────────────────────────────────────────────────────────────
// Dispatcher de eventos
// ───────────────────────────────────────────────────────────────
export async function processWebhookEvent(event) {
  console.log('📥 Stripe event:', event.type, '·', event.id);
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object); break;
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await handleSubscriptionChange(event.data.object); break;
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      await handleInvoicePaid(event.data.object); break;
    case 'invoice.payment_failed':
      await handleInvoiceFailed(event.data.object); break;
    default:
      console.log('   (sin handler para este evento)');
  }
}

// helper público para que admin.js resuelva subId a prueba de balas
export { resolverSubId };
