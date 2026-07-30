// Claude API 직접 호출 (HANOK 표준 패턴)
// Vercel 환경변수: VITE_ANTHROPIC_API_KEY

const API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-sonnet-4-6'

function buildSystemPrompt(work, prevReview) {
  const timeline = work.timeline.length
    ? work.timeline.join('\n')
    : '(아직 확정된 회차 없음 — 이번 원고가 첫 감수 대상)'

  const prevSection = prevReview
    ? `
=== 재감수 모드 ===
아래는 같은 회차의 직전 감수 리포트다. 이번 원고는 이 리포트를 반영해 수정된 개정고이다.
1) 직전 지적사항 각각이 해결됐는지 "이전지적처리" 배열로 판정한다 (해결/부분해결/미해결).
2) 이미 해결된 지적을 새 지적으로 중복 제기하지 않는다.
3) 수정 과정에서 새로 생긴 문제가 있으면 해당 카테고리에 신규 지적으로 올린다.

--- 직전 리포트 (${prevReview.episode}, 점수 ${prevReview.report?.점수 ?? '-'}) ---
${JSON.stringify(prevReview.report, null, 1).slice(0, 6000)}
`
    : ''

  const prevField = prevReview
    ? `\n  "이전지적처리": [{"지적": "직전 지적 요지(20자 내)", "처리": "해결|부분해결|미해결", "코멘트": ""}],`
    : ''

  return `당신은 1인 창작 기업 HANOK의 웹소설 설정 감수 담당 AI 직원이다.
아래 작품의 설정 문서 3종과 확정 타임라인을 절대 기준으로 삼아, 투입된 회차 원고를 감수한다.

=== 작품: ${work.title} ===
장르/연재 조건: ${work.genre}

--- 문서 1. 기획안 ---
${work.docs.plan}

--- 문서 2. 설정집 ---
${work.docs.world}

--- 문서 3. 인물집 ---
${work.docs.characters}

--- 확정 타임라인 (이미 발행/확정된 회차의 사실) ---
${timeline}
${prevSection}
=== 감수 체크리스트 ===
1. 설정오류: 세계관 규칙 위반 (예: 아틀라스가 음성으로 말함, 등급제 규칙 모순, 조기 반전 노출 등)
2. 인물불일치: 말버릇·성격·관계·아크 단계 위반, 타임라인과 어긋나는 시계열 오류
3. 문체지적: 작품 문체 기준 이탈, AI 냄새 나는 상투 표현, 늘어지는 문장
4. 떡밥체크: 이번 화가 건드린 떡밥이 기획안의 심는/회수 계획과 맞는가, 조기 회수/방치 여부
5. 분량판정: 목표 분량 대비 평가
6. 훅판정: 회차 말미가 다음 화 클릭을 유도하는가

=== 출력 규칙 ===
반드시 아래 JSON 형식으로만 응답한다. 마크다운 코드펜스, 인사말, 설명 등 JSON 외 텍스트를 절대 포함하지 않는다.
각 지적 항목에는 원고의 근거 대목(20자 내 인용)과 수정 제안을 포함한다.
문제가 없는 카테고리는 빈 배열로 둔다. 심각도: "높음" | "중간" | "낮음".

{
  "총평": "3~4문장 종합 평가",
  "점수": 0~100 정수,${prevField}
  "설정오류": [{"심각도": "", "대목": "", "지적": "", "수정제안": ""}],
  "인물불일치": [{"심각도": "", "대목": "", "지적": "", "수정제안": ""}],
  "문체지적": [{"심각도": "", "대목": "", "지적": "", "수정제안": ""}],
  "떡밥체크": [{"떡밥": "", "상태": "", "코멘트": ""}],
  "분량판정": {"자수": 0, "판정": ""},
  "훅판정": {"통과": true, "코멘트": ""},
  "타임라인요약": "이번 화에서 새로 확정된 사실을 2~3문장으로 (인물 등장, 사건, 심어진 떡밥 포함)"
}`
}

export async function reviewManuscript(work, episodeLabel, manuscript, prevReview = null) {
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('VITE_ANTHROPIC_API_KEY가 설정되지 않았습니다. Vercel 환경변수를 확인하세요.')
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: buildSystemPrompt(work, prevReview),
      messages: [
        {
          role: 'user',
          content: `[감수 대상: ${episodeLabel}${prevReview ? ' — 재감수(개정고)' : ''}]\n\n${manuscript}`
        }
      ]
    })
  })

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`API 오류 (${res.status}): ${errBody.slice(0, 200)}`)
  }

  const data = await res.json()
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')

  const clean = text.replace(/```json|```/g, '').trim()
  try {
    return JSON.parse(clean)
  } catch {
    const start = clean.indexOf('{')
    const end = clean.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(clean.slice(start, end + 1))
    }
    throw new Error('감수 결과 JSON 파싱 실패. 다시 실행해 주세요.')
  }
}
