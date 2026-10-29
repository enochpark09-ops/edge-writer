// 문체 계측 — 집필기법 v2.0 H항을 기계로 센다.
//
// AI 감수자에게 "않았다를 세어라"라고 시키면 매번 다르게 센다.
// 셀 수 있는 것은 여기서 세고, 감수자에게는 결과만 넘긴다.

// 1만 자당 상한 (집필기법 v2.0 H)
export const STYLE_LIMITS = {
  않았다: 15,
  아니라: 5
}

// '~었다.'로 닫는 문장이 몇 번 연달아 나와도 되는가
// 모델 작품(『세종의 나라』) 장별 최대 연속의 중앙값이 약 10이다. 15를 넘으면 박자가 하나뿐이다.
export const MAX_EOTDA_RUN = 15

const EOTDA_END = /(었다|았다|였다|했다|됐다|갔다|왔다|졌다|렸다|웠다|섰다|났다|켰다|쳤다)$/

/** 본문(메타 블록 제외)을 받아 문체 수치를 돌려준다. */
export function computeStyle(body) {
  const text = (body || '').replace(/\r/g, '')
  const chars = text.replace(/\s/g, '').length
  if (chars === 0) return null

  const per10k = (n) => Math.round((n * 10000 * 10) / chars) / 10

  const 않았다 = (text.match(/않았다/g) || []).length
  const 아니라 = (text.match(/아니라/g) || []).length
  const 느낌표 = (text.match(/!/g) || []).length

  // 서술 문장만 센다. 대사 줄은 박자를 바꾸므로 연속을 끊는다.
  const isDialogue = (l) => /^\s*[“"「'‘]/.test(l)
  let run = 0
  let maxRun = 0
  let runAt = ''
  const sentences = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (isDialogue(line)) {
      run = 0
      continue
    }
    const parts = line
      .split(/(?<=[.?!])\s+/)
      .map((x) => x.trim().replace(/[.?!…"”’'*]+$/, ''))
      .filter((x) => x.length > 1)
    for (const sent of parts) {
      sentences.push(sent)
      if (EOTDA_END.test(sent)) {
        run++
        if (run > maxRun) {
          maxRun = run
          runAt = sent.slice(-20)
        }
      } else run = 0
    }
  }

  const avgSentence = sentences.length
    ? Math.round(sentences.reduce((a, s) => a + s.replace(/\s/g, '').length, 0) / sentences.length)
    : 0

  const out = {
    chars,
    counts: { 않았다, 아니라, 느낌표 },
    per10k: { 않았다: per10k(않았다), 아니라: per10k(아니라), 느낌표: per10k(느낌표) },
    eotdaMaxRun: maxRun,
    eotdaRunAt: runAt,
    avgSentence,
    warnings: []
  }

  for (const [k, limit] of Object.entries(STYLE_LIMITS)) {
    if (out.per10k[k] > limit) {
      out.warnings.push(`H 위반 — '${k}' 1만 자당 ${out.per10k[k]} (상한 ${limit})`)
    }
  }
  if (maxRun > MAX_EOTDA_RUN) {
    out.warnings.push(`H 위반 — '~었다.' 서술 문장 ${maxRun}연속 (상한 ${MAX_EOTDA_RUN}) · "…${runAt}"`)
  }
  return out
}

/** 감수자 프롬프트에 붙일 한 단락 */
export function styleBrief(s) {
  if (!s) return ''
  return `[기계 계측 — 집필기법 H항. 이 수치를 그대로 믿고 다시 세지 마라]
본문 ${s.chars.toLocaleString()}자(공백 제외) · 평균 서술 문장 ${s.avgSentence}자
'않았다' ${s.counts.않았다}회 (1만 자당 ${s.per10k.않았다}, 상한 ${STYLE_LIMITS.않았다})
'아니라' ${s.counts.아니라}회 (1만 자당 ${s.per10k.아니라}, 상한 ${STYLE_LIMITS.아니라})
'~었다.' 서술 문장 최대 연속 ${s.eotdaMaxRun}회 (상한 ${MAX_EOTDA_RUN})
${s.warnings.length ? '경고: ' + s.warnings.join(' / ') : '경고 없음'}`
}
