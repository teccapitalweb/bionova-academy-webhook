import express from 'express';
import { db, firebaseAuth, FieldValue, Timestamp } from '../config/firebase.js';

const router = express.Router();

async function requireUser(req, res, next) {
  try {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return res.status(401).json({ ok: false, error: 'Falta token de usuario' });
    req.user = await firebaseAuth.verifyIdToken(token);
    next();
  } catch (_) {
    return res.status(401).json({ ok: false, error: 'Token inválido o vencido' });
  }
}

function clean(value, max = 160) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

export function normalizeCourseProgress(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(Object.entries(source).slice(0, 100).map(([courseId, raw]) => {
    const item = raw && typeof raw === 'object' ? raw : {};
    const viewed = [...new Set((Array.isArray(item.clasesVistas) ? item.clasesVistas : [])
      .map(Number).filter(number => Number.isInteger(number) && number > 0 && number <= 500))].sort((a, b) => a - b);
    const timestamps = item.classViewedAt && typeof item.classViewedAt === 'object'
      ? Object.fromEntries(Object.entries(item.classViewedAt).slice(0, 500)
        .filter(([key, timestamp]) => viewed.includes(Number(key)) && !Number.isNaN(new Date(timestamp).getTime()))
        .map(([key, timestamp]) => [String(Number(key)), new Date(timestamp).toISOString()]))
      : {};
    return [clean(courseId, 180), {
      clasesVistas: viewed,
      classViewedAt: timestamps,
      ultimaClase: Math.max(0, Number(item.ultimaClase) || 0),
      completado: item.completado === true,
      completadoEn: (item.completadoEn || item.fechaCompletado) && !Number.isNaN(new Date(item.completadoEn || item.fechaCompletado).getTime())
        ? new Date(item.completadoEn || item.fechaCompletado).toISOString() : null
    }];
  }).filter(([courseId]) => courseId));
}

export function mergeCourseProgress(current = {}, incoming = {}) {
  const merged = { ...current };
  Object.entries(incoming).forEach(([courseId, next]) => {
    const previous = current[courseId] || {};
    const clasesVistas = [...new Set([...(previous.clasesVistas || []), ...(next.clasesVistas || [])])].sort((a, b) => a - b);
    merged[courseId] = {
      ...previous,
      ...next,
      clasesVistas,
      classViewedAt: { ...(previous.classViewedAt || {}), ...(next.classViewedAt || {}) },
      ultimaClase: Math.max(Number(previous.ultimaClase) || 0, Number(next.ultimaClase) || 0),
      completado: previous.completado === true || next.completado === true,
      completadoEn: previous.completadoEn || next.completadoEn || null
    };
  });
  return merged;
}

router.post('/progress', requireUser, async (req, res) => {
  try {
    const incoming = normalizeCourseProgress(req.body?.courses || req.body?.progress || {});
    const ref = db.collection('learning_progress').doc(req.user.uid);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const current = snap.exists ? (snap.data()?.courses || {}) : {};
      tx.set(ref, {
        uid: req.user.uid,
        email: clean(req.user.email, 320).toLowerCase(),
        courses: mergeCourseProgress(current, incoming),
        source: 'vip-panel',
        version: 1,
        updatedAt: FieldValue.serverTimestamp(),
        ...(!snap.exists ? { createdAt: FieldValue.serverTimestamp() } : {})
      }, { merge: true });
    });
    return res.json({ ok: true });
  } catch (error) {
    console.error('❌ activity/progress:', error.message);
    return res.status(500).json({ ok: false, error: 'No se pudo guardar el progreso' });
  }
});

router.post('/session', requireUser, async (req, res) => {
  try {
    const sessionId = clean(req.body?.sessionId, 80).replace(/[^A-Za-z0-9_-]/g, '');
    if (sessionId.length < 8) return res.status(422).json({ ok: false, error: 'Sesión inválida' });
    const seconds = Math.min(86400, Math.max(0, Math.floor(Number(req.body?.seconds) || 0)));
    const area = clean(req.body?.area || 'panel', 80);
    const section = clean(req.body?.section || area, 80);
    const startedAtDate = new Date(req.body?.startedAt);
    const startedAt = Number.isNaN(startedAtDate.getTime()) ? new Date() : startedAtDate;
    const ref = db.collection('analytics_sessions').doc(`${req.user.uid}_${sessionId}`);
    await ref.set({
      uid: req.user.uid,
      email: clean(req.user.email, 320).toLowerCase(),
      area,
      startedAt: Timestamp.fromDate(startedAt),
      startedAtClient: clean(req.body?.startedAt, 40),
      lastSeen: FieldValue.serverTimestamp(),
      seconds,
      sections: { [section]: seconds },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return res.json({ ok: true });
  } catch (error) {
    console.error('❌ activity/session:', error.message);
    return res.status(500).json({ ok: false, error: 'No se pudo guardar la sesión' });
  }
});

export default router;


