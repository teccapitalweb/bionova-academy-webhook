// ═══════════════════════════════════════════════════════════════════
// services/firestore.js · operaciones sobre /miembros, /pagos, /noticias_auto
// Capa que aísla cualquier acceso a Firestore
// ═══════════════════════════════════════════════════════════════════

import { db, FieldValue, Timestamp } from '../config/firebase.js';
import { SOURCE } from '../config/stripe.js';

// ───────────────────────────────────────────────────────────────
// MODIFICADO · /config/club · precios EDITABLES (patrón SYNOVA)
// La única fuente de verdad del precio: la edita vip-admin.html y
// la leen vip-auth, vip-panel, index y ESTE webhook para armar el
// cobro real en Stripe con price_data dinámico.
// ───────────────────────────────────────────────────────────────
export async function leerPreciosConfig() {
  const snap = await db.collection('config').doc('club').get();
  const c = snap.exists ? snap.data() : {};
  const precioMes = Number(c.precioMes) > 0 ? Number(c.precioMes) : 199;
  const precioAno = Number(c.precioAno) > 0 ? Number(c.precioAno) : 1999;
  return { precioMes, precioAno };
}

// ───────────────────────────────────────────────────────────────
// /miembros · CRUD
// ───────────────────────────────────────────────────────────────

/**
 * Crea o actualiza un documento de miembro al completar el pago.
 * El ID del doc es el uid de Firebase Auth (preferente) o un id derivado del email
 * (cuando el pago no trae uid). El campo `uid` y `email` siempre se guardan para
 * poder localizar al usuario después aunque el docId sea "email_xxx".
 */
export async function upsertMiembro({
  uid, email, plan, customerId, subscriptionId, periodoFin
}) {
  const docId = uid || ('email_' + (email || '').replace(/[^a-z0-9]/gi, '_'));
  const data = {
    uid: uid || null,
    email: (email || '').toLowerCase(),
    plan,
    activa: true,
    esRegalo: false,
    source: SOURCE,
    stripeCustomerId: customerId || null,
    stripeSubscriptionId: subscriptionId || null,
    cancelaAlFinal: false,
    fechaAlta: FieldValue.serverTimestamp(),
    fechaProximaRenovacion: periodoFin ? Timestamp.fromDate(periodoFin) : null,
    updatedAt: FieldValue.serverTimestamp()
  };
  await db.collection('miembros').doc(docId).set(data, { merge: true });
  return docId;
}

/**
 * Actualiza el estado de un miembro a partir del subscriptionId
 * (usado cuando Stripe notifica cambios en la suscripción).
 */
export async function updateMiembroBySubscription(subscriptionId, changes) {
  const snap = await db.collection('miembros')
    .where('stripeSubscriptionId', '==', subscriptionId)
    .limit(1).get();
  if (snap.empty) return null;

  const docRef = snap.docs[0].ref;
  await docRef.update({
    ...changes,
    updatedAt: FieldValue.serverTimestamp()
  });
  return docRef.id;
}

/**
 * Consulta el estado de membresía de un uid. Usado por el paywall del panel.
 * Considera vigencia: si expiraEn ya pasó (regalos/activación manual), no está activa.
 */
export async function getMembership(uid) {
  const doc = await db.collection('miembros').doc(uid).get();
  if (!doc.exists) return { activa: false, activo: false, motivo: 'sin-membresia' };

  const data = doc.data();
  let activa = !!data.activa;

  // Vigencia para regalos / activación manual (tienen expiraEn pero no suscripción Stripe)
  const expira = data.expiraEn?.toDate?.();
  if (activa && expira && expira.getTime() < Date.now()) {
    activa = false;
  }

  return {
    activa,
    activo: activa,                       // alias por compat
    plan: data.plan || null,
    esRegalo: !!data.esRegalo,
    estado: data.estado || null,
    cancelaAlFinal: !!data.cancelaAlFinal,
    proximaRenovacion: data.fechaProximaRenovacion?.toDate?.()?.toISOString() || null,
    expiraEn: expira ? expira.toISOString() : null
  };
}

/**
 * Busca el documento de un miembro por uid (docId), por campo uid, o por email.
 * A prueba de balas: cubre el caso de docs guardados como "email_xxx".
 * Devuelve { ref, data } o null.
 */
export async function buscarMiembro({ uid, email }) {
  // 1) por docId = uid
  if (uid) {
    const doc = await db.collection('miembros').doc(uid).get();
    if (doc.exists) return { ref: doc.ref, data: doc.data() };
    // 2) por campo uid (cuando el docId es "email_xxx")
    const byUid = await db.collection('miembros').where('uid', '==', uid).limit(1).get();
    if (!byUid.empty) return { ref: byUid.docs[0].ref, data: byUid.docs[0].data() };
  }
  // 3) por email
  if (email) {
    const snap = await db.collection('miembros')
      .where('email', '==', email.toLowerCase())
      .limit(1).get();
    if (!snap.empty) return { ref: snap.docs[0].ref, data: snap.docs[0].data() };
  }
  return null;
}

export async function marcarCancelacionProgramada(ref, finAcceso) {
  await ref.update({
    cancelaAlFinal: true,
    cancelacionProgramada: true,
    fechaFinAcceso: finAcceso ? Timestamp.fromDate(finAcceso) : null,
    updatedAt: FieldValue.serverTimestamp()
  });
}

export async function marcarReactivacion(ref) {
  await ref.update({
    cancelaAlFinal: false,
    cancelacionProgramada: false,
    fechaFinAcceso: null,
    updatedAt: FieldValue.serverTimestamp()
  });
}

// ───────────────────────────────────────────────────────────────
// /pagos · historial de cobros
// ───────────────────────────────────────────────────────────────

export async function registrarPago({
  invoiceId, subscriptionId, customerId, email, monto, moneda, estado, fechaPago
}) {
  await db.collection('pagos').doc(invoiceId).set({
    invoiceId,
    subscriptionId,
    customerId,
    source: SOURCE,
    email: (email || '').toLowerCase(),
    monto,
    moneda: (moneda || 'mxn').toUpperCase(),
    estado,
    fechaPago: fechaPago ? Timestamp.fromDate(fechaPago) : FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

// ───────────────────────────────────────────────────────────────
// /noticias_auto · guardar noticias del cron
// ───────────────────────────────────────────────────────────────

export async function guardarNoticia({
  id, titulo, extracto, link, fuente, imagen, categoria, categoriaNombre, color, fechaPublicacion
}) {
  await db.collection('noticias_auto').doc(id).set({
    id, titulo, extracto, link, fuente, imagen, categoria,
    categoriaNombre: categoriaNombre || categoria,
    color,
    fechaPublicacion: fechaPublicacion ? Timestamp.fromDate(fechaPublicacion) : FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

export async function getUltimaNoticia() {
  const snap = await db.collection('noticias_auto')
    .orderBy('createdAt', 'desc').limit(1).get();
  if (snap.empty) return null;
  return {
    ...snap.docs[0].data(),
    createdAt: snap.docs[0].data().createdAt?.toDate?.()?.toISOString() || null
  };
}

export async function borrarNoticiasViejas(dias = 15) {
  const limite = new Date(Date.now() - dias * 86400000);
  const snap = await db.collection('noticias_auto')
    .where('createdAt', '<', Timestamp.fromDate(limite)).get();
  if (snap.empty) return 0;
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  return snap.size;
}
