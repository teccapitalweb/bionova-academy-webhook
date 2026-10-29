const DEFAULT_BLOCKING = new Set(['incomplete', 'active', 'trialing', 'past_due', 'unpaid', 'paused']);
function clean(value) {
  return String(value == null ? '' : value).trim();
}

function emailKey(value) {
  return clean(value).toLowerCase();
}

function stripeId(value) {
  return typeof value === 'string' ? value : (value && typeof value.id === 'string' ? value.id : '');
}

export function asIso(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (Number.isFinite(Number(value.seconds))) return new Date(Number(value.seconds) * 1000).toISOString();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function subscriptionPeriodEnd(subscription) {
  const direct = Number(subscription?.current_period_end);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return Math.max(0, ...(subscription?.items?.data || []).map(item => Number(item?.current_period_end) || 0));
}

async function listAllAuthUsers(auth) {
  const users = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    users.push(...(page.users || []));
    pageToken = page.pageToken;
  } while (pageToken);
  return users;
}

async function listAllOwnSubscriptions(stripe, belongsToProject, knownIds) {
  const subscriptions = [];
  let startingAfter;
  do {
    const page = await stripe.subscriptions.list({
      status: 'all',
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
      expand: ['data.customer']
    });
    const rows = page.data || [];
    subscriptions.push(...rows.filter(subscription => belongsToProject(subscription, knownIds)));
    startingAfter = page.has_more && rows.length ? rows[rows.length - 1].id : null;
  } while (startingAfter);
  return subscriptions;
}

export function memberIsActive(member, nowMs = Date.now()) {
  const markedActive = member?.activa === true || member?.activo === true
    || (member?.esRegalo === true && member?.activa !== false && member?.activo !== false);
  if (!markedActive) return false;
  const expiry = member.cancelacionProgramada === true
    ? (member.fechaFinAcceso || member.fechaProximaRenovacion || member.expiraEn)
    : (member.stripeSubscriptionId || member.subscriptionId)
      ? (member.fechaProximaRenovacion || member.expiraEn)
      : (member.expiraEn || member.fechaFinAcceso || member.fechaProximaRenovacion);
  const expiryIso = asIso(expiry);
  return !expiryIso || new Date(expiryIso).getTime() > nowMs;
}

export function classify(account, blockingStatuses = DEFAULT_BLOCKING) {
  const subscriptions = account.subscriptions || [];
  const blocking = subscriptions.filter(subscription => blockingStatuses.has(subscription.status));
  const active = blocking.filter(subscription => ['active', 'trialing'].includes(subscription.status));
  const localActive = memberIsActive(account.member);

  if (blocking.length > 1) return { state: 'duplicate', blocking, active, localActive };
  if (active.length === 1) return { state: 'paid-active', blocking, active, localActive };
  if (blocking.length === 1) return { state: 'payment-problem', blocking, active, localActive };
  if (subscriptions.length) return { state: 'previously-purchased', blocking, active, localActive };
  if (localActive) return { state: 'access-without-stripe', blocking, active, localActive };
  return { state: 'not-purchased', blocking, active, localActive };
}

export function publicSubscription(subscription) {
  const price = subscription.items?.data?.[0]?.price || {};
  const periodEnd = subscriptionPeriodEnd(subscription);
  return {
    id: subscription.id,
    customerId: stripeId(subscription.customer),
    status: clean(subscription.status),
    amount: Number(price.unit_amount) || 0,
    currency: clean(price.currency || 'mxn').toUpperCase(),
    interval: clean(price.recurring?.interval),
    createdAt: Number(subscription.created) > 0 ? new Date(Number(subscription.created) * 1000).toISOString() : null,
    currentPeriodEnd: periodEnd > 0 ? new Date(periodEnd * 1000).toISOString() : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true
  };
}

