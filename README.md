# 자율실습 예약시스템 보안형 전환본

이 전환본은 기존 단일 HTML 파일의 화면 구조를 최대한 유지하면서 보안 구조를 바꾼 버전입니다.

## 바뀐 핵심 구조

- 익명 로그인 제거
- `accounts/{학번}` + `pwHash` 로그인 제거
- Firebase Authentication 실제 계정 사용
- 관리자/학생 권한은 Firebase Auth custom claims로 판정
- 학생 예약 신청/취소, 관리자 승인/반려/출석/계정 생성/비밀번호 초기화는 Cloud Functions에서만 처리
- Firestore Rules는 클라이언트의 직접 쓰기를 차단
- 학생은 본인 신청 내역만 읽을 수 있음
- 관리자만 전체 신청, 전체 프로필, 감사 로그를 읽을 수 있음

## 파일 구조

```text
public/index.html              보안형 웹앱
functions/index.js             서버 검증 로직
functions/package.json         Cloud Functions 의존성
firestore.rules                Firestore 보안 규칙
firebase.json                  Hosting / Firestore / Functions 배포 설정
scripts/set-admin-claim.js     최초 관리자 custom claim 설정 스크립트
DEPLOY_CHECKLIST.md            교수님 배포 단계 체크리스트
```

## 데이터 구조

```text
profiles/{uid}
  role: "student" | "admin"
  sid: "20231234" 또는 "admin"
  name
  email
  pwChanged

slots/{slotId}
  date, start, end, topic, room, capacity
  confirmedCount, pendingCount

applications/{slotId}__{uid}
  slotId, uid, sid, name
  status: "pending" | "confirmed" | "rejected" | "cancelled"
  attendance: "unchecked" | "present" | "late" | "absent"

auditLogs/{logId}
  서버 함수 처리 이력
```

## 운영 전 필수 확인

운영 전에는 `DEPLOY_CHECKLIST.md`의 순서대로 진행해야 합니다.
특히 최초 관리자 계정에 custom claim을 부여하지 않으면 관리자 로그인이 되더라도 관리자 화면 권한이 열리지 않습니다.


## 현재 적용된 운영 정책

- 1인 최대 신청 수: 8회
- 정원 계산: 확정 + 대기 합산 방식, 즉 영화관 예매처럼 신청 즉시 자리를 선점합니다.
- 잔여석 경쟁 처리: Cloud Function 내부 Firestore Transaction에서 정원과 중복을 원자적으로 검사합니다.
- 클라이언트 직접 쓰기: Firestore Rules에서 차단되어 있습니다.

`functions/index.js`의 `MAX_PER_STUDENT` 값을 바꾸면 1인 최대 신청 수 정책을 조정할 수 있습니다. 0으로 바꾸면 무제한입니다.

## v3 반영 기능

이번 버전에는 다음 운영 기능이 추가되었습니다.

- 관리자 학기 설정: 학년도, 학기, 1주차 시작일, 총 주차, 운영 요일
- 학생 신청 흐름: 주차 선택 → 날짜 선택 → 시간 선택 → 신청
- 관리자 시간대 공개/비공개/노출예약
- 학생의 시간대 직접 조회 차단 및 Cloud Function 기반 공개 목록 제공
- `applyReservation`에서 노출 전/비공개 시간대 신청 차단
- 관리자 학생별 자율실습 진행 통계 및 CSV 다운로드

v4에서는 학생 모바일 우선 화면과 관리자 PC 대시보드 구조가 추가되었습니다. 자세한 내용은 `V3_FEATURE_SUMMARY.md`, `V4_FEATURE_SUMMARY.md`, `TEST_REPORT.md`를 확인하세요.



## v4 반영 기능

이번 버전에는 사용자 유형별 화면 구조가 추가되었습니다.

- 학생 화면: 모바일 앱형 흐름으로 구성
- 학생 신청 흐름: 주차 → 날짜 → 시간 → 신청 → 내 신청 현황
- 관리자 화면: PC 대시보드형 좌측 메뉴 + 우측 작업 영역
- 관리자 모바일: 좌측 메뉴가 상단 가로 메뉴로 자동 전환
- 서버 보안 로직은 v3와 동일하게 유지

운영 권장 환경:

```text
학생: 모바일 사용 권장
관리자: PC 사용 권장, 모바일은 승인·출석·간단 조회용
```
