'use strict';

const crypto = require('crypto');
const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();
setGlobalOptions({ region: 'asia-northeast3', maxInstances: 20 });

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// 자동 확정 한도: 학생의 누적 활성 신청이 이 수 미만이면 자동 확정, 그 이상이면(9회차부터) 관리자 승인 대상. 0이면 항상 승인.
const AUTO_APPROVE_LIMIT = 8;
// 같은 학사 주차 최대 신청 수(주 1회). 0이면 무제한. settings/semester 의 week1Start 기준으로 주차를 계산합니다.
const MAX_PER_WEEK = 1;
const MIN_PASSWORD_LENGTH = 6;

function requireAuth(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  return request.auth;
}
function requireAdmin(request) {
  const auth = requireAuth(request);
  if (auth.token.role !== 'admin') throw new HttpsError('permission-denied', '관리자 권한이 필요합니다.');
  return auth;
}
function requireStudent(request) {
  const auth = requireAuth(request);
  if (auth.token.role !== 'student') throw new HttpsError('permission-denied', '학생 권한이 필요합니다.');
  return auth;
}
function nowMillis() { return Date.now(); }
function timestamp() { return FieldValue.serverTimestamp(); }
function cleanString(value, field, maxLen = 80) {
  if (typeof value !== 'string') throw new HttpsError('invalid-argument', `${field} 형식이 올바르지 않습니다.`);
  const s = value.trim();
  if (!s || s.length > maxLen) throw new HttpsError('invalid-argument', `${field} 길이가 올바르지 않습니다.`);
  if (/[<>]/.test(s)) throw new HttpsError('invalid-argument', `${field}에 허용되지 않는 문자가 있습니다.`);
  return s;
}
function optionalCleanString(value, field, maxLen = 80, fallback = '') {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return cleanString(String(value), field, maxLen);
}
function cleanSid(value) {
  const sid = cleanString(String(value || ''), '학번', 30);
  if (!/^\d{4,}$/.test(sid)) throw new HttpsError('invalid-argument', '학번은 숫자 4자리 이상이어야 합니다.');
  return sid;
}
function cleanDate(value) {
  const s = cleanString(String(value || ''), '날짜', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpsError('invalid-argument', '날짜는 YYYY-MM-DD 형식이어야 합니다.');
  return s;
}
function cleanTime(value, field) {
  const s = cleanString(String(value || ''), field, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new HttpsError('invalid-argument', `${field}은 HH:MM 형식이어야 합니다.`);
  return s;
}
function cleanCapacity(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 300) throw new HttpsError('invalid-argument', '정원은 1~300 사이의 정수여야 합니다.');
  return n;
}
function cleanInt(value, field, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpsError('invalid-argument', `${field}은 ${min}~${max} 사이의 정수여야 합니다.`);
  return n;
}
function cleanBoolean(value, field) {
  if (typeof value !== 'boolean') throw new HttpsError('invalid-argument', `${field} 값이 올바르지 않습니다.`);
  return value;
}
function cleanOpenAtMillis(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 4102444800000) throw new HttpsError('invalid-argument', '노출일시는 올바른 날짜여야 합니다.');
  return n;
}
function cleanWeekdays(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) throw new HttpsError('invalid-argument', '운영 요일을 1개 이상 선택해야 합니다.');
  const nums = [...new Set(value.map(v => Number(v)))].sort((a, b) => a - b);
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 6)) throw new HttpsError('invalid-argument', '운영 요일 값이 올바르지 않습니다.');
  return nums;
}
function emailForSid(sid) { return `${sid}@practice.local`; }
function randomPassword(length = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(0, alphabet.length)];
  return out;
}
function cleanPassword(value, allowEmpty = false) {
  const s = String(value || '').trim();
  if (!s && allowEmpty) return '';
  if (s.length < MIN_PASSWORD_LENGTH) throw new HttpsError('invalid-argument', `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
  if (s.length > 128) throw new HttpsError('invalid-argument', '비밀번호가 너무 깁니다.');
  return s;
}
function statusActive(status) { return status === 'pending' || status === 'confirmed'; }
function dayNumber(iso) { const [y, m, d] = String(iso).split('-').map(Number); return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 86400000); }
function mondayNumber(iso) { const n = dayNumber(iso); const dow = new Date(n * 86400000).getUTCDay(); return n - ((dow + 6) % 7); }
// 학기 시작 주(week1Start)를 1주차로 하는 학사 주차 번호. 설정이 없으면 null(주 제한 비활성).
function academicWeek(iso, week1Start) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(week1Start || ''))) return null;
  return Math.floor((mondayNumber(iso) - mondayNumber(week1Start)) / 7) + 1;
}
async function getProfile(uid) {
  const snap = await db.collection('profiles').doc(uid).get();
  if (!snap.exists) throw new HttpsError('failed-precondition', '프로필 정보가 없습니다. 관리자에게 문의하세요.');
  return { uid, ...snap.data() };
}
async function audit(type, actor, details = {}) {
  try {
    await db.collection('auditLogs').add({
      type,
      actorUid: actor.uid || null,
      actorRole: actor.token ? actor.token.role || null : null,
      actorSid: actor.token ? actor.token.sid || null : null,
      details,
      createdAt: timestamp(),
      createdAtMillis: nowMillis()
    });
  } catch (error) {
    logger.warn('audit log failed', error);
  }
}
function publicProfile(userRecord, profile, claims) {
  const role = claims.role;
  return {
    uid: userRecord.uid,
    role,
    sid: profile.sid || claims.sid || (role === 'admin' ? 'admin' : ''),
    name: profile.name || userRecord.displayName || (role === 'admin' ? '관리자' : '사용자'),
    email: userRecord.email || '',
    pwChanged: !!profile.pwChanged
  };
}
function visibleNow(slot) {
  return slot.visible === true && Number(slot.openAtMillis || 0) <= nowMillis();
}

exports.getSession = onCall(async (request) => {
  const auth = requireAuth(request);
  const userRecord = await admin.auth().getUser(auth.uid);
  const claims = userRecord.customClaims || {};
  if (!claims.role) throw new HttpsError('permission-denied', '이 계정에 시스템 권한이 없습니다.');
  const profile = await getProfile(auth.uid);
  if (profile.role !== claims.role) throw new HttpsError('failed-precondition', '프로필 권한과 로그인 권한이 일치하지 않습니다.');
  return publicProfile(userRecord, profile, claims);
});

exports.saveSemesterSettings = onCall(async (request) => {
  const auth = requireAdmin(request);
  const data = request.data || {};
  const year = cleanInt(data.year, '학년도', 2020, 2100);
  const term = cleanString(String(data.term || ''), '학기', 20);
  const week1Start = cleanDate(data.week1Start);
  const totalWeeks = cleanInt(data.totalWeeks, '총 주차', 1, 30);
  const weekdays = cleanWeekdays(data.weekdays || [1, 2, 3, 4, 5]);
  const timezone = optionalCleanString(data.timezone, '시간대', 40, 'Asia/Seoul');

  const settings = {
    year,
    term,
    week1Start,
    totalWeeks,
    weekdays,
    timezone,
    updatedByUid: auth.uid,
    updatedAt: timestamp(),
    updatedAtMillis: nowMillis()
  };
  await db.collection('settings').doc('semester').set(settings, { merge: true });
  await audit('saveSemesterSettings', auth, { year, term, week1Start, totalWeeks, weekdays });
  return settings;
});

exports.listVisibleSlots = onCall(async (request) => {
  const auth = requireStudent(request);
  const date = cleanDate(request.data && request.data.date);
  const snap = await db.collection('slots')
    .where('date', '==', date)
    .where('visible', '==', true)
    .get();
  const now = nowMillis();
  const slots = [];
  snap.forEach(doc => {
    const slot = doc.data();
    if (Number(slot.openAtMillis || 0) <= now) {
      slots.push({
        id: doc.id,
        date: slot.date || '',
        start: slot.start || '',
        end: slot.end || '',
        topic: slot.topic || '',
        room: slot.room || '',
        capacity: Number(slot.capacity || 0),
        confirmedCount: Number(slot.confirmedCount || 0),
        pendingCount: Number(slot.pendingCount || 0),
        closed: slot.closed === true,
        visible: true,
        openAtMillis: Number(slot.openAtMillis || 0)
      });
    }
  });
  slots.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return { slots };
});

exports.applyReservation = onCall(async (request) => {
  const auth = requireStudent(request);
  const uid = auth.uid;
  const profile = await getProfile(uid);
  const slotId = cleanString(String(request.data && request.data.slotId || ''), 'slotId', 120);
  const appId = `${slotId}__${uid}`;
  const slotRef = db.collection('slots').doc(slotId);
  const appRef = db.collection('applications').doc(appId);

  const settingsRef = db.collection('settings').doc('semester');

  let result = null;
  await db.runTransaction(async (tx) => {
    const slotSnap = await tx.get(slotRef);
    if (!slotSnap.exists) throw new HttpsError('not-found', '존재하지 않는 시간대입니다.');
    const appSnap = await tx.get(appRef);
    const activeSnap = await tx.get(db.collection('applications').where('uid', '==', uid));
    const settingsSnap = await tx.get(settingsRef);

    const slot = slotSnap.data();
    if (!visibleNow(slot)) throw new HttpsError('failed-precondition', '아직 신청할 수 없는 시간대입니다.');
    if (slot.closed === true) throw new HttpsError('failed-precondition', '마감된 시간대입니다.');

    const existing = appSnap.exists ? appSnap.data() : null;
    if (existing && statusActive(existing.status)) throw new HttpsError('already-exists', '이미 신청한 시간대입니다.');

    // 학생의 활성 신청을 모아 누적 횟수와 같은 주차 횟수를 계산
    const week1Start = settingsSnap.exists ? (settingsSnap.data().week1Start || '') : '';
    const slotWeek = academicWeek(slot.date, week1Start);
    let activeCount = 0;
    let weekCount = 0;
    activeSnap.forEach(doc => {
      if (doc.id === appId) return;
      const a = doc.data();
      if (!statusActive(a.status)) return;
      activeCount++;
      if (MAX_PER_WEEK > 0 && slotWeek !== null && academicWeek(a.date, week1Start) === slotWeek) weekCount++;
    });

    // 주 1회 제한
    if (MAX_PER_WEEK > 0 && weekCount >= MAX_PER_WEEK) {
      throw new HttpsError('resource-exhausted', '같은 주에는 한 번만 신청할 수 있습니다.');
    }

    const capacity = Number(slot.capacity || 0);
    const confirmedCount = Number(slot.confirmedCount || 0);
    const pendingCount = Number(slot.pendingCount || 0);
    if (!Number.isInteger(capacity) || capacity < 1) throw new HttpsError('failed-precondition', '시간대 정원 설정이 올바르지 않습니다.');
    if (confirmedCount + pendingCount >= capacity) throw new HttpsError('resource-exhausted', '잔여석이 없습니다.');

    // 8회까지 자동 확정, 9회차부터 관리자 승인
    let status = 'confirmed';
    let reason = '';
    if (AUTO_APPROVE_LIMIT > 0 && activeCount >= AUTO_APPROVE_LIMIT) {
      status = 'pending';
      reason = 'limit';
    }

    const appData = {
      slotId,
      uid,
      sid: profile.sid || auth.token.sid || '',
      name: profile.name || '학생',
      status,
      date: slot.date,
      start: slot.start,
      end: slot.end,
      topic: slot.topic,
      room: slot.room,
      attendance: 'unchecked',
      autoConfirmed: status === 'confirmed',
      createdAt: timestamp(),
      createdAtMillis: nowMillis(),
      updatedAt: timestamp(),
      updatedAtMillis: nowMillis()
    };
    if (status === 'confirmed') {
      appData.decidedAt = timestamp();
      appData.decidedAtMillis = nowMillis();
      appData.decidedByUid = 'auto';
    }
    tx.set(appRef, appData);
    const slotPatch = { updatedAt: timestamp(), updatedAtMillis: nowMillis() };
    if (status === 'confirmed') slotPatch.confirmedCount = confirmedCount + 1;
    else slotPatch.pendingCount = pendingCount + 1;
    tx.update(slotRef, slotPatch);
    result = { appId, status, reason };
  });

  await audit('applyReservation', auth, { slotId, appId, status: result.status });
  return result;
});

exports.cancelReservation = onCall(async (request) => {
  const auth = requireAuth(request);
  const appId = cleanString(String(request.data && request.data.appId || ''), 'appId', 220);
  const appRef = db.collection('applications').doc(appId);
  let slotId = null;

  await db.runTransaction(async (tx) => {
    const appSnap = await tx.get(appRef);
    if (!appSnap.exists) throw new HttpsError('not-found', '신청 내역을 찾을 수 없습니다.');
    const app = appSnap.data();
    if (auth.token.role !== 'admin' && app.uid !== auth.uid) throw new HttpsError('permission-denied', '본인 신청만 취소할 수 있습니다.');
    if (!statusActive(app.status)) throw new HttpsError('failed-precondition', '이미 처리된 신청입니다.');
    if (['present', 'late', 'absent'].includes(app.attendance)) throw new HttpsError('failed-precondition', '출석 처리된 신청은 취소할 수 없습니다.');

    slotId = app.slotId;
    const slotRef = db.collection('slots').doc(app.slotId);
    const slotSnap = await tx.get(slotRef);
    const slot = slotSnap.exists ? slotSnap.data() : {};
    const patch = { updatedAt: timestamp(), updatedAtMillis: nowMillis() };
    if (app.status === 'pending') patch.pendingCount = Math.max(0, Number(slot.pendingCount || 0) - 1);
    if (app.status === 'confirmed') patch.confirmedCount = Math.max(0, Number(slot.confirmedCount || 0) - 1);
    if (slotSnap.exists) tx.update(slotRef, patch);
    tx.update(appRef, {
      status: 'cancelled',
      cancelledAt: timestamp(),
      cancelledAtMillis: nowMillis(),
      cancelledByUid: auth.uid,
      updatedAt: timestamp(),
      updatedAtMillis: nowMillis()
    });
  });

  await audit('cancelReservation', auth, { appId, slotId });
  return { appId, status: 'cancelled' };
});

exports.decideApplication = onCall(async (request) => {
  const auth = requireAdmin(request);
  const appId = cleanString(String(request.data && request.data.appId || ''), 'appId', 220);
  const decision = cleanString(String(request.data && request.data.decision || ''), 'decision', 20);
  if (!['confirmed', 'rejected'].includes(decision)) throw new HttpsError('invalid-argument', 'decision은 confirmed 또는 rejected여야 합니다.');

  const appRef = db.collection('applications').doc(appId);
  let slotId = null;
  await db.runTransaction(async (tx) => {
    const appSnap = await tx.get(appRef);
    if (!appSnap.exists) throw new HttpsError('not-found', '신청 내역을 찾을 수 없습니다.');
    const app = appSnap.data();
    if (app.status !== 'pending') throw new HttpsError('failed-precondition', '대기 상태의 신청만 처리할 수 있습니다.');
    slotId = app.slotId;
    const slotRef = db.collection('slots').doc(app.slotId);
    const slotSnap = await tx.get(slotRef);
    if (!slotSnap.exists) throw new HttpsError('not-found', '시간대를 찾을 수 없습니다.');
    const slot = slotSnap.data();
    const pendingCount = Number(slot.pendingCount || 0);
    const confirmedCount = Number(slot.confirmedCount || 0);
    const capacity = Number(slot.capacity || 0);

    if (decision === 'confirmed') {
      if (confirmedCount >= capacity) throw new HttpsError('resource-exhausted', '확정 정원이 이미 가득 찼습니다.');
      tx.update(appRef, {
        status: 'confirmed',
        attendance: 'unchecked',
        decidedAt: timestamp(),
        decidedAtMillis: nowMillis(),
        decidedByUid: auth.uid,
        updatedAt: timestamp(),
        updatedAtMillis: nowMillis()
      });
      tx.update(slotRef, {
        pendingCount: Math.max(0, pendingCount - 1),
        confirmedCount: confirmedCount + 1,
        updatedAt: timestamp(),
        updatedAtMillis: nowMillis()
      });
    } else {
      tx.update(appRef, {
        status: 'rejected',
        decidedAt: timestamp(),
        decidedAtMillis: nowMillis(),
        decidedByUid: auth.uid,
        updatedAt: timestamp(),
        updatedAtMillis: nowMillis()
      });
      tx.update(slotRef, {
        pendingCount: Math.max(0, pendingCount - 1),
        updatedAt: timestamp(),
        updatedAtMillis: nowMillis()
      });
    }
  });

  await audit('decideApplication', auth, { appId, slotId, decision });
  return { appId, status: decision };
});

exports.setAttendance = onCall(async (request) => {
  const auth = requireAdmin(request);
  const appId = cleanString(String(request.data && request.data.appId || ''), 'appId', 220);
  const attendance = cleanString(String(request.data && request.data.attendance || ''), 'attendance', 20);
  if (!['unchecked', 'present', 'late', 'absent'].includes(attendance)) throw new HttpsError('invalid-argument', '출석 상태가 올바르지 않습니다.');
  const appRef = db.collection('applications').doc(appId);
  const appSnap = await appRef.get();
  if (!appSnap.exists) throw new HttpsError('not-found', '신청 내역을 찾을 수 없습니다.');
  if (appSnap.data().status !== 'confirmed') throw new HttpsError('failed-precondition', '확정된 예약자만 출석 처리할 수 있습니다.');

  await appRef.update({
    attendance,
    attendanceCheckedAt: attendance === 'unchecked' ? null : timestamp(),
    attendanceCheckedAtMillis: attendance === 'unchecked' ? null : nowMillis(),
    attendanceCheckedBy: attendance === 'unchecked' ? null : (auth.token.name || '관리자'),
    attendanceCheckedByUid: attendance === 'unchecked' ? null : auth.uid,
    updatedAt: timestamp(),
    updatedAtMillis: nowMillis()
  });
  await audit('setAttendance', auth, { appId, attendance });
  return { appId, attendance };
});

exports.addSlot = onCall(async (request) => {
  const auth = requireAdmin(request);
  const data = request.data || {};
  const date = cleanDate(data.date);
  const start = cleanTime(data.start, '시작시간');
  const end = cleanTime(data.end, '종료시간');
  if (start >= end) throw new HttpsError('invalid-argument', '종료시간은 시작시간보다 늦어야 합니다.');
  const topic = cleanString(String(data.topic || ''), '실습 주제', 120);
  const room = optionalCleanString(data.room, '실습실', 80, '미지정');
  const capacity = cleanCapacity(data.capacity);
  const visible = data.visible === true;
  const openAtMillis = cleanOpenAtMillis(data.openAtMillis);

  const ref = db.collection('slots').doc();
  await ref.set({
    date,
    start,
    end,
    topic,
    room,
    capacity,
    visible,
    openAtMillis,
    confirmedCount: 0,
    pendingCount: 0,
    createdByUid: auth.uid,
    createdAt: timestamp(),
    createdAtMillis: nowMillis(),
    updatedAt: timestamp(),
    updatedAtMillis: nowMillis()
  });
  await audit('addSlot', auth, { slotId: ref.id, date, start, end, capacity, visible, openAtMillis });
  return { slotId: ref.id };
});

exports.updateSlotVisibility = onCall(async (request) => {
  const auth = requireAdmin(request);
  const data = request.data || {};
  const slotId = cleanString(String(data.slotId || ''), 'slotId', 120);
  const visible = cleanBoolean(data.visible, '공개여부');
  const openAtMillis = cleanOpenAtMillis(data.openAtMillis);
  const ref = db.collection('slots').doc(slotId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', '시간대를 찾을 수 없습니다.');
  await ref.update({
    visible,
    openAtMillis,
    visibilityUpdatedByUid: auth.uid,
    visibilityUpdatedAt: timestamp(),
    visibilityUpdatedAtMillis: nowMillis(),
    updatedAt: timestamp(),
    updatedAtMillis: nowMillis()
  });
  await audit('updateSlotVisibility', auth, { slotId, visible, openAtMillis });
  return { slotId, visible, openAtMillis };
});

exports.updateSlot = onCall(async (request) => {
  const auth = requireAdmin(request);
  const data = request.data || {};
  const slotId = cleanString(String(data.slotId || ''), 'slotId', 120);
  const ref = db.collection('slots').doc(slotId);
  let out = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', '시간대를 찾을 수 없습니다.');
    const slot = snap.data();
    const patch = { updatedAt: timestamp(), updatedAtMillis: nowMillis(), updatedByUid: auth.uid };
    if (data.capacity !== undefined) {
      const cap = cleanCapacity(data.capacity);
      const occupied = Number(slot.confirmedCount || 0) + Number(slot.pendingCount || 0);
      if (cap < occupied) throw new HttpsError('failed-precondition', `이미 ${occupied}명이 차 있어 정원을 그보다 작게 줄일 수 없습니다.`);
      patch.capacity = cap;
    }
    if (data.topic !== undefined) patch.topic = cleanString(String(data.topic || ''), '실습 주제', 120);
    if (data.room !== undefined) patch.room = optionalCleanString(data.room, '실습실', 80, '미지정');
    if (data.start !== undefined || data.end !== undefined) {
      const start = cleanTime(data.start !== undefined ? data.start : slot.start, '시작시간');
      const end = cleanTime(data.end !== undefined ? data.end : slot.end, '종료시간');
      if (start >= end) throw new HttpsError('invalid-argument', '종료시간은 시작시간보다 늦어야 합니다.');
      patch.start = start;
      patch.end = end;
    }
    tx.update(ref, patch);
    out = { slotId, capacity: patch.capacity !== undefined ? patch.capacity : Number(slot.capacity || 0) };
  });
  await audit('updateSlot', auth, { slotId, fields: Object.keys(data).filter(k => k !== 'slotId') });
  return out;
});

exports.setSlotClosed = onCall(async (request) => {
  const auth = requireAdmin(request);
  const slotId = cleanString(String(request.data && request.data.slotId || ''), 'slotId', 120);
  const closed = cleanBoolean(request.data && request.data.closed, '마감여부');
  const ref = db.collection('slots').doc(slotId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', '시간대를 찾을 수 없습니다.');
  await ref.update({ closed, closedUpdatedByUid: auth.uid, updatedAt: timestamp(), updatedAtMillis: nowMillis() });
  await audit('setSlotClosed', auth, { slotId, closed });
  return { slotId, closed };
});

exports.deleteSlot = onCall(async (request) => {
  const auth = requireAdmin(request);
  const slotId = cleanString(String(request.data && request.data.slotId || ''), 'slotId', 120);
  const slotRef = db.collection('slots').doc(slotId);
  const slotSnap = await slotRef.get();
  if (!slotSnap.exists) throw new HttpsError('not-found', '시간대를 찾을 수 없습니다.');
  let deleted = 0;
  // 해당 시간대의 신청 문서를 배치로 삭제
  while (true) {
    const q = await db.collection('applications').where('slotId', '==', slotId).limit(300).get();
    if (q.empty) break;
    const batch = db.batch();
    q.forEach(d => batch.delete(d.ref));
    await batch.commit();
    deleted += q.size;
    if (q.size < 300) break;
  }
  await slotRef.delete();
  await audit('deleteSlot', auth, { slotId, deletedApplications: deleted });
  return { slotId, deletedApplications: deleted };
});

exports.createStudentAccount = onCall(async (request) => {
  const auth = requireAdmin(request);
  const sid = cleanSid(request.data && request.data.sid);
  const name = cleanString(String(request.data && request.data.name || ''), '이름', 50);
  let password = cleanPassword(request.data && request.data.password, true);
  let generated = false;
  if (!password) {
    password = randomPassword();
    generated = true;
  }
  const email = emailForSid(sid);

  let userRecord;
  try {
    userRecord = await admin.auth().getUserByEmail(email);
    throw new HttpsError('already-exists', '이미 등록된 학생 계정입니다.');
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    if (error.code !== 'auth/user-not-found') throw new HttpsError('internal', error.message || '계정 확인 중 오류가 발생했습니다.');
  }

  userRecord = await admin.auth().createUser({ email, password, displayName: name, disabled: false });
  await admin.auth().setCustomUserClaims(userRecord.uid, { role: 'student', sid });
  await db.collection('profiles').doc(userRecord.uid).set({
    role: 'student',
    sid,
    name,
    email,
    pwChanged: false,
    disabled: false,
    createdByUid: auth.uid,
    createdAt: timestamp(),
    createdAtMillis: nowMillis(),
    updatedAt: timestamp(),
    updatedAtMillis: nowMillis()
  });
  await audit('createStudentAccount', auth, { uid: userRecord.uid, sid });
  return { uid: userRecord.uid, sid, name, email, tempPassword: generated ? password : '', passwordGenerated: generated };
});

exports.resetStudentPassword = onCall(async (request) => {
  const auth = requireAdmin(request);
  const uid = cleanString(String(request.data && request.data.uid || ''), 'uid', 128);
  const profile = await getProfile(uid);
  if (profile.role !== 'student') throw new HttpsError('failed-precondition', '학생 계정만 초기화할 수 있습니다.');
  const tempPassword = randomPassword();
  await admin.auth().updateUser(uid, { password: tempPassword });
  await db.collection('profiles').doc(uid).update({
    pwChanged: false,
    passwordResetAt: timestamp(),
    passwordResetAtMillis: nowMillis(),
    passwordResetByUid: auth.uid,
    updatedAt: timestamp(),
    updatedAtMillis: nowMillis()
  });
  await audit('resetStudentPassword', auth, { uid, sid: profile.sid || '' });
  return { uid, sid: profile.sid || '', tempPassword };
});

exports.markPasswordChanged = onCall(async (request) => {
  const auth = requireAuth(request);
  await db.collection('profiles').doc(auth.uid).set({
    pwChanged: true,
    passwordChangedAt: timestamp(),
    passwordChangedAtMillis: nowMillis(),
    updatedAt: timestamp(),
    updatedAtMillis: nowMillis()
  }, { merge: true });
  await audit('markPasswordChanged', auth, { uid: auth.uid });
  return { ok: true };
});
