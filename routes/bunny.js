// Reproductor protegido de Bunny Stream para BioNova.
// Solo firma videos pertenecientes al catálogo migrado; nunca acepta IDs arbitrarios.

import express from 'express';
import admin from 'firebase-admin';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { db } from '../config/firebase.js';
import { env } from '../config/env.js';
import { getMembership } from '../services/firestore.js';

const router = express.Router();
const catalogo = JSON.parse(
  readFileSync(new URL('../data/bionova-bunny-catalog.json', import.meta.url), 'utf8')
);
const videosPermitidos = new Set(
  catalogo.flatMap(curso => (curso.sesiones || []).map(sesion => sesion.videoId)).filter(Boolean)
);
const correosAdmin = new Set([
  'teccapitalweb@gmail.com',
  'fisiotec25@gmail.com'
]);

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function puntajeTitulo(a, b) {
  const na = normalizar(a);
  const nb = normalizar(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const ta = new Set(na.split(' ').filter(x => x.length > 2));
  const tb = new Set(nb.split(' ').filter(x => x.length > 2));
  const union = new Set([...ta, ...tb]);
  let inter = 0;
  tb.forEach(x => { if (ta.has(x)) inter++; });
  return union.size ? inter / union.size : 0;
}

let muestraCache = { videoId: null, vence: 0 };

async function obtenerVideoMuestra() {
  if (muestraCache.vence > Date.now()) return muestraCache.videoId;

  const snap = await db.collection('cursos').orderBy('orden', 'asc').get();
  let videoId = null;
  for (const doc of snap.docs) {
    const curso = doc.data() || {};
    if (curso.marcarProximamente === true) continue;
    const primera = Array.isArray(curso.sesiones) ? curso.sesiones[0] : null;
    if (!primera && !(curso.clases || []).length) continue;

    if (primera?.videoId && videosPermitidos.has(primera.videoId)) {
      videoId = primera.videoId;
      break;
    }

    let mejor = null;
    let score = 0;
    for (const item of catalogo) {
      const actual = puntajeTitulo(curso.titulo, item.titulo);
      if (actual > score) { score = actual; mejor = item; }
    }
    if (mejor && score >= 0.52) {
      videoId = mejor.sesiones?.[0]?.videoId || null;
    }
    break;
  }

  muestraCache = { videoId, vence: Date.now() + 60_000 };
  return videoId;
}

async function verificarUsuario(req) {
  const header = req.get('authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    return await admin.auth().verifyIdToken(header.slice(7));
  } catch {
    return null;
  }
}

router.post('/embed-token', async (req, res) => {
  try {
    if (!env.bunnyTokenAuthKey) {
      return res.status(503).json({ error: 'Bunny Stream no está configurado en Railway' });
    }

    const videoId = String(req.body?.videoId || '').trim();
    if (!videosPermitidos.has(videoId)) {
      return res.status(404).json({ error: 'Video no encontrado en el catálogo de BioNova' });
    }

    const muestraId = await obtenerVideoMuestra();
    const esMuestra = videoId === muestraId;
    const usuario = await verificarUsuario(req);
    const esAdmin = Boolean(usuario && (
      usuario.admin === true || correosAdmin.has(String(usuario.email || '').toLowerCase())
    ));
    let tieneAcceso = esAdmin;
    if (usuario && !tieneAcceso) {
      const membresia = await getMembership(usuario.uid);
      tieneAcceso = membresia.activa === true || membresia.activo === true;
    }

    if (!esMuestra && !tieneAcceso) {
      return res.status(403).json({ error: 'Membresía requerida' });
    }

    const expires = Math.floor(Date.now() / 1000) + env.bunnyTokenTtlSeconds;
    const token = createHash('sha256')
      .update(env.bunnyTokenAuthKey + videoId + expires)
      .digest('hex');
    const embedUrl = `https://iframe.mediadelivery.net/embed/${env.bunnyStreamLibraryId}/${videoId}?token=${token}&expires=${expires}`;

    res.set('Cache-Control', 'no-store');
    return res.json({ embedUrl, expires, esMuestra });
  } catch (error) {
    console.error('[Bunny embed-token]', error);
    return res.status(500).json({ error: 'No se pudo autorizar el reproductor' });
  }
});

export default router;