export async function buildPaymentOverview({ stripe, auth, db, belongsToProject, blockingStatuses = DEFAULT_BLOCKING }) {
  const [authUsers, memberSnapshot] = await Promise.all([
    listAllAuthUsers(auth),
    db.collection('miembros').get()
  ]);
  const knownSubscriptionIds = new Set((memberSnapshot.docs || [])
    .map(doc => stripeId(doc.data()?.stripeSubscriptionId || doc.data()?.subscriptionId))
    .filter(Boolean));
  const subscriptions = await listAllOwnSubscriptions(stripe, belongsToProject, knownSubscriptionIds);

  const accounts = new Map();
  const byEmail = new Map();
  const byCustomer = new Map();

  authUsers.forEach(user => {
    const email = emailKey(user.email);
    const account = {
      key: user.uid,
      uid: user.uid,
      email,
      name: clean(user.displayName),
      disabled: user.disabled === true,
      registeredAt: user.metadata?.creationTime ? new Date(user.metadata.creationTime).toISOString() : null,
      member: null,
      subscriptions: [],
      registered: true
    };
    accounts.set(account.key, account);
    if (email && !byEmail.has(email)) byEmail.set(email, account.key);
  });

  (memberSnapshot.docs || []).forEach(doc => {
    const member = doc.data() || {};
    const uid = clean(member.uid || member.firebaseUid || member.userId || (!doc.id.includes('@') ? doc.id : ''));
    const email = emailKey(member.email || (doc.id.includes('@') ? doc.id : ''));
    const existingKey = (uid && accounts.has(uid) && uid) || (email && byEmail.get(email));
    const key = existingKey || uid || `member:${doc.id}`;
    const account = accounts.get(key) || {
      key,
      uid,
      email,
      name: clean(member.nombre || member.name || member.displayName),
      disabled: false,
      registeredAt: asIso(member.fechaRegistro || member.createdAt || member.creadoEn || member.fechaAlta),
      member: null,
      subscriptions: [],
      registered: false
    };
    account.uid ||= uid;
    account.email ||= email;
    account.name ||= clean(member.nombre || member.name || member.displayName);
    account.registeredAt ||= asIso(member.fechaRegistro || member.createdAt || member.creadoEn || member.fechaAlta);
    if (!account.member || memberIsActive(member)) account.member = member;
    accounts.set(key, account);
    if (account.email && !byEmail.has(account.email)) byEmail.set(account.email, key);
    const customerId = stripeId(member.stripeCustomerId || member.customerId);
    if (customerId) byCustomer.set(customerId, key);
  });

  subscriptions.forEach(subscription => {
    const customer = typeof subscription.customer === 'object' ? subscription.customer : null;
    const customerId = stripeId(subscription.customer);
    const uid = clean(subscription.metadata?.uid);
    const email = emailKey(customer?.email);
    let key = (email && byEmail.get(email))
      || (uid && accounts.has(uid) && uid)
      || (customerId && byCustomer.get(customerId));
    if (!key) {
      key = `stripe:${customerId || subscription.id}`;
      accounts.set(key, {
        key,
        uid,
        email,
        name: clean(customer?.name),
        disabled: false,
        registeredAt: null,
        member: null,
        subscriptions: [],
        registered: false
      });
      if (email && !byEmail.has(email)) byEmail.set(email, key);
      if (customerId) byCustomer.set(customerId, key);
    }
    accounts.get(key).subscriptions.push(subscription);
  });

  const priority = {
    duplicate: 0,
    'payment-problem': 1,
    'access-without-stripe': 2,
    'paid-active': 3,
    'previously-purchased': 4,
    'not-purchased': 5
  };
  const rows = Array.from(accounts.values()).map(account => {
    const result = classify(account, blockingStatuses);
    const member = account.member || {};
    return {
      uid: account.uid,
      email: account.email,
      name: account.name || clean(member.nombre || member.name || member.displayName),
      registered: account.registered,
      registeredAt: account.registeredAt,
      disabled: account.disabled,
      state: result.state,
      localActive: result.localActive,
      localPlan: clean(member.plan || member.tipo),
      accessSource: clean(member.esRegalo ? 'regalo' : (member.activacionManual ? 'manual' : '')),
      stripeActive: result.active.length > 0,
      blockingCount: result.blocking.length,
      duplicateCount: Math.max(0, result.blocking.length - 1),
      subscriptions: account.subscriptions
        .slice()
        .sort((a, b) => Number(b.created || 0) - Number(a.created || 0))
        .map(publicSubscription)
    };
  }).sort((a, b) => (
    (priority[a.state] ?? 99) - (priority[b.state] ?? 99)
    || clean(a.email || a.name).localeCompare(clean(b.email || b.name), 'es')
  ));

  const counts = rows.reduce((result, row) => {
    result.total += 1;
    result[row.state] = (result[row.state] || 0) + 1;
    return result;
  }, { total: 0 });

  return { generatedAt: new Date().toISOString(), counts, accounts: rows };
}

export function createPaymentOverview(dependencies) {
  return { build: () => buildPaymentOverview(dependencies) };
}

export { DEFAULT_BLOCKING };






