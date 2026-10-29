import {
  DEFAULT_BLOCKING,
  asIso,
  memberIsActive,
  publicSubscription,
  subscriptionPeriodEnd
} from './payment-overview.js';

function clean(value, max = 320) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function lower(value) {
  return clean(value).toLowerCase();
}

function stripeId(value) {
  return typeof value === 'string' ? value : (value && typeof value.id === 'string' ? value.id : '');
}

function sortNewest(values, field = 'createdAt') {
  return values.sort((a, b) => String(b[field] || '').localeCompare(String(a[field] || '')));
}

export function buildVerdict({ subscriptions, localActive }) {
  const blocking = subscriptions.filter(subscription => DEFAULT_BLOCKING.has(subscription.status));
  const active = blocking.filter(subscription => ['active', 'trialing'].includes(subscription.status));
  if (blocking.length > 1) return { code: 'duplicate-subscriptions', blocking, active };
  if (active.length === 1 && localActive) return { code: 'consistent-active', blocking, active };
  if (active.length === 1) return { code: 'stripe-active-local-inactive', blocking, active };
  if (blocking.length === 1) return { code: 'payment-problem', blocking, active };
  if (localActive) return { code: 'local-active-stripe-missing', blocking, active };
  return { code: 'inactive', blocking, active };
}

function dateMs(value) {
  const iso = asIso(value);
  return iso ? new Date(iso).getTime() : NaN;
}

export async function resolveIdentity({ auth, db, query }) {
  const requested = clean(query);
  if (!requested) throw Object.assign(new Error('Escribe un correo o UID.'), { statusCode: 422 });
  let authUser = null;
  try {
    authUser = requested.includes('@') ? await auth.getUserByEmail(lower(requested)) : await auth.getUser(requested);
  } catch (error) {
    if (!/user-not-found|no user record/i.test(String(error.code || error.message))) throw error;
  }

  const members = await db.collection('miembros').get();
  const requestedEmail = requested.includes('@') ? lower(requested) : lower(authUser?.email);
  const requestedUid = authUser?.uid || (!requested.includes('@') ? requested : '');
  const matches = members.docs.filter(doc => {
    const value = doc.data() || {};
    const uid = clean(value.uid || value.firebaseUid || value.userId || (!doc.id.includes('@') ? doc.id : ''));
    const email = lower(value.email || (doc.id.includes('@') ? doc.id : ''));
    return (requestedUid && (doc.id === requestedUid || uid === requestedUid))
      || (requestedEmail && email === requestedEmail)
      || doc.id === requested;
  });
  matches.sort((a, b) => Number(memberIsActive(b.data())) - Number(memberIsActive(a.data())));
  const memberDoc = matches[0] || null;
  const member = memberDoc?.data() || null;
  const uid = authUser?.uid || clean(member?.uid || member?.firebaseUid || member?.userId || (!memberDoc?.id?.includes('@') ? memberDoc?.id : ''));
  const email = lower(authUser?.email || member?.email || (memberDoc?.id?.includes('@') ? memberDoc.id : requestedEmail));
  if (!authUser && !memberDoc) throw Object.assign(new Error('No encontramos una cuenta de BioNova con ese correo o UID.'), { statusCode: 404 });
  return {
    uid,
    email,
    name: clean(authUser?.displayName || member?.nombre || member?.name || member?.displayName || 'Cuenta BioNova'),
    createdAt: authUser?.metadata?.creationTime ? new Date(authUser.metadata.creationTime).toISOString() : asIso(member?.fechaRegistro || member?.createdAt || member?.creadoEn || member?.fechaAlta),
    authDisabled: authUser?.disabled === true,
    authUser,
    member,
    memberDoc,
    matchedIdentities: matches.length + (authUser ? 1 : 0)
  };
}

