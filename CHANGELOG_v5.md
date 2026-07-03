# v5 변경 요약 (보안 구조 유지 + 빠진 규칙 3종 추가)

기존 secure_v4의 보안 구조(Cloud Functions 전용 쓰기, custom claim 권한, Firestore 직접 쓰기 차단)는 그대로 두고, 아래 3가지 운영 규칙을 **서버에서 강제**하도록 추가했습니다.

## 1. 같은 주 1회 제한 (주 1회)
- `functions/index.js`의 `applyReservation` 트랜잭션에서 강제합니다.
- `settings/semester`의 `week1Start`(1주차 시작 월요일)를 기준으로 학사 주차를 계산하고,
  같은 주차에 이미 활성(대기/확정) 신청이 있으면 거절합니다.
- 상수: `MAX_PER_WEEK = 1` (0이면 비활성).
- ⚠️ **반드시 관리자 화면 '학기 설정'에서 week1Start(예: 2026-08-31)를 저장해야** 이 규칙이 동작합니다.
  설정이 없으면 주 제한은 자동으로 비활성화됩니다(안전한 폴백).

## 2. 8회까지 자동확정 / 9회차부터 관리자 승인
- 기존 "동시 8건 하드 상한(8건째에서 거절)"을 제거했습니다.
- 학생의 누적 활성 신청이 8건 미만이면 신청 즉시 **자동 확정(confirmed)**,
  8건 이상이면 9회차부터 **승인 대기(pending)**로 들어가 관리자 승인이 필요합니다.
- 상수: `AUTO_APPROVE_LIMIT = 8` (0이면 항상 승인 대상).
- 자동 확정된 신청은 `autoConfirmed: true`, `decidedByUid: 'auto'`로 기록됩니다.
- 응답에 `{status, reason}`를 반환하여 화면에서 "즉시 확정 / 승인 대기"를 구분 안내합니다.

## 3. 시간대 수정 · 마감 · 삭제
- 신규 Cloud Functions(관리자 전용):
  - `updateSlot` — 정원/주제/실습실/시간 수정. 정원은 이미 찬 인원보다 작게 줄일 수 없습니다.
  - `setSlotClosed` — 시간대 마감/마감해제. 마감되면 학생 신청이 서버에서 거절됩니다.
  - `deleteSlot` — 시간대 삭제(해당 시간대의 신청 문서까지 배치 삭제).
- 모든 동작은 `auditLogs`에 기록됩니다.
- 화면: 시간대 관리 행에 '정원 수정 / 마감 / 삭제' 버튼, 학생 카드에는 마감 표시를 추가했습니다.

## 배포 시 필수
1. `firebase deploy --only functions` (신규 함수 포함 재배포)
2. `firebase deploy --only hosting` (수정된 public/index.html 반영)
3. Firestore Rules는 변경 없음(재배포 불필요하나, 함께 배포해도 무방).
4. 관리자 화면에서 **학기 설정의 week1Start 저장** 확인(주 1회 규칙 활성화 조건).

정적 문법 검사(`node --check`)는 functions/index.js, public/index.html 모두 통과했습니다.
실제 동작·동시성·규칙은 Firebase Emulator 또는 테스트 프로젝트에서 통합 검증을 권장합니다.
