// 메타 블록 파서 — 회차 원고 말미의 SCHEMA v1 블록을 구조화한다.
//
// 이 파일이 자동화의 입구다. 회차를 붙여넣으면 여기서
// 떡밥 / 설정신규 / 등장인물 / 수위 / 시기를 뽑아내고,
// 그 결과가 떡밥 장부와 설정집 등재 대기 목록으로 흘러간다.
//
// 형식 정의는 작품 문서 5번(메타스키마)에 있다.

const BLOCK_RE = /###\s*메타\s*·\s*SCHEMA\s*v1\s*\n([\s\S]*)$/
const FIELD = ' | '

/** 원고에서 메타 블록만 잘라낸다. 없으면 null. */
export function extractMetaBlock(manuscript) {
  const m = manuscript.match(BLOCK_RE)
  return m ? m[1].trimEnd() : null
}

/** 원고에서 메타 블록을 뺀 본문만 돌려준다. */
export function stripMetaBlock(manuscript) {
  const i = manuscript.search(BLOCK_RE)
  return i < 0 ? manuscript : manuscript.slice(0, i).trimEnd()
}

/** '주역[a, b] | 조연[c] | 언급[d]' → {주역:[a,b], 조연:[c], 언급:[d]} */
function parseRoles(raw) {
  const out = { 주역: [], 조연: [], 언급: [] }
  for (const part of raw.split('|')) {
    const m = part.trim().match(/^(주역|조연|언급)\s*\[(.*)\]$/)
    if (!m) continue
    out[m[1]] = m[2]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && s !== '없음')
  }
  return out
}

/** '등급[19] | 유형[a, b] | 위반[없음]' → {등급:19, 유형:'a, b', 위반:'없음'} */
function parseRating(raw) {
  const grab = (key) => {
    const m = raw.match(new RegExp(key + '\\s*\\[([^\\]]*)\\]'))
    return m ? m[1].trim() : ''
  }
  const grade = parseInt(grab('등급'), 10)
  return {
    등급: Number.isFinite(grade) ? grade : null,
    유형: grab('유형'),
    위반: grab('위반') || '없음'
  }
}

/** '- 소하 | 인물 | 옥저 공물 여자 22세 [등재완료]' */
function parseSettingLine(line) {
  const cols = line.replace(/^-\s*/, '').split(FIELD)
  if (cols.length < 3) return null
  const content = cols.slice(2).join(FIELD).trim()
  return {
    key: cols[0].trim(),
    category: cols[1].trim(),
    content: content.replace(/\s*\[등재완료\]\s*$/, '').trim(),
    registered: /\[등재완료\]/.test(content)
  }
}

const STATUS_MAP = {
  투입: 'planted',
  강화: 'reinforced',
  유지: 'held',
  회수: 'resolved',
  폐기: 'dropped'
}

/** '- T012 | 아효의 멍 | 투입 | 예정:1부-004' */
function parsePlantLine(line) {
  const cols = line.replace(/^-\s*/, '').split(FIELD)
  if (cols.length < 3) return null
  const code = cols[0].trim()
  if (!/^T\d{3}$/.test(code)) return null

  const tail = (cols[3] || '').trim()
  let duePart = null
  let dueNo = null
  const due = tail.match(/예정:\s*(?:(\d+)부)?(?:-0*(\d+))?/)
  if (due) {
    duePart = due[1] ? parseInt(due[1], 10) : null
    dueNo = due[2] ? parseInt(due[2], 10) : null
  }

  return {
    code,
    name: cols[1].trim(),
    statusKo: cols[2].trim(),
    status: STATUS_MAP[cols[2].trim()] || 'planted',
    duePart,
    dueNo,
    dueRaw: tail
  }
}

/** '1부-003' → {part:1, no:3} */
export function parseEpisodeCode(raw) {
  const m = String(raw || '').match(/(\d+)\s*부\s*[-\s]?\s*0*(\d+)/)
  if (!m) {
    const only = String(raw || '').match(/0*(\d+)/)
    return { part: 1, no: only ? parseInt(only[1], 10) : null }
  }
  return { part: parseInt(m[1], 10), no: parseInt(m[2], 10) }
}

/**
 * 메타 블록 전체를 파싱한다.
 * @returns {{ok:boolean, meta:object, plants:Array, settings:Array, warnings:string[]}}
 */
