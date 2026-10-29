import crypto from 'node:crypto';
import { memberIsActive, asIso } from './payment-overview.js';

const MAX_RECIPIENTS = 1000;
const MAX_CREDITS = 100000;
const OPERATION_ID = /^[A-Za-z0-9._:-]{8,160}$/;

function clean(value, max = 200) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function normalizeDate(value, endOfDay = false) {
  const text = clean(value, 20);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw Object.assign(new Error('La fecha debe usar el formato AAAA-MM-DD.'), { statusCode: 422 });
  const date = new Date(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  if (Number.isNaN(date.getTime())) throw Object.assign(new Error('La fecha no es válida.'), { statusCode: 422 });
  return date;
}

export function normalizeFilters(body = {}) {
  const filters = {
    search: clean(body.search, 160).toLowerCase(),
    giftStatus: ['never-gifted', 'gifted', 'all'].includes(body.giftStatus) ? body.giftStatus : 'never-gifted',
    membershipStatus: ['active', 'inactive', 'all'].includes(body.membershipStatus) ? body.membershipStatus : 'all',
    registeredFrom: normalizeDate(body.registeredFrom),
    registeredTo: normalizeDate(body.registeredTo, true)
  };
  if (filters.registeredFrom && filters.registeredTo && filters.registeredFrom > filters.registeredTo) {
    throw Object.assign(new Error('La fecha inicial no puede ser posterior a la fecha final.'), { statusCode: 422 });
  }
  return filters;
}

export function normalizeGrant(body = {}) {
  const amount = Math.floor(Number(body.amount));
  const operationId = clean(body.operationId, 160);
  const uids = [...new Set((Array.isArray(body.uids) ? body.uids : []).map(value => clean(value, 128)).filter(Boolean))].sort();
  if (!OPERATION_ID.test(operationId)) throw Object.assign(new Error('La operación no tiene un identificador válido.'), { statusCode: 422 });
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_CREDITS) {
    throw Object.assign(new Error(`Los créditos deben ser un entero entre 1 y ${MAX_CREDITS}.`), { statusCode: 422 });
  }
  if (!uids.length) throw Object.assign(new Error('Selecciona al menos una cuenta.'), { statusCode: 422 });
  if (uids.length > MAX_RECIPIENTS) throw Object.assign(new Error(`Un lote admite hasta ${MAX_RECIPIENTS} cuentas.`), { statusCode: 422 });
  return { operationId, amount, uids, note: clean(body.note, 200) };
}

export function fingerprint(grant) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ amount: grant.amount, note: grant.note, uids: grant.uids }))
    .digest('hex');
}

export function ledgerId(operationId, uid) {
  return `bulk_${crypto.createHash('sha256').update(`bionova-credit-bulk-v1|${operationId}|${uid}`).digest('hex').slice(0, 40)}`;
}

async function listAllUsers(auth) {
  const users = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    users.push(...(page.users || []));
    pageToken = page.pageToken;
  } while (pageToken);
  return users;
}

function accountRows(authUsers, memberDocs) {
  const rows = new Map();
  const byEmail = new Map();
  authUsers.forEach(user => {
    const email = clean(user.email, 320).toLowerCase();
    rows.set(user.uid, {
      uid: user.uid,
      email,
      name: clean(user.displayName, 200),
      registeredAt: user.metadata?.creationTime ? new Date(user.metadata.creationTime).toISOString() : null,
      member: null
    });
    if (email) byEmail.set(email, user.uid);
  });
  memberDocs.forEach(doc => {
    const member = doc.data() || {};
    const email = clean(member.email || (doc.id.includes('@') ? doc.id : ''), 320).toLowerCase();
    const uid = clean(member.uid || member.firebaseUid || member.userId || (!doc.id.includes('@') ? doc.id : ''), 128);
    const key = (uid && rows.has(uid) && uid) || (email && byEmail.get(email)) || uid || `member:${doc.id}`;
    const row = rows.get(key) || { uid: uid || doc.id, email, name: '', registeredAt: null, member: null };
    row.email ||= email;
    row.name ||= clean(member.nombre || member.name || member.displayName, 200);
    row.registeredAt ||= asIso(member.fechaRegistro || member.createdAt || member.creadoEn || member.fechaAlta);
    if (!row.member || memberIsActive(member)) row.member = member;
    rows.set(key, row);
  });
  return [...rows.values()].filter(row => row.uid && !row.uid.startsWith('member:'));
}

