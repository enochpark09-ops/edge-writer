// 감수 호출 — 감(설정) / 어사(수위·법무) / 도목수(구조)
//
// v2 변경점
//   1. API 키를 더 이상 브라우저에서 읽지 않는다. /api/review 서버리스 함수를 통해 부른다.
//      (기존 VITE_ANTHROPIC_API_KEY는 빌드 시 번들에 박혀 공개되고 있었다)
//   2. 감수를 셋으로 나눴다. 하나의 프롬프트가 설정 모순과 수위 위반과
//      페이스 문제를 동시에 보면 어느 하나가 흐려지기 때문이다.
//   3. 감수 종류마다 필요한 문서만 주입한다.

const ENDPOINT = '/api/review'

// 감수 종류별 정의 — 어떤 문서를 먹일지, 무엇을 볼지, 어떤 JSON을 낼지
export const REVIEW_KINDS = {
  gam: {
    key: 'gam',
    name: '감',
    hanja: '監',
    role: '설정 일관성',
    desc: '설정집·인물집과의 모순, 문체, 분량, 훅',
    docs: ['plan', 'world', 'characters', 'schema'],
    sections: [
      { key: '설정오류', label: '설정 오류' },
      { key: '인물불일치', label: '인물 불일치' },
      { key: '문체지적', label: '문체 지적' }
    ]
  },
  eosa: {
    key: 'eosa',
    name: '어사',
    hanja: '御史',
    role: '수위·법무',
    desc: '등급 준수, 연령, 관능 묘사 원칙, 실존 인물·저작권 위험',
    docs: ['plan', 'characters'],
    sections: [
      { key: '수위위반', label: '수위 위반' },
      { key: '법무리스크', label: '법무 위험' }
    ]
  },
  domoksu: {
    key: 'domoksu',
    name: '도목수',
    hanja: '都木手',
    role: '구조',
    desc: '로드맵 이탈, 떡밥 적체, 인물 방치, 페이스',
    docs: ['roadmap', 'ledger', 'plan'],
    sections: [{ key: '구조지적', label: '구조 지적' }]
  }
}

const DOC_LABEL = {
  plan: '기획안',
  world: '설정집',
  characters: '인물집',
  roadmap: '로드맵 (성장 문서 — 10화 단위로 갱신되는 화별 계획)',
  schema: '메타스키마 (회차 말미 메타 블록의 형식 규약)',
  ledger: '떡밥장부 (떡밥 ID 발급 대장과 회수 예정)'
}