export function parseMeta(manuscript) {
  const block = extractMetaBlock(manuscript)
  const warnings = []

  if (!block) {
    return {
      ok: false,
      meta: {},
      plants: [],
      settings: [],
      warnings: ['메타 블록을 찾지 못했습니다. 원고 말미에 "### 메타 · SCHEMA v1"이 있어야 합니다.']
    }
  }

  const meta = {}
  const plants = []
  const settings = []
  const memos = []

  let currentKey = null
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim()) continue

    if (line.startsWith('> 메모:')) {
      memos.push(line.replace(/^>\s*메모:\s*/, '').trim())
      continue
    }

    const at = line.match(/^@([^:]+):\s*(.*)$/)
    if (at) {
      currentKey = at[1].trim()
      const value = at[2].trim()
      switch (currentKey) {
        case '등장':
          meta.등장 = parseRoles(value)
          break
        case '수위':
          meta.수위 = parseRating(value)
          break
        case '설정신규':
        case '떡밥':
          break // 다음 줄들의 하이픈 목록에서 채운다
        case '분량': {
          const n = parseInt(value.split(FIELD)[0], 10)
          meta.분량 = Number.isFinite(n) ? n : null
          break
        }
        case '회차': {
          const { part, no } = parseEpisodeCode(value)
          meta.회차 = value
          meta.part = part
          meta.no = no
          break
        }
        case '시점': {
          const [view, close] = value.split(FIELD)
          meta.시점 = (view || '').trim()
          const c = (close || '').match(/밀착:\s*(.*)$/)
          meta.밀착 =
            c && c[1].trim() !== '없음'
              ? c[1].split(',').map((s) => s.trim()).filter(Boolean)
              : []
          break
        }
        case '말버릇':
          meta.말버릇 = value
            .split('|')
            .map((s) => s.trim())
            .filter(Boolean)
          break
        default:
          meta[currentKey] = value
      }
      continue
    }

    if (line.trimStart().startsWith('-')) {
      const item = line.trim()
      if (currentKey === '설정신규') {
        const s = parseSettingLine(item)
        if (s) settings.push(s)
        else warnings.push(`설정신규 줄을 읽지 못했습니다: ${item.slice(0, 40)}`)
      } else if (currentKey === '떡밥') {
        const p = parsePlantLine(item)
        if (p) plants.push(p)
        else warnings.push(`떡밥 줄을 읽지 못했습니다: ${item.slice(0, 40)}`)
      }
    }
  }

  if (memos.length) meta.메모 = memos

  // 검증 — 스키마가 요구하는 필수 항목
  for (const k of ['회차', '시점', '시기', '등장', '수위', '분량']) {
    if (meta[k] == null) warnings.push(`필수 항목 @${k}이(가) 없습니다.`)
  }

  // 분량 자동 검산 — 메타에 적힌 값과 실제 본문 길이가 어긋나면 알린다
  const bodyLen = stripMetaBlock(manuscript).length
  if (meta.분량 && Math.abs(meta.분량 - bodyLen) > 200) {
    warnings.push(
      `@분량(${meta.분량.toLocaleString()})과 실제 본문(${bodyLen.toLocaleString()})이 ${Math.abs(
        meta.분량 - bodyLen
      ).toLocaleString()}자 차이납니다.`
    )
  }

  return { ok: warnings.length === 0, meta, plants, settings, warnings }
}

/**
 * 파싱 결과를 떡밥 장부 문서(마크다운)에 반영할 형태로 요약한다.
 * 실제 장부 갱신은 Supabase에 하고, 이건 사람이 읽을 변경 요약이다.
 */
export function summarizeLedgerChanges(plants, episodeCode) {
  if (!plants.length) return '이번 회차에서 움직인 떡밥이 없습니다.'
  const by = { planted: [], reinforced: [], held: [], resolved: [], dropped: [] }
  for (const p of plants) by[p.status]?.push(`${p.code} ${p.name}`)
  const lines = []
  if (by.planted.length) lines.push(`신규 투입 ${by.planted.length}건 — ${by.planted.join(', ')}`)
  if (by.reinforced.length) lines.push(`강화 ${by.reinforced.length}건 — ${by.reinforced.join(', ')}`)
  if (by.resolved.length) lines.push(`회수 ${by.resolved.length}건 — ${by.resolved.join(', ')}`)
  if (by.held.length) lines.push(`유지 ${by.held.length}건`)
  if (by.dropped.length) lines.push(`폐기 ${by.dropped.length}건 — ${by.dropped.join(', ')}`)
  return `${episodeCode} · ${lines.join(' / ')}`
}
