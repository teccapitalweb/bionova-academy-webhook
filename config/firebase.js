// ═══════════════════════════════════════════════════════════════════
// config/firebase.js · inicialización de Firebase Admin
// ═══════════════════════════════════════════════════════════════════

import admin from 'firebase-admin';
import { env } from './env.js';

let serviceAccount;
try {
  serviceAccount = JSON.parse(env.firebaseServiceAccount || '{}');
} catch (err) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT no es JSON válido:', err.message);
  process.exit(1);
}

if (!serviceAccount.project_id) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT sin project_id');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: env.firebaseProjectId
});

export const db = admin.firestore();
export const FieldValue = admin.firestore.FieldValue;
export const Timestamp = admin.firestore.Timestamp;

console.log('✅ Firebase Admin inicializado · project:', serviceAccount.project_id);