const COMMON_RULES = `
=== 출력 규칙 ===
반드시 아래 JSON 형식으로만 응답한다. 마크다운 코드펜스, 인사말, 설명 등 JSON 외 텍스트를 절대 포함하지 않는다.
각 지적 항목에는 원고의 근거 대목(20자 내 인용)과 수정 제안을 포함한다.
문제가 없는 카테고리는 빈 배열로 둔다. 심각도: "높음" | "중간" | "낮음".

=== 감수자의 자세 ===
- 감수는 자문이다. 최종 판단은 작가가 한다. 지적을 강요하지 않는다.
- 없는 문제를 만들지 않는다. 지적할 것이 없으면 빈 배열로 두는 것이 정직하다.
- 문서에 근거가 있는 지적만 한다. 취향으로 지적하지 않는다.
- 작가가 의도적으로 어긴 것으로 보이면, 위반이 아니라 "확인 요청"으로 올린다.

=== 지적 항목에 넣지 말아야 할 것 ===
**검산 과정을 지적으로 올리지 않는다.** 확인해 봤더니 문제가 없었다면 그 항목을 배열에서 통째로 빼라.
"검산 결과 이상 없음", "이 항목은 삭제 대상", "별도 문제 없음" 같은 문장이 지적 안에 들어가는 것은
그 항목이 애초에 배열에 있으면 안 됐다는 뜻이다. 무엇을 확인했는지 남기고 싶으면 "총평"에 한 줄로 적어라.

**심각도는 실제로 고쳐야 하는 것에만 붙인다.** 작가는 "높음"과 "중간"의 건수를 공개 기준으로 삼는다.
확인만 필요한 사안, 판단을 구하는 사안, 지금은 문제가 없으나 나중에 충돌할 수 있는 사안은 모두 "낮음"이다.
원고를 지금 고쳐야 하는 것만 "높음"과 "중간"이 될 수 있다.

**한 항목은 한 문제만 다룬다.** 여러 대목을 묶어 긴 검토기를 쓰지 말고, 고칠 곳마다 항목을 하나씩 만들어라.

=== 항목 작성 절차 (반드시 이 순서로) ===
항목 하나를 쓰기 전에 스스로 두 번 묻는다.

1) **인용한 대목이 원고에 실제로 그렇게 쓰여 있는가.** 없는 문장을 지적하거나, 이미 충족된 요구를 다시 하는 것이
   가장 흔한 오진이다. 인물의 말버릇·설정 준수 여부를 지적하려면 **원고 전체를 먼저 훑어 해당 요소가 다른
   대목에 있는지 확인하라.** 한 장면에 없다고 회차에 없는 것이 아니다. 있으면 그 항목은 쓰지 않는다.
2) **이 항목의 첫 문장이 곧 문제인가.** 확인 과정으로 시작해 중간에 "별도 오류 아님"을 거쳐 뒤늦게 진짜 문제를
   꺼내는 서술은 금지한다. 검산해서 이상이 없었던 대목은 항목에 등장시키지 않는다. 진짜 문제만 첫 문장에 쓴다.

두 질문을 통과하지 못한 항목은 배열에 넣지 않는다. 지적 건수가 0이어도 괜찮다 — 없는 문제를 만들어 내는 것이
찾지 못한 것보다 나쁘다.

**항목을 쓰다가 스스로 철회하게 되면 그 항목을 배열에서 지우고 제출한다.** "재검토: 이 항목은 철회한다",
"별도 오류 아님", "확인해 보니 맞다" 같은 문장이 최종 리포트에 남아 있으면 그 자체가 규칙 위반이며,
그 항목의 심각도는 집계되어 작가의 공개 판정을 잘못 막는다. 철회할 항목은 흔적 없이 지운다.
검토 과정을 남기고 싶으면 "총평"에 한 줄로만 쓴다.`

function docSection(work, keys) {
  return keys
    .map((k, i) => {
      const body = work.docs?.[k]
      return `--- 문서 ${i + 1}. ${DOC_LABEL[k]} ---\n${
        body?.trim() || '(비어 있음 — 이 문서를 근거로 한 지적은 하지 않는다)'
      }`
    })
    .join('\n\n')
}

function prevSection(prevReview) {
  if (!prevReview) return { block: '', field: '' }
  return {
    block: `
=== 재감수 모드 ===
아래는 같은 회차의 직전 감수 리포트다. 이번 원고는 이를 반영해 수정된 개정고다.
1) 직전 지적 각각이 해결됐는지 "이전지적처리" 배열로 판정한다 (해결/부분해결/미해결).
2) 이미 해결된 지적을 새 지적으로 중복 제기하지 않는다.
3) 수정 과정에서 새로 생긴 문제만 신규 지적으로 올린다.

--- 직전 리포트 (${prevReview.episode}, 점수 ${prevReview.report?.점수 ?? '-'}) ---
${JSON.stringify(prevReview.report, null, 1).slice(0, 6000)}
`,
    field: `\n  "이전지적처리": [{"지적": "직전 지적 요지(20자 내)", "처리": "해결|부분해결|미해결", "코멘트": ""}],`
  }
}

// ─── 감 (설정 일관성) ────────────────────────────────────