export function filterRows(rows, giftedUids, filters) {
  return rows.filter(row => {
    const gifted = giftedUids.has(row.uid);
    const active = memberIsActive(row.member);
    const registeredMs = row.registeredAt ? new Date(row.registeredAt).getTime() : NaN;
    if (filters.giftStatus === 'never-gifted' && gifted) return false;
    if (filters.giftStatus === 'gifted' && !gifted) return false;
    if (filters.membershipStatus === 'active' && !active) return false;
    if (filters.membershipStatus === 'inactive' && active) return false;
    if (filters.registeredFrom && (!Number.isFinite(registeredMs) || registeredMs < filters.registeredFrom.getTime())) return false;
    if (filters.registeredTo && (!Number.isFinite(registeredMs) || registeredMs > filters.registeredTo.getTime())) return false;
    if (filters.search) {
      const haystack = `${row.name} ${row.email} ${row.uid}`.toLowerCase();
      if (!haystack.includes(filters.search)) return false;
    }
    return true;
  }).sort((a, b) => String(b.registeredAt || '').localeCompare(String(a.registeredAt || '')));
}

function publicCandidate(row, giftedUids) {
  return {
    uid: row.uid,
    email: row.email,
    name: row.name,
    registeredAt: row.registeredAt,
    membershipActive: memberIsActive(row.member),
    plan: clean(row.member?.plan || row.member?.tipo, 60),
    previouslyGifted: giftedUids.has(row.uid)
  };
}

