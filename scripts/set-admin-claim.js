'use strict';

/**
 * 최초 관리자 계정 권한 부여 스크립트.
 *
 * 사용 예:
 *   npm install firebase-admin
 *   export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
 *   node scripts/set-admin-claim.js YOUR_PROJECT_ID admin@practice.local "이재겸 교수"
 *
 * Windows PowerShell:
 *   $env:GOOGLE_APPLICATION_CREDENTIALS="C:\\path\\service-account.json"
 *   node scripts/set-admin-claim.js YOUR_PROJECT_ID admin@practice.local "이재겸 교수"
 */
const admin = require('firebase-admin');

const [projectId, email, nameArg] = process.argv.slice(2);
if (!projectId || !email) {
  console.error('Usage: node scripts/set-admin-claim.js <PROJECT_ID> <ADMIN_EMAIL> [ADMIN_NAME]');
  process.exit(1);
}
const adminName = nameArg || '관리자';

admin.initializeApp({ projectId });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

(async () => {
  const user = await admin.auth().getUserByEmail(email);
  await admin.auth().setCustomUserClaims(user.uid, { role: 'admin', sid: 'admin', name: adminName });
  await db.collection('profiles').doc(user.uid).set({
    role: 'admin',
    sid: 'admin',
    name: adminName,
    email,
    pwChanged: true,
    disabled: false,
    createdAt: FieldValue.serverTimestamp(),
    createdAtMillis: Date.now(),
    updatedAt: FieldValue.serverTimestamp(),
    updatedAtMillis: Date.now()
  }, { merge: true });
  console.log(`Admin claim applied: ${email} (${user.uid})`);
  console.log('중요: 이미 로그인 중이었다면 로그아웃 후 다시 로그인해야 새 권한 토큰이 적용됩니다.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
