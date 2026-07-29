# edge writer v1.0 — 설정 감수실

작품별 설정 문서(기획안·설정집·인물집)를 학습한 AI가 회차 원고를 교정하는 HANOK 감수 에이전트 PWA.

## 배포 (표준 절차)

1. GitHub 새 저장소 생성 → 이 폴더 전체 푸시
2. Vercel → Import Project → **Framework: Other 아님, Vite 자동 인식 (안 되면 Vite 선택)**
   - Build Command: `npm run build`
   - Output Directory: `dist`
3. Vercel 환경변수 등록: `VITE_ANTHROPIC_API_KEY` = Anthropic API 키
4. Deploy

로컬 테스트: `npm install` → 루트에 `.env` 파일 생성(`VITE_ANTHROPIC_API_KEY=sk-ant-...`) → `npm run dev`

## 사용 흐름

1. **작품 서재**에서 작품 선택 (기본으로 『최약체 회귀병사』 요약본 시드 포함 — '문서 편집'에서 전문으로 교체 권장)
2. 새 작품은 **+ 작품 등록** → 3종 문서 붙여넣기
3. 회차 표기 + 원고 붙여넣기 → **감수 실행**
4. 리포트 확인 (설정 오류 / 인물 불일치 / 문체 / 떡밥 / 분량 / 훅)
5. 문제없으면 **타임라인 반영** — 이후 회차 감수 시 시계열 오류 검출 기준으로 사용됨

## 데이터

- 작품·타임라인은 브라우저 localStorage에 저장 (기기별 독립)
- 기기 이전/보호용으로 **백업 내보내기/불러오기** (JSON) 제공
- 갤럭시 탭 ↔ PC 간 동기화는 백업 파일로 수동 이전

## 구조

```
src/
  App.jsx         메인 UI (서재/감수/리포트/타임라인/모달)
  api.js          시스템 프롬프트 조립 + Claude API 호출 (claude-sonnet-4-6)
  defaultWork.js  시드 작품 데이터 (최약체 회귀병사 요약본)
  styles.css      원고지 × 빨간펜 교정 컨셉
```

## 감수 체크리스트 (api.js 시스템 프롬프트)

설정오류 / 인물불일치(타임라인 대조 포함) / 문체지적 / 떡밥체크 / 분량판정 / 훅판정 — JSON 구조화 출력.