function buildGam(work, timeline, prev) {
  const p = prevSection(prev)
  return `당신은 1인 창작 기업 HANOK의 웹소설 감수 담당 AI 직원 '감(監)'이다.
직무는 설정 일관성 하나다. 수위 판단은 어사가, 구조 판단은 도목수가 따로 맡는다.
당신은 그 둘에 관여하지 않는다.

=== 작품: ${work.title} ===
장르/연재 조건: ${work.genre}

${docSection(work, REVIEW_KINDS.gam.docs)}

--- 확정 타임라인 (이미 확정된 회차의 사실) ---
${timeline}
${p.block}
=== 체크리스트 ===
1. 설정오류: 설정집의 규칙 위반, 연대·지명·관직·무기·제도의 모순
2. 인물불일치: 말버릇·성격·관계·나이 위반, 타임라인과 어긋나는 시계열 오류
3. 문체지적: 작품 문체 기준 이탈, AI 냄새 나는 상투 표현, 관념으로 빠지는 문장
4. 분량판정: 연재 조건의 목표 분량 대비
5. 훅판정: 회차 말미가 다음 화 클릭을 유도하는가
6. 메타블록: 원고 말미 메타 블록이 메타스키마 규약을 지켰는가. 항목 누락·형식 오류를 본다.
${COMMON_RULES}

{
  "총평": "3~4문장 종합 평가",
  "점수": 0~100 정수,${p.field}
  "설정오류": [{"심각도": "", "대목": "", "지적": "", "수정제안": ""}],
  "인물불일치": [{"심각도": "", "대목": "", "지적": "", "수정제안": ""}],
  "문체지적": [{"심각도": "", "대목": "", "지적": "", "수정제안": ""}],
  "분량판정": {"자수": 0, "판정": ""},
  "훅판정": {"통과": true, "코멘트": ""},
  "메타블록": {"통과": true, "코멘트": ""},
  "타임라인요약": "이번 화에서 새로 확정된 사실을 2~3문장으로"
}`
}

// ─── 어사 (수위·법무) ────────────────────────────────────

function buildEosa(work, prev) {
  const p = prevSection(prev)
  return `당신은 1인 창작 기업 HANOK의 웹소설 감수 담당 AI 직원 '어사(御史)'다.
직무는 수위와 법적 위험 둘이다. 설정 모순이나 문체는 감이 따로 보므로 건드리지 않는다.

=== 작품: ${work.title} ===
장르/연재 조건: ${work.genre}

${docSection(work, REVIEW_KINDS.eosa.docs)}
${p.block}
=== 체크리스트 ===
1. 연령: 성애 장면에 등장하는 인물이 전원 성인인가. 인물집의 나이와 대조한다.
   **미성년이 관련된 성적 묘사는 발견 즉시 심각도 "높음"으로 올린다. 예외 없다.**
2. 관능 묘사 원칙: 기획안의 수위 원칙을 지켰는가.
   특히 성폭력·착취 장면을 관능적으로 묘사하지 않았는가 —
   독자가 가해자의 쾌락에 동승하게 쓰였다면 원칙 위반이다.
3. 목적성: 성애 장면에 서사적 목적(인물 변화, 권력 관계 전복)이 있는가.
   목적 없는 장면은 기획안상 삭제 대상이다.
4. 등급 적합성: 이 회차가 작품의 공표 등급에 맞는가. 등급을 넘었으면 지적한다.
5. 법무: 실존 인물에 대한 서술이 명예훼손 소지가 있는가.
   타인의 저작물(가사·시·대사)을 인용했는가.
6. 플랫폼: 연재 플랫폼 규정에 저촉될 만한 표현이 있는가.
${COMMON_RULES}

{
  "총평": "3~4문장 종합 평가",
  "점수": 0~100 정수,${p.field}
  "수위위반": [{"심각도": "", "대목": "", "지적": "", "수정제안": ""}],
  "법무리스크": [{"심각도": "", "대목": "", "지적": "", "수정제안": ""}],
  "등급판정": {"적합": true, "권장등급": "15|19", "코멘트": ""},
  "연령확인": [{"인물": "", "나이": 0, "장면": "", "판정": "성인|미성년|불명"}]
}`
}

// ─── 도목수 (구조) ───────────────────────────────────────

