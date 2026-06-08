// ═══════════════════════════════════════════════════════════════════
// routes/admin.js · endpoints protegidos para el panel admin BioNova
//
//   POST /admin/activar-manual    · activa Mensual/Anual o regala días
//   POST /admin/cancelar-stripe   · cancela suscripción en Stripe
//   POST /admin/eliminar-miembro  · cancela Stripe + borra Firestore + Auth
//
// Todos pasan por requireAdmin: verifica Firebase ID token + email admin.
// El admin NUNCA toca Firestore/Auth/Stripe desde el cliente: llama aquí
// con Authorization: Bearer <getIdToken()> y el backend hace el trabajo real.
// ═══════════════════════════════════════════════════════════════════

import express from 'express';
import admin from 'firebase-admin';
import { db, FieldValue, Timestamp } from '../config/firebase.js';
import { stripe } from '../config/stripe.js';
import { resolverSubId } from '../services/stripe.js';

const router = express.Router();

// Emails con permiso de administrar miembros (igual que ADMINS de vip-auth)
const ADMIN_EMAILS = [
  'teccapitalweb@gmail.com',
  'fisiotec25@gmail.com'
];

// ───────────────────────────────────────────────────────────────
// Middleware requireAdmin: verifica ID token y email admin
// ───────────────────────────────────────────────────────────────
async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: 'Falta token de admin' });

    const decoded = await admin.auth().verifyIdToken(token);
    const email = (decoded.email || '').toLowerCase();
    if (!ADMIN_EMAILS.includes(email)) {
      return res.status(403).json({ ok: false, error: 'No autorizado' });
    }
    req.admin = { uid: decoded.uid, email };
    next();
  } catch (e) {
    console.error('❌ requireAdmin:', e.message);
    return res.status(401).json({ ok: false, error: 'Token inválido o expirado' });
  }
}

function fechaEn(dias) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d;
}

// Localiza el doc del miembro a prueba de balas: docId, campo uid o email.
async function localizarDoc({ uid, email }) {
  if (uid) {
    const d = await db.collection('miembros').doc(uid).get();
    if (d.exists) return d;
    const byUid = await db.collection('miembros').where('uid', '==', uid).limit(1).get();
    if (!byUid.empty) return byUid.docs[0];
  }
  if (email) {
    const byMail = await db.collection('miembros').where('email', '==', email.toLowerCase()).limit(1).get();
    if (!byMail.empty) return byMail.docs[0];
  }
  return null;
}

