// ═══════════════════════════════════════════════════════════════════
// services/stripe.js · handlers de eventos de Stripe
// Cada función procesa un tipo específico de evento del webhook
// ═══════════════════════════════════════════════════════════════════

import { stripe, STRIPE_CONFIG, SOURCE } from '../config/stripe.js';
import {
  upsertMiembro, updateMiembroBySubscription, registrarPago,
  buscarMiembro, marcarCancelacionProgramada, marcarReactivacion
} from './firestore.js';
import { enviarBienvenida } from './email.js';

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
  const customerId = session.customer;
  const subscriptionId = session.subscription;
  const plan = session.metadata?.plan || 'desconocido';

  if (!uid && !email) {
    console.warn('⚠️  Checkout sin uid ni email · session:', session.id);
    return;
  }

  // Período de renovación
  let periodoFin = null;
  if (subscriptionId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      periodoFin = new Date(sub.current_period_end * 1000);
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

  const docId = await updateMiembroBySubscription(subId, {
    activa,
    estado: status,
    cancelaAlFinal: !!subscription.cancel_at_period_end,
    fechaProximaRenovacion: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000) : null
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
  if (!invoice.subscription) return;
  // Solo registramos si la suscripción es nuestra (existe en miembros)
  const docId = await updateMiembroBySubscription(invoice.subscription, {});
  if (!docId) { console.log('⏭️  Invoice de otro proyecto · ignorado'); return; }

  await registrarPago({
    invoiceId: invoice.id,
    subscriptionId: invoice.subscription,
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
  if (!invoice.subscription) return;
  const docId = await updateMiembroBySubscription(invoice.subscription, {});
  if (!docId) return;

  await registrarPago({
    invoiceId: invoice.id,
    subscriptionId: invoice.subscription,
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
export async function createCheckoutSession({ plan, uid, email }) {
  if (!['mensual', 'anual'].includes(plan)) {
    throw new Error('Plan inválido (debe ser mensual o anual)');
  }
  const price = plan === 'mensual' ? STRIPE_CONFIG.priceMensual : STRIPE_CONFIG.priceAnual;
  if (!price) throw new Error('Stripe price IDs no configurados');

  const session = await stripe.checkout.sessions.create({
    ui_mode: 'embedded',
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    allow_promotion_codes: true,                       // campo de cupón en el checkout
    client_reference_id: uid || undefined,
    customer_email: email || undefined,
    metadata: { plan, uid: uid || '', source: SOURCE }, // ← marca de proyecto
    subscription_data: {
      metadata: { plan, uid: uid || '', source: SOURCE }
    },
    return_url: `${STRIPE_CONFIG.panelUrl}/vip-panel.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    locale: 'es-419',
    payment_method_types: ['card']
  });

  return { clientSecret: session.client_secret, sessionId: session.id };
}

export async function retrieveSession(sessionId) {
  const s = await stripe.checkout.sessions.retrieve(sessionId);
  return {
    status: s.status,
    payment_status: s.payment_status,
    customer_email: s.customer_details?.email,
    plan: s.metadata?.plan
  };
}

// helper a prueba de balas: localiza el subId de un miembro;
// si no lo tiene guardado, lo busca en Stripe por customerId.
async function resolverSubId(data) {
  let subId = data.stripeSubscriptionId || data.subscriptionId || null;
  if (subId) return subId;
  const customerId = data.stripeCustomerId || data.customerId;
  if (customerId) {
    try {
      const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 1 });
      if (subs.data.length) subId = subs.data[0].id;
    } catch (e) {
      console.warn('⚠️  No se pudo listar suscripciones por customer:', e.message);
    }
  }
  return subId;
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

  const finAcceso = sub.current_period_end
    ? new Date(sub.current_period_end * 1000)
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

  const proxRenov = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString() : null;
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