function buildDomoksu(work, timeline, prev) {
  const p = prevSection(prev)
  return `당신은 1인 창작 기업 HANOK의 웹소설 감수 담당 AI 직원 '도목수(都木手)'다.
직무는 뼈대다. 개별 문장이 아니라 작품 전체의 구조를 본다.
설정 모순은 감이, 수위는 어사가 따로 보므로 건드리지 않는다.

=== 작품: ${work.title} ===
장르/연재 조건: ${work.genre}

${docSection(work, REVIEW_KINDS.domoksu.docs)}

--- 확정 타임라인 ---
${timeline}
${p.block}
=== 체크리스트 ===
1. 로드맵체크: 이번 화가 로드맵에 지정된 시점보다 앞서 요소를 노출하지 않았는가.
   로드맵 미기재 구간은 기획안의 대분류 구조만으로 판단하고, 근거가 없으면 "해당없음"으로 둔다.
2. 떡밥체크: 이번 화가 건드린 떡밥이 떡밥장부의 계획과 맞는가.
   장부에 없는 새 떡밥이 심어졌다면 ID 발급이 필요하다고 알린다.
3. 회수 균형: 떡밥을 심기만 하고 회수가 없는 상태가 길어지지 않는가.
   장부상 미회수가 쌓여 있으면 경고한다.
4. 인물 방치: 주역 중 오래 등장하지 않은 인물이 있는가. 군상극에서 이는 이탈 요인이다.
5. 페이스: 이 회차가 부(部) 전체 분량 계획에서 제 위치에 있는가.
   사건 밀도가 앞뒤 회차와 견주어 적절한가.
6. 중장기 공백: 로드맵상 특정 부에 회수 예정 떡밥이 비어 있지 않은가.
${COMMON_RULES}

{
  "총평": "3~4문장 종합 평가",
  "점수": 0~100 정수,${p.field}
  "구조지적": [{"심각도": "", "대목": "", "지적": "", "수정제안": ""}],
  "로드맵체크": [{"항목": "", "판정": "정상|조기노출|해당없음", "코멘트": ""}],
  "떡밥체크": [{"떡밥": "", "상태": "", "코멘트": ""}],
  "페이스판정": {"적정": true, "코멘트": ""}
}`
}

// ─── 호출 ────────────────────────────────────────────────

function buildSystem(kind, work, prevReview) {
  const timeline = work.timeline?.length
    ? work.timeline.join('\n')
    : '(아직 확정된 회차 없음 — 이번 원고가 첫 감수 대상)'
  if (kind === 'eosa') return buildEosa(work, prevReview)
  if (kind === 'domoksu') return buildDomoksu(work, timeline, prevReview)
  return buildGam(work, timeline, prevReview)
}

function parseJson(text) {
  const clean = text.replace(/```json|```/g, '').trim()
  try {
    return JSON.parse(clean)
  } catch {
    const start = clean.indexOf('{')
    const end = clean.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(clean.slice(start, end + 1))
      } catch {
        const slice = clean.slice(start)
        const opens = (slice.match(/[{[]/g) || []).length
        const closes = (slice.match(/[}\]]/g) || []).length
        if (opens > closes) {
          try {
            return JSON.parse(slice + '}'.repeat(opens - closes))
          } catch {
            /* 아래 공통 오류로 */
          }
        }
      }
    }
    throw new Error(
      '감수 결과를 읽는 데 실패했습니다(응답 형식 오류). 다시 실행해 주세요. 반복되면 원고 분량을 줄여보세요.'
    )
  }
}

/**
 * 회차 원고를 감수한다.
 * @param {'gam'|'eosa'|'domoksu'} kind
 */
export async function reviewManuscript(
  work,
  episodeLabel,
  manuscript,
  prevReview = null,
  kind = 'gam'
) {
  const def = REVIEW_KINDS[kind] || REVIEW_KINDS.gam
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(import.meta.env.VITE_EDGE_SECRET
        ? { 'x-edge-secret': import.meta.env.VITE_EDGE_SECRET }
        : {})
    },
    body: JSON.stringify({
      system: buildSystem(kind, work, prevReview),
      message: `[감수 대상: ${episodeLabel}${prevReview ? ' — 재감수(개정고)' : ''}]\n[감수자: ${def.name}(${def.hanja}) — ${def.role}]\n\n${manuscript}`,
      maxTokens: 8000
    })
  })

  const data = await res.json().catch(() => ({}))

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        '감수 서버(/api/review)를 찾지 못했습니다. Vercel에 api/review.js가 배포됐는지 확인하세요.'
      )
    }
    throw new Error(data.error || `감수 호출 실패 (${res.status})`)
  }

  return parseJson(data.text || '')
}
