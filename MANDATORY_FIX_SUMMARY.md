# 필수 보안 수정 반영 요약

이 패키지는 기존 단일 HTML 자율실습 예약시스템을 운영 보안형 구조로 바꾼 전환본입니다.

## 반영 완료

1. 익명 로그인 제거
   - 기존 `signInAnonymously()` 구조를 제거했습니다.
   - Firebase Authentication 이메일/비밀번호 계정으로 로그인합니다.

2. `accounts/{학번}` + `pwHash` 로그인 제거
   - 학생 비밀번호를 Firestore 문서에 보관하지 않습니다.
   - 비밀번호는 Firebase Authentication이 관리합니다.

3. 관리자 자동 생성 제거
   - `admin / 1234` 자동 생성 구조가 없습니다.
   - 최초 관리자 권한은 `scripts/set-admin-claim.js`로 별도 부여합니다.

4. 예약 신청/취소를 Cloud Functions로 이동
   - `applyReservation`에서 중복 신청, 1인 최대 8회, 정원 초과를 서버에서 검증합니다.
   - Firestore Transaction으로 정원 카운터와 신청 문서를 원자적으로 처리합니다.

5. 관리자 승인/반려/출석/시간대/계정관리를 Cloud Functions로 이동
   - `decideApplication`, `setAttendance`, `addSlot`, `createStudentAccount`, `resetStudentPassword`를 서버 함수로 처리합니다.
   - 관리자 custom claim이 없으면 호출이 거부됩니다.

6. Firestore 직접 쓰기 차단
   - `firestore.rules`에서 클라이언트의 create/update/delete를 차단했습니다.
   - 학생은 본인 신청만 읽을 수 있고, 관리자는 전체 조회가 가능합니다.

7. 영화관식 자리 선점 유지
   - 잔여석 = 정원 - 확정 - 대기
   - pending도 좌석을 점유하므로 20석에서 21번째 신청은 서버에서 거절됩니다.

8. 네트워크/동시 신청 안내 개선
   - 네트워크 오류 메시지와 처리 후 내 신청 현황 재조회 흐름을 유지했습니다.

## 아직 Firebase 콘솔에서 해야 할 일

- Firebase config 입력
- Email/Password 로그인 활성화
- 최초 관리자 계정 생성
- `scripts/set-admin-claim.js` 실행
- Functions 배포
- Firestore Rules 배포
- Hosting 배포

자세한 순서는 `DEPLOY_CHECKLIST.md`를 보세요.
