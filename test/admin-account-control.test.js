import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  memberIsActive,
  classify,
  subscriptionPeriodEnd
} from '../services/payment-overview.js';
import {
  normalizeFilters,
  normalizeGrant,
  ledgerId
} from '../services/admin-credit-bulk.js';
import { buildVerdict, courseRows } from '../services/account-audit.js';

test('BioNova reconoce acceso activo en campos nuevos, antiguos y regalos vigentes', () => {
  const future = new Date(Date.now() + 86400000);
  assert.equal(memberIsActive({ activa:true, expiraEn:future }), true);
  assert.equal(memberIsActive({ activo:true, expiraEn:future }), true);
  assert.equal(memberIsActive({ esRegalo:true, expiraEn:future }), true);
  assert.equal(memberIsActive({ esRegalo:true, activa:false, activo:false, expiraEn:future }), false);
  assert.equal(memberIsActive({ activa:true, expiraEn:new Date(Date.now() - 1000) }), false);
});

test('dos suscripciones cobrables se clasifican como duplicado', () => {
  const account = {
    member:{ activa:true },
    subscriptions:[{ status:'active' }, { status:'past_due' }]
  };
  assert.equal(classify(account).state, 'duplicate');
  assert.equal(buildVerdict({ subscriptions:account.subscriptions, localActive:true }).code, 'duplicate-subscriptions');
});

test('Stripe v2025 toma el fin de periodo desde el item', () => {
  assert.equal(subscriptionPeriodEnd({ items:{ data:[{ current_period_end:123 }, { current_period_end:456 }] } }), 456);
});

test('regalos masivos validan fechas, selección e idempotencia por cuenta', () => {
  assert.throws(() => normalizeFilters({ registeredFrom:'2026-10-30', registeredTo:'2026-10-01' }), /fecha inicial/i);
  assert.throws(() => normalizeGrant({ operationId:'corto', amount:10, uids:['u1'] }), /identificador/i);
  const grant = normalizeGrant({ operationId:'gift_20261029_abcd', amount:50, uids:['u2','u1','u1'] });
  assert.deepEqual(grant.uids, ['u1','u2']);
  assert.equal(ledgerId(grant.operationId, 'u1'), ledgerId(grant.operationId, 'u1'));
  assert.notEqual(ledgerId(grant.operationId, 'u1'), ledgerId(grant.operationId, 'u2'));
});

test('auditoría respeta desbloqueo cada ocho días y progreso histórico BioNova', () => {
  const now = Date.now();
  const rows = courseRows([
    { id:'c1', data:{ titulo:'Uno', orden:1, sesiones:[{},{}] } },
    { id:'c2', data:{ titulo:'Dos', orden:2, sesiones:[{}] } }
  ], { courses:{ c1:{ clasesVistas:[1,2], completado:true } } }, {
    activa:true,
    activadoEn:new Date(now - 9 * 86400000)
  }, 8);
  assert.equal(rows[0].unlockDay, 0);
  assert.equal(rows[0].viewedClasses, 2);
  assert.equal(rows[0].completed, true);
  assert.equal(rows[1].unlockDay, 8);
  assert.equal(rows[1].available, true);
});

test('las rutas críticas y la baja usan el ID moderno de Stripe', async () => {
  const [adminSource, activitySource] = await Promise.all([
    readFile(new URL('../routes/admin.js', import.meta.url), 'utf8'),
    readFile(new URL('../routes/activity.js', import.meta.url), 'utf8')
  ]);
  assert.match(adminSource, /resolverSubId/);
  assert.match(adminSource, /dias > 3650/);
  assert.match(adminSource, /\/payment-overview/);
  assert.match(adminSource, /\/account-audit/);
  assert.match(adminSource, /\/creditos\/masivos/);
  assert.match(activitySource, /learning_progress/);
  assert.match(activitySource, /analytics_sessions/);
});