async function listSubscriptions({ stripe, identity, belongsToProject }) {
  const customerIds = new Set([stripeId(identity.member?.stripeCustomerId || identity.member?.customerId)].filter(Boolean));
  if (identity.email) {
    const customers = await stripe.customers.list({ email: identity.email, limit: 20 });
    (customers.data || []).forEach(customer => customerIds.add(customer.id));
  }
  const knownId = clean(identity.member?.stripeSubscriptionId || identity.member?.subscriptionId);
  const knownIds = new Set([knownId].filter(Boolean));
  const subscriptions = new Map();
  for (const customerId of customerIds) {
    const page = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100, expand: ['data.customer'] });
    (page.data || []).forEach(subscription => {
      if (belongsToProject(subscription, knownIds)) subscriptions.set(subscription.id, subscription);
    });
  }
  if (knownId && !subscriptions.has(knownId)) {
    try {
      const known = await stripe.subscriptions.retrieve(knownId, { expand: ['customer'] });
      if (belongsToProject(known, knownIds)) subscriptions.set(known.id, known);
    } catch (error) {
      console.warn('[account audit subscription]', error.message);
    }
  }
  return [...subscriptions.values()].sort((a, b) => Number(b.created || 0) - Number(a.created || 0));
}

async function listInvoices({ stripe, subscriptions }) {
  const subscriptionIds = new Set(subscriptions.map(subscription => subscription.id));
  const customerIds = [...new Set(subscriptions.map(subscription => stripeId(subscription.customer)).filter(Boolean))];
  const invoices = new Map();
  for (const customerId of customerIds) {
    let startingAfter;
    do {
      const page = await stripe.invoices.list({ customer: customerId, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
      const rows = page.data || [];
      rows.forEach(invoice => {
        const subscriptionId = stripeId(invoice.subscription) || stripeId(invoice.parent?.subscription_details?.subscription);
        if (subscriptionIds.has(subscriptionId)) invoices.set(invoice.id, invoice);
      });
      startingAfter = page.has_more && rows.length ? rows[rows.length - 1].id : null;
    } while (startingAfter);
  }
  return [...invoices.values()].sort((a, b) => Number(b.created || 0) - Number(a.created || 0)).map(invoice => ({
    id: invoice.id,
    subscriptionId: stripeId(invoice.subscription) || stripeId(invoice.parent?.subscription_details?.subscription),
    status: clean(invoice.status),
    paid: invoice.paid === true || invoice.status === 'paid',
    amount: Number(invoice.amount_paid || invoice.total || 0),
    currency: clean(invoice.currency || 'mxn').toUpperCase(),
    reason: clean(invoice.billing_reason),
    createdAt: Number(invoice.created) ? new Date(Number(invoice.created) * 1000).toISOString() : null,
    hostedInvoiceUrl: clean(invoice.hosted_invoice_url, 1000)
  }));
}

function membershipStart(member = {}) {
  const candidates = [
    member.memberSince,
    member.activadoEn,
    member.startedAt,
    member.fechaActivacion,
    member.fechaActivacionManual,
    member.fechaAlta,
    member.fechaRegistro,
    member.createdAt
  ].map(dateMs).filter(Number.isFinite);
  return candidates.length ? Math.min(...candidates) : NaN;
}

export function courseRows(courses, progress, member, unlockEveryDays = 6) {
  const sorted = courses.slice().sort((a, b) => Number(a.data.orden ?? a.order ?? 0) - Number(b.data.orden ?? b.order ?? 0));
  const start = membershipStart(member);
  let rank = 0;
  return sorted.map(course => {
    const value = course.data || {};
    const collectionId = clean(value.bunnyCollectionId || value.collectionId || course.id);
    let unlockDay;
    if (value.marcarProximamente === true) unlockDay = null;
    else if (value.disponibleSiempre === true) unlockDay = 0;
    else { unlockDay = rank * unlockEveryDays; rank += 1; }
    const unlockAt = Number.isFinite(start) && unlockDay != null ? new Date(start + unlockDay * 86400000).toISOString() : null;
    const courseProgress = progress?.courses || progress || {};
    const stored = courseProgress?.[collectionId] || courseProgress?.[course.id] || {};
    const viewed = Array.isArray(stored.clasesVistas)
      ? stored.clasesVistas.length
      : (Array.isArray(stored.classes) ? stored.classes.length : (Array.isArray(stored.viewed) ? stored.viewed.length : 0));
    const total = Array.isArray(value.sesiones) ? value.sesiones.length : Number(value.totalClases || 0);
    const availableByDate = unlockDay === 0 || (unlockAt && new Date(unlockAt).getTime() <= Date.now());
    return {
      id: collectionId || course.id,
      title: clean(value.nombre || value.titulo || course.id, 240),
      area: clean(value.area || value.categoria, 120),
      totalClasses: total,
      viewedClasses: Math.min(total || viewed, viewed),
      completed: Boolean(stored.completedAt || stored.completadoEn) || (total > 0 && viewed >= total),
      completedAt: asIso(stored.completedAt || stored.completadoEn),
      unlockDay,
      unlockAt,
      available: memberIsActive(member) && value.marcarProximamente !== true && availableByDate
    };
  });
}

function materialRows(courses, materialDocs, redemptions) {
  const rows = [];
  courses.forEach(course => {
    (Array.isArray(course.data?.materiales) ? course.data.materiales : []).forEach((material, index) => rows.push({
      id: `${course.id}:material:${index}`,
      title: clean(material.titulo || material.nombre || `Material ${index + 1}`, 240),
      source: 'course',
      course: clean(course.data?.nombre || course.data?.titulo || course.id, 240),
      redeemedAt: null,
      exactOpenTracking: false
    }));
  });
  materialDocs.forEach(material => rows.push({
    id: material.id,
    title: clean(material.data?.titulo || material.data?.nombre || material.id, 240),
    source: 'catalog',
    course: clean(material.data?.curso || material.data?.cursoTitulo, 240),
    redeemedAt: null,
    exactOpenTracking: false
  }));
  redemptions.forEach(redemption => rows.push({
    id: redemption.id,
    title: clean(redemption.data?.name || redemption.data?.rewardName || redemption.data?.rewardId || 'Recurso canjeado', 240),
    source: clean(redemption.data?.type || 'credits', 60),
    course: '',
    redeemedAt: asIso(redemption.data?.createdAt),
    exactOpenTracking: false
  }));
  return rows.slice(0, 800);
}

export function gameRows(progress, ledger) {
  const allowed = new Set(['class_game', 'challenge_correct', 'challenge_game']);
  const rows = [];
  ledger.filter(entry => allowed.has(entry.data?.type)).forEach(entry => rows.push({
    id: entry.id,
    type: clean(entry.data?.type, 60),
    title: entry.data?.type === 'class_game'
      ? `Actividad de clase ${Number(entry.data?.classNumber || 0) || ''}`.trim()
      : clean(entry.data?.game || entry.data?.activityId || entry.data?.source || 'Reto BioNova', 200),
    courseId: clean(entry.data?.collectionId || entry.data?.courseId, 180),
    playedAt: asIso(entry.data?.createdAt),
    status: clean(entry.data?.status || 'confirmed', 40)
  }));
  const challenge = progress?.challengeGames || {};
  Object.entries(challenge.won || {}).forEach(([type, boards]) => {
    (boards || []).forEach(board => {
      const id = `challenge:${challenge.day}:${type}:${board}`;
      if (!rows.some(row => row.id === id)) rows.push({ id, type: 'challenge_game', title: `${clean(type, 80)} · tablero ${Number(board) + 1}`, courseId: '', playedAt: challenge.day ? `${challenge.day}T12:00:00.000Z` : null, status: 'completed' });
    });
  });
  Object.entries(progress?.quizAnswers || {}).forEach(([key, value]) => {
    const id = `quiz:${key}`;
    if (!rows.some(row => row.id === id)) rows.push({ id, type: 'quiz', title: `Quiz · ${key.slice(11)}`, courseId: '', playedAt: asIso(value?.answeredAt), status: value?.correct ? 'correct' : 'answered' });
  });
  return sortNewest(rows, 'playedAt').slice(0, 500);
}

function sessionRows(snapshot) {
  return sortNewest(snapshot.docs.map(doc => {
    const value = doc.data() || {};
    return {
      id: doc.id,
      area: clean(value.area || 'panel', 80),
      startedAt: asIso(value.startedAt),
      lastSeen: asIso(value.lastSeen),
      minutes: Math.max(0, Math.round(Number(value.seconds || 0) / 60)),
      sections: value.sections && typeof value.sections === 'object' ? value.sections : {}
    };
  }), 'startedAt').slice(0, 200);
}

function timeline({ invoices, sessions, redemptions, games }) {
  return [
    ...invoices.map(item => ({ type: 'payment', title: item.paid ? 'Cobro de Stripe pagado' : `Factura ${item.status || 'registrada'}`, at: item.createdAt, detail: `${(item.amount / 100).toLocaleString('es-MX', { style: 'currency', currency: item.currency || 'MXN' })}` })),
    ...sessions.map(item => ({ type: 'session', title: `Sesión en BioNova · ${item.area}`, at: item.startedAt, detail: `${item.minutes} min registrados` })),
    ...redemptions.map(item => ({ type: 'material', title: `Canje · ${clean(item.data?.name || item.data?.rewardName || item.data?.rewardId || 'recurso', 160)}`, at: asIso(item.data?.createdAt), detail: `${Number(item.data?.points || 0)} créditos` })),
    ...games.map(item => ({ type: 'game', title: `Actividad · ${item.title}`, at: item.playedAt, detail: item.status }))
  ].filter(item => item.at).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 200);
}

function mergeCourses(catalog, snapshot) {
  const rows = new Map();
  (catalog || []).forEach((course, index) => rows.set(course.collectionId, { id: course.collectionId, data: { ...course, orden: index + 1 } }));
  (snapshot?.docs || []).forEach((doc, index) => {
    const data = doc.data() || {};
    const id = clean(data.bunnyCollectionId || data.collectionId || doc.id);
    const previous = rows.get(id)?.data || {};
    rows.set(id, { id, data: { ...previous, ...data, orden: data.orden ?? previous.orden ?? index + 1 } });
  });
  return [...rows.values()];
}

export function createAccountAudit({ db, auth, stripe, FieldValue, Timestamp, belongsToProject, getLearningProgress, catalog = [], unlockEveryDays = 6 }) {
  async function audit(query) {
    const identity = await resolveIdentity({ auth, db, query });
    const subscriptions = await listSubscriptions({ stripe, identity, belongsToProject });
    let localActive = memberIsActive(identity.member);
    let verdict = buildVerdict({ subscriptions, localActive });
    let reconciliation = null;

    if (verdict.code === 'stripe-active-local-inactive' && verdict.active.length === 1 && identity.uid) {
      const active = verdict.active[0];
      const periodEnd = subscriptionPeriodEnd(active);
      if (periodEnd * 1000 > Date.now()) {
        const price = active.items?.data?.[0]?.price || {};
        const plan = active.metadata?.plan || (price.recurring?.interval === 'year' ? 'anual' : 'mensual');
        const ref = db.collection('miembros').doc(identity.uid);
        await ref.set({
          uid: identity.uid,
          email: identity.email,
          nombre: identity.name,
          activa: true,
          activo: true,
          plan,
          estado: active.status,
          stripeCustomerId: stripeId(active.customer),
          stripeSubscriptionId: active.id,
          fechaProximaRenovacion: Timestamp.fromDate(new Date(periodEnd * 1000)),
          cancelacionProgramada: active.cancel_at_period_end === true,
          fechaFinAcceso: active.cancel_at_period_end === true ? Timestamp.fromDate(new Date(periodEnd * 1000)) : FieldValue.delete(),
          expiraEn: FieldValue.delete(),
          memberSince: identity.member?.memberSince || identity.member?.activadoEn || FieldValue.serverTimestamp(),
          sincronizadoDesdeStripeAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        identity.member = { ...(identity.member || {}), activa: true, plan, stripeSubscriptionId: active.id, stripeCustomerId: stripeId(active.customer), fechaProximaRenovacion: new Date(periodEnd * 1000) };
        localActive = true;
        verdict = buildVerdict({ subscriptions, localActive });
        reconciliation = { repaired: true, subscriptionId: active.id, repairedAt: new Date().toISOString() };
      }
    }

    const emptyUid = identity.uid || '__none__';
    const [invoices, coursesSnap, materialsSnap, redemptionsSnap, ledgerSnap, sessionsSnap, progress] = await Promise.all([
      listInvoices({ stripe, subscriptions }),
      db.collection('cursos').get(),
      db.collection('materiales').get(),
      db.collection('reward_redemptions').where('uid', '==', emptyUid).limit(1000).get(),
      db.collection('credit_ledger').where('uid', '==', emptyUid).limit(1000).get(),
      db.collection('analytics_sessions').where('uid', '==', emptyUid).limit(500).get(),
      identity.uid && typeof getLearningProgress === 'function' ? getLearningProgress(identity.uid).catch(error => { console.warn('[account audit progress]', error.message); return {}; }) : Promise.resolve({})
    ]);
    const courseDocs = mergeCourses(catalog, coursesSnap);
    const materialDocs = materialsSnap.docs.map(doc => ({ id: doc.id, data: doc.data() || {} }));
    const redemptions = redemptionsSnap.docs.map(doc => ({ id: doc.id, data: doc.data() || {} }));
    const ledger = ledgerSnap.docs.map(doc => ({ id: doc.id, data: doc.data() || {} }));
    const sessions = sessionRows(sessionsSnap);
    const courses = courseRows(courseDocs, progress, identity.member, unlockEveryDays);
    const materials = materialRows(courseDocs, materialDocs, redemptions);
    const games = gameRows(progress, ledger);
    const nextCourse = courses.find(course => !course.available && course.unlockAt) || null;

    return {
      generatedAt: new Date().toISOString(),
      identity: {
        uid: identity.uid,
        email: identity.email,
        name: identity.name,
        createdAt: identity.createdAt,
        authDisabled: identity.authDisabled,
        matchedIdentities: identity.matchedIdentities
      },
      membership: {
        verdict: verdict.code,
        localActive,
        plan: clean(identity.member?.plan || identity.member?.tipo, 80),
        accessSource: identity.member?.esRegalo === true ? 'regalo' : (identity.member?.activacionManual ? 'manual' : 'stripe'),
        expiresAt: asIso(identity.member?.fechaFinAcceso || identity.member?.expiraEn || identity.member?.fechaProximaRenovacion),
        stripeActive: verdict.active.length === 1,
        blockingCount: verdict.blocking.length,
        reconciliation
      },
      subscriptions: subscriptions.map(publicSubscription),
      payments: invoices,
      courses,
      nextCourse,
      materials,
      games,
      sessions,
      timeline: timeline({ invoices, sessions, redemptions, games }),
      coverage: {
        historical: true,
        limitations: [
          'Los cobros y suscripciones se consultan directamente en Stripe.',
          'El progreso centralizado incluye los datos disponibles en Firestore y se completa cuando las cuentas anteriores vuelven a entrar al panel.',
          'No se inventan movimientos anteriores: la hora exacta de aperturas, sesiones o actividades que no se registró en su momento se muestra como no disponible.'
        ]
      }
    };
  }

  return { audit };
}






