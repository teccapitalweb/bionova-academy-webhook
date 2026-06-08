// ═══════════════════════════════════════════════════════════════════
// services/news.js · cron NewsData → Firestore (colección noticias_auto)
// Adaptado a BioNova: biomedicina, microbiología y medicina general.
// Patrón probado: queries CORTAS, rotación 3 categorías/día, filtro de
// relevancia, borra noticias de +15 días, 3 noticias diarias.
// ═══════════════════════════════════════════════════════════════════

import { env } from '../config/env.js';
import { guardarNoticia, borrarNoticiasViejas } from './firestore.js';

const CATEGORIAS = {
  microbiologia: {
    nombre: 'Microbiología',
    color: '#2a6df6',
    queries: ['microbiología', 'microbiology', 'resistencia antimicrobiana', 'antimicrobial resistance']
  },
  biomedicina: {
    nombre: 'Biomedicina',
    color: '#10b981',
    queries: ['biomedicina', 'biomedical research', 'terapia celular', 'stem cells']
  },
  medicina: {
    nombre: 'Medicina general',
    color: '#38bdf8',
    queries: ['medicina general', 'clinical medicine', 'salud pública', 'public health']
  },
  laboratorio: {
    nombre: 'Laboratorio clínico',
    color: '#a78bfa',
    queries: ['laboratorio clínico', 'clinical laboratory', 'diagnóstico médico', 'medical diagnostics']
  },
  farma: {
    nombre: 'Farmacéutica',
    color: '#fbbf24',
    queries: ['control de calidad farmacéutica', 'pharmaceutical quality', 'buenas prácticas GMP', 'drug development']
  }
};

// Rotación: 3 categorías por día (0=domingo … 6=sábado)
const ROTACION = {
  0: ['microbiologia', 'biomedicina', 'medicina'],
  1: ['microbiologia', 'laboratorio', 'farma'],
  2: ['biomedicina', 'medicina', 'laboratorio'],
  3: ['microbiologia', 'farma', 'biomedicina'],
  4: ['medicina', 'laboratorio', 'farma'],
  5: ['microbiologia', 'biomedicina', 'laboratorio'],
  6: ['medicina', 'farma', 'microbiologia']
};

const RUIDO = [
  'futbol', 'fútbol', 'nba', 'nfl', 'liga mx', 'gol', 'partido', 'jugador',
  'celebrity', 'farándula', 'horóscopo', 'horoscopo', 'astros', 'signo',
  'netflix', 'serie', 'película', 'pelicula', 'concierto', 'cantante',
  'bitcoin', 'crypto', 'criptomoneda', 'apuestas', 'casino', 'lotería', 'loteria'
];

const RELEVANTES = [
  'microbi', 'biomed', 'clínic', 'clinic', 'laborator', 'salud', 'health',
  'medic', 'célul', 'cell', 'antimicrob', 'bacteri', 'virus', 'viral',
  'diagnós', 'diagnos', 'farmac', 'pharma', 'patolog', 'inmun', 'immun',
  'vacun', 'vaccine', 'genét', 'genetic', 'enferm', 'disease', 'infecci',
  'infection', 'gmp', 'biotecnolog', 'biotech', 'molecular', 'epidemi'
];

function esRelevante(art) {
  const blob = ((art.title || '') + ' ' + (art.description || '')).toLowerCase();
  if (RUIDO.some(r => blob.includes(r))) return false;
  return RELEVANTES.some(r => blob.includes(r));
}

async function buscarNoticia(cat) {
  for (const q of cat.queries) {
    try {
      const url = 'https://newsdata.io/api/1/latest'
        + `?apikey=${env.newsdataApiKey}`
        + `&q=${encodeURIComponent(q)}`
        + `&language=es,en`;
      const r = await fetch(url);
      if (!r.ok) {
        if (r.status === 429) { console.warn('⚠️  NewsData rate limit (429)'); return null; }
        console.warn(`⚠️  NewsData ${r.status} para "${q}"`); continue;
      }
      const data = await r.json();
      const arts = data.results || [];
      const art = arts.find(a => a.title && a.link && esRelevante(a));
      if (art) return art;
    } catch (err) {
      console.error('⚠️  Error fetch', q, '·', err.message);
    }
  }
  return null;
}

export async function syncNewsData() {
  if (!env.newsdataApiKey) {
    console.warn('⚠️  NEWSDATA_API_KEY no configurada · skipping');
    return 0;
  }

  try {
    const borradas = await borrarNoticiasViejas(15);
    if (borradas) console.log(`🗑️  ${borradas} noticias viejas borradas`);
  } catch (e) { console.error('⚠️  Error borrando viejas:', e.message); }

  const hoy = new Date().getDay();
  const claves = ROTACION[hoy] || ROTACION[0];

  let total = 0;
  for (const clave of claves) {
    const cat = CATEGORIAS[clave];
    if (!cat) continue;
    const art = await buscarNoticia(cat);
    if (!art) { console.log(`· sin noticia relevante para ${clave}`); continue; }

    const id = (art.article_id || art.link || '').replace(/[^a-z0-9]/gi, '_').slice(0, 80);
    if (!id) continue;

    try {
      await guardarNoticia({
        id,
        titulo: art.title,
        extracto: art.description || '',
        link: art.link,
        fuente: art.source_id || art.source_name || '',
        imagen: art.image_url || null,
        categoria: clave,
        categoriaNombre: cat.nombre,
        color: cat.color,
        fechaPublicacion: art.pubDate ? new Date(art.pubDate) : null
      });
      total++;
      console.log(`✓ ${clave}: ${art.title.slice(0, 60)}`);
    } catch (e) { console.error('⚠️  Error guardando', clave, '·', e.message); }
  }

  console.log(`📰 NewsData sync · ${total} noticias guardadas`);
  return total;
}
