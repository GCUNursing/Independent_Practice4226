# Firebase 콘솔 배포 · 권한 적용 체크리스트

교수님이 실제 배포를 시도할 때 확인해야 할 항목입니다.

## 1. Firebase 콘솔에서 준비

1. Firebase 프로젝트 선택
2. Authentication 활성화
3. Authentication > Sign-in method > 이메일/비밀번호 로그인 활성화
4. Firestore Database 생성 또는 기존 DB 확인
5. Firestore 위치는 가능하면 `asia-northeast3` 또는 기존 프로젝트 위치 유지
6. Hosting 활성화
7. Functions 사용 가능 요금제 확인
   - Cloud Functions는 일반적으로 Blaze 요금제가 필요할 수 있습니다.

## 2. 웹앱 설정값 입력

`public/index.html`의 `firebaseConfig`를 교수님 프로젝트 값으로 교체합니다.

```js
const firebaseConfig = {
  apiKey: "...",
  authDomain: "...firebaseapp.com",
  projectId: "...",
  storageBucket: "...appspot.com",
  messagingSenderId: "...",
  appId: "..."
};
```

## 3. 최초 관리자 계정 생성

Firebase 콘솔 > Authentication > Users에서 관리자 계정을 먼저 만듭니다.

권장 이메일:

```text
admin@practice.local
```

또는 교수님 실제 이메일을 사용해도 됩니다. 단, 웹 로그인창에는 이메일 전체를 입력해야 합니다.

## 4. 최초 관리자 custom claim 부여

관리자 계정은 Firebase Auth 계정만 있어서는 부족하고, custom claim이 필요합니다.

```bash
cd autonomous_practice_secure
cd scripts
npm install
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
node set-admin-claim.js YOUR_PROJECT_ID admin@practice.local "이재겸 교수"
```

Windows PowerShell:

```powershell
cd autonomous_practice_secure\scripts
npm install
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\service-account.json"
node set-admin-claim.js YOUR_PROJECT_ID admin@practice.local "이재겸 교수"
```

## 5. Functions 설치 및 배포

```bash
cd autonomous_practice_secure/functions
npm install
npm run lint:syntax
cd ..
firebase deploy --only functions
```

## 6. Firestore Rules 적용

```bash
firebase deploy --only firestore:rules
```

또는 Firebase 콘솔 > Firestore Database > Rules에 `firestore.rules` 내용을 붙여넣고 Publish합니다.

## 7. Hosting 배포

```bash
firebase deploy --only hosting
```

## 8. 학생 계정 생성

관리자로 로그인한 뒤:

```text
계정 탭 → 엑셀 업로드 또는 직접 추가
```

엑셀 열 순서:

```text
학번 | 이름 | 임시비밀번호(선택)
```

임시비밀번호를 비워두면 서버가 자동 생성하고, 브라우저가 `student-temporary-passwords.csv`를 다운로드합니다.

## 9. 보안 테스트

Firebase 콘솔 > Firestore Rules Playground 또는 Emulator로 다음을 확인합니다.

- 학생 A가 학생 B의 `applications` 문서를 읽을 수 없어야 함
- 학생이 `slots`의 `confirmedCount` 또는 `pendingCount`를 직접 수정할 수 없어야 함
- 학생이 `applications.status`를 직접 `confirmed`로 바꿀 수 없어야 함
- 학생이 `profiles` 전체 목록을 볼 수 없어야 함
- 관리자는 전체 `applications`, `profiles`, `auditLogs`를 읽을 수 있어야 함

## 10. 나중에 교수님께 꼭 다시 안내해야 할 핵심

- Firebase 콘솔에서 이메일/비밀번호 로그인을 켰는지
- 최초 관리자 계정에 custom claim을 줬는지
- `firestore.rules`가 배포됐는지
- `functions/index.js`가 배포됐는지
- `public/index.html`의 Firebase config가 실제 프로젝트 값인지
- 기존의 `allow read, write: if request.auth != null;` 규칙이 남아 있지 않은지


## 운영 정책 확인

- 현재 서버 정책은 1인 최대 8회 신청입니다.
- 정책 변경 시 `functions/index.js`의 `MAX_PER_STUDENT` 값을 수정한 뒤 Functions를 다시 배포해야 합니다.
- Firestore Rules만 바꿔서는 신청 횟수 제한이 바뀌지 않습니다.

## v3/v4 배포 후 추가 확인

Cloud Functions 배포 후 다음 함수가 함께 배포되었는지 확인하세요.

- `saveSemesterSettings`
- `listVisibleSlots`
- `updateSlotVisibility`
- `applyReservation`
- `addSlot`

Firestore Rules 적용 후에는 학생 계정으로 `slots` 컬렉션을 직접 읽을 수 없어야 합니다. 학생 화면은 `listVisibleSlots` 함수를 통해 공개된 시간대만 표시됩니다.

관리자 최초 로그인 후 반드시 다음 순서로 확인하세요.

1. `학기` 탭에서 학년도, 학기, 1주차 시작일, 총 주차, 운영 요일 저장
2. `시간` 탭에서 테스트 시간대 1개 생성
3. 해당 시간대를 비공개 상태로 둔 뒤 학생 계정에서 보이지 않는지 확인
4. 같은 시간대를 즉시 공개로 변경한 뒤 학생 계정에서 보이는지 확인
5. 노출예약 시각을 미래로 설정한 뒤 학생 계정에서 보이지 않는지 확인
6. 노출예약 시각 이후 학생 계정에서 보이는지 확인
7. 학생 신청 후 관리자 `승인`, `출석`, `통계` 탭에서 값이 연동되는지 확인



## v4 화면 구조 확인

배포 후 실제 브라우저에서 다음을 확인하세요.

1. 학생 계정으로 모바일 접속
   - 주차 선택 → 날짜 선택 → 시간 선택 순서가 자연스럽게 보이는지
   - 신청 버튼이 충분히 크고 터치하기 쉬운지
   - 내 신청 현황이 같은 화면 하단에서 확인되는지

2. 학생 계정으로 PC 접속
   - 학생 화면은 PC에서도 복잡한 관리자형 대시보드가 아니라 단순 신청 화면으로 유지되는지

3. 관리자 계정으로 PC 접속
   - 좌측 메뉴와 우측 작업 영역이 분리되어 보이는지
   - 승인, 출석, 시간, 학기, 계정, 통계 메뉴가 정상 전환되는지

4. 관리자 계정으로 모바일 접속
   - 관리자 메뉴가 상단 가로 스크롤 메뉴로 전환되는지
   - 승인/출석/간단 조회가 가능한지

엑셀 업로드, 대량 계정 생성, 전체 통계 확인은 PC에서 진행하는 것을 권장합니다.