// ───────────────────────────────────────────────────────────────
// POST /admin/activar-manual  body: { uid, plan, durationDays, esRegalo }
//   esRegalo:true  → regala durationDays días (3/7/10/30)
//   esRegalo:false → 'mensual' (30d, $199) o 'anual' (365d, $1999)
// Regalo y pago gozan EXACTAMENTE lo mismo (activa:true); difiere solo lo interno.
// ───────────────────────────────────────────────────────────────
router.post('/activar-manual', requireAdmin, async (req, res) => {
  try {
    const { uid, plan, durationDays, esRegalo } = req.body || {};
    if (!uid) return res.status(400).json({ ok: false, error: 'Falta uid' });

    let planFinal, dias, precio;
    if (esRegalo) {
      dias = Number(durationDays) || 0;
      if (dias <= 0) return res.status(400).json({ ok: false, error: 'durationDays inválido' });
      planFinal = 'regalo'; precio = 0;
    } else {
      if (!['mensual', 'anual'].includes(plan)) {
        return res.status(400).json({ ok: false, error: 'plan inválido' });
      }
      dias = plan === 'mensual' ? 30 : 365;
      precio = plan === 'mensual' ? 199 : 1999;   // precios reales BioNova
      planFinal = plan;
    }

    const ref = db.collection('miembros').doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: 'El miembro no existe en Firestore' });

    const vence = fechaEn(dias);
    await ref.set({
      activa: true,
      plan: planFinal,
      precio,
      esRegalo: !!esRegalo,
      source: 'bionova',
      duracionDias: dias,
      expiraEn: Timestamp.fromDate(vence),
      activacionManual: true,
      activadoPor: req.admin.email,
      fechaActivacionManual: FieldValue.serverTimestamp(),
      notificacionPendiente: {
        tipo: esRegalo ? 'bienvenida_regalo'
          : (planFinal === 'mensual' ? 'bienvenida_mensual' : 'bienvenida_anual'),
        dias,
        fecha: FieldValue.serverTimestamp(),
        mostrada: false
      }
    }, { merge: true });

    console.log(`✅ Activación manual · ${uid} · ${planFinal} · ${dias}d · por ${req.admin.email}`);
    return res.json({ ok: true, plan: planFinal, dias, vence: vence.toISOString() });
  } catch (e) {
    console.error('❌ activar-manual:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ───────────────────────────────────────────────────────────────
// POST /admin/cancelar-stripe  body: { uid, atPeriodEnd }
// ───────────────────────────────────────────────────────────────
router.post('/cancelar-stripe', requireAdmin, async (req, res) => {
  try {
    const { uid, atPeriodEnd } = req.body || {};
    if (!uid) return res.status(400).json({ ok: false, error: 'Falta uid' });

    const docSnap = await localizarDoc({ uid });
    if (!docSnap) return res.status(404).json({ ok: false, error: 'Miembro no existe' });
    const ref = docSnap.ref;
    const data = docSnap.data();

    const subId = await resolverSubId(data);   // a prueba de balas (sub o customer)

    if (subId) {
      if (atPeriodEnd) {
        await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
      } else {
        await stripe.subscriptions.cancel(subId);
      }
    } else {
      console.log(`ℹ️  ${uid} sin suscripción Stripe · cancelo solo en Firestore`);
    }

    if (atPeriodEnd && subId) {
      await ref.set({ cancelaAlFinal: true }, { merge: true });   // sigue activo hasta fin de periodo
    } else {
      await ref.set({ activa: false, cancelaAlFinal: false }, { merge: true });
    }

    console.log(`🚫 Cancelación · ${uid} · atPeriodEnd:${!!atPeriodEnd} · por ${req.admin.email}`);
    return res.json({ ok: true, atPeriodEnd: !!atPeriodEnd, teniaSub: !!subId });
  } catch (e) {
    console.error('❌ cancelar-stripe:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ───────────────────────────────────────────────────────────────
// POST /admin/eliminar-miembro  body: { uid }
// Cancela Stripe (si hay) → borra doc Firestore → borra usuario Auth.
// A PRUEBA DE BALAS: Auth por uid del doc → docId → email. No borra admins.
// ───────────────────────────────────────────────────────────────
router.post('/eliminar-miembro', requireAdmin, async (req, res) => {
  try {
    const { uid } = req.body || {};
    if (!uid) return res.status(400).json({ ok: false, error: 'Falta uid' });

    const docSnap = await localizarDoc({ uid });
    const data = docSnap ? docSnap.data() : {};
    const docId = docSnap ? docSnap.id : uid;
    const emailDoc = (data.email || '').toLowerCase();
    const uidDoc = data.uid || (docId.startsWith('email_') ? null : docId);

    // No permitir borrar a un admin
    let targetEmail = emailDoc;
    if (!targetEmail && uidDoc) {
      try { targetEmail = ((await admin.auth().getUser(uidDoc)).email || '').toLowerCase(); } catch {}
    }
    if (targetEmail && ADMIN_EMAILS.includes(targetEmail)) {
      return res.status(403).json({ ok: false, error: 'No se puede eliminar a un administrador' });
    }

    // 1) cancelar suscripción Stripe si existe (a prueba de balas)
    const subId = await resolverSubId(data);
    if (subId) {
      try { await stripe.subscriptions.cancel(subId); }
      catch (e) { console.warn('⚠️  No se pudo cancelar sub en Stripe:', e.message); }
    }

    // 2) borrar doc Firestore
    if (docSnap) await docSnap.ref.delete();

    // 3) borrar usuario de Firebase Auth: uid del doc → docId → email
    let authBorrado = false;
    for (const candidato of [uidDoc, docId].filter(Boolean)) {
      try { await admin.auth().deleteUser(candidato); authBorrado = true; break; }
      catch (e) { /* probar siguiente */ }
    }
    if (!authBorrado && emailDoc) {
      try {
        const u = await admin.auth().getUserByEmail(emailDoc);
        await admin.auth().deleteUser(u.uid);
        authBorrado = true;
      } catch (e) { console.warn('⚠️  No se pudo borrar de Auth por email:', e.message); }
    }

    console.log(`🗑️  Miembro eliminado · ${uid} · Auth:${authBorrado} · por ${req.admin.email}`);
    return res.json({ ok: true, authBorrado, firestoreBorrado: !!docSnap });
  } catch (e) {
    console.error('❌ eliminar-miembro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