export function createAdminCreditBulk({ db, auth, FieldValue, ensureAccount, pushNotifications }) {
  const batches = () => db.collection('_adminCreditGiftBatches');

  async function preview(body) {
    const filters = normalizeFilters(body);
    const [authUsers, members, gifts] = await Promise.all([
      listAllUsers(auth),
      db.collection('miembros').get(),
      db.collection('credit_ledger').where('type', '==', 'admin_gift').limit(10000).get()
    ]);
    const giftedUids = new Set(gifts.docs.map(doc => clean(doc.data()?.uid, 128)).filter(Boolean));
    const matches = filterRows(accountRows(authUsers, members.docs), giftedUids, filters);
    return {
      totalMatches: matches.length,
      truncated: matches.length > MAX_RECIPIENTS,
      candidates: matches.slice(0, MAX_RECIPIENTS).map(row => publicCandidate(row, giftedUids)),
      historyVerified: true
    };
  }

  async function reserveBatch(grant, adminEmail) {
    const ref = batches().doc(grant.operationId);
    const expected = fingerprint(grant);
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const current = snap.data() || {};
        if (current.fingerprint !== expected) {
          throw Object.assign(new Error('Ese identificador ya se usó con una selección diferente.'), { statusCode: 409 });
        }
        return { ref, existing: current };
      }
      tx.create(ref, {
        operationId: grant.operationId,
        fingerprint: expected,
        amount: grant.amount,
        note: grant.note,
        requested: grant.uids.length,
        adminEmail,
        status: 'processing',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      return { ref, existing: null };
    });
  }

  async function grantOne(grant, uid, adminEmail) {
    if (typeof ensureAccount === 'function') await ensureAccount(uid);
    const accountRef = db.collection('credit_accounts').doc(uid);
    const memberRef = db.collection('miembros').doc(uid);
    const entryId = ledgerId(grant.operationId, uid);
    const ledgerRef = db.collection('credit_ledger').doc(entryId);
    const noticeRef = db.collection('credit_notifications').doc(uid).collection('items').doc(entryId);
    return db.runTransaction(async tx => {
      const [accountSnap, ledgerSnap, memberSnap] = await Promise.all([tx.get(accountRef), tx.get(ledgerRef), tx.get(memberRef)]);
      const account = accountSnap.exists ? (accountSnap.data() || {}) : {};
      const member = memberSnap.exists ? (memberSnap.data() || {}) : {};
      const balance = Math.max(0, Number(account.balance ?? member.creditos ?? 0));
      if (ledgerSnap.exists) return { uid, status: 'already-applied', balance };
      const next = balance + grant.amount;
      tx.set(accountRef, {
        uid,
        balance: next,
        lifetimeGifted: Math.max(0, Number(account.lifetimeGifted || 0)) + grant.amount,
        ...(!accountSnap.exists ? { createdAt: FieldValue.serverTimestamp() } : {}),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      tx.create(ledgerRef, {
        uid,
        amount: grant.amount,
        type: 'admin_gift',
        source: 'admin-bulk',
        batchId: grant.operationId,
        nota: grant.note,
        adminEmail,
        status: 'confirmed',
        createdAt: FieldValue.serverTimestamp()
      });
      tx.create(noticeRef, {
        uid,
        ledgerId: entryId,
        kind: 'gift',
        amount: grant.amount,
        balanceAfter: next,
        note: grant.note,
        batchId: grant.operationId,
        createdAt: FieldValue.serverTimestamp(),
        readAt: null
      });
      tx.set(memberRef, {
        uid,
        creditos: next,
        creditosActualizadosEn: FieldValue.serverTimestamp(),
        ...(!memberSnap.exists ? { activa: false, activo: false, source: 'bionova-credit-gift' } : {})
      }, { merge: true });
      return { uid, status: 'applied', balance: next };
    });
  }

  async function grant(body, adminUser) {
    const data = normalizeGrant(body);
    const adminEmail = clean(adminUser?.email, 320).toLowerCase();
    const [authUsers, members] = await Promise.all([listAllUsers(auth), db.collection('miembros').get()]);
    const known = new Set(accountRows(authUsers, members.docs).map(row => row.uid));
    const missing = data.uids.filter(uid => !known.has(uid));
    if (missing.length) throw Object.assign(new Error(`Hay ${missing.length} cuenta(s) que ya no existen. Actualiza la vista previa.`), { statusCode: 409 });

    const reservation = await reserveBatch(data, adminEmail);
    if (reservation.existing?.status === 'completed') {
      return { repeated: true, ...(reservation.existing.result || {}) };
    }

    const results = [];
    for (let index = 0; index < data.uids.length; index += 20) {
      const chunk = data.uids.slice(index, index + 20);
      results.push(...(await Promise.all(chunk.map(uid => grantOne(data, uid, adminEmail)))));
    }
    const applied = results.filter(item => item.status === 'applied');
    const result = {
      operationId: data.operationId,
      requested: data.uids.length,
      delivered: applied.length,
      skipped: results.length - applied.length,
      creditsPerAccount: data.amount,
      totalCredits: applied.length * data.amount,
      accounts: results
    };
    await reservation.ref.set({ status: 'completed', result, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    if (pushNotifications?.sendTemplate) {
      applied.forEach(item => setImmediate(() => pushNotifications.sendTemplate(item.uid, 'credits_earned', {
        creditos: data.amount,
        saldo: item.balance
      }, {
        eventId: `credits:admin-bulk:${data.operationId}:${item.uid}`,
        url: '/vip-panel.html#creditos',
        respectQuietHours: false
      }).catch(error => console.warn('⚠️  Push de créditos masivos:', error.message))));
    }
    return result;
  }

  async function history() {
    const snap = await batches().limit(100).get();
    return snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: asIso(doc.data()?.createdAt),
      updatedAt: asIso(doc.data()?.updatedAt)
    })).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 50);
  }

  return { preview, grant, history };
}

export { MAX_RECIPIENTS, MAX_CREDITS };






