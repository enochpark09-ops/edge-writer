// Supabase 계층 — 클라우드 저장, 확정 원고 보관, 떡밥·설정 동기화
//
// 설계 원칙
//   1. 클라우드가 없어도 앱은 돌아간다. 환경변수가 없으면 전부 localStorage로 떨어진다.
//   2. anon 키는 브라우저에 노출되어도 되는 키다 (RLS가 실제 방어선).
//      단 RLS 정책이 authenticated를 요구하므로 로그인이 필요하다.
//   3. 확정(confirmed) 원고는 절대 조용히 사라지지 않는다.
//      DB 트리거가 수정 전 원고를 episode_versions에 자동으로 떠 넣는다.

import { createClient } from '@supabase/supabase-js'

const URL = import.meta.env.VITE_SUPABASE_URL
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY

export const cloudEnabled = Boolean(URL && ANON)

/**
 * 토큰이 거절되는 오류(시계 어긋남, 만료)를 한 번만 자동 복구한다.
 * 'JWT issued at future'는 PC 시계가 서버보다 앞설 때 나온다. 세션을
 * 새로 받으면 풀리므로, 사용자가 로그아웃/재로그인을 손으로 할 이유가 없다.
 */
const AUTH_ERR = /JWT|jwt|issued at future|token is expired|invalid claim|PGRST301|401/

export async function withAuthRetry(fn) {
  try {
    return await fn()
  } catch (e) {
    if (!cloudEnabled || !AUTH_ERR.test(String(e?.message || ''))) throw e
    const { error } = await supabase.auth.refreshSession()
    if (error) {
      const err = new Error('클라우드 인증이 만료됐습니다. PC 시계를 동기화한 뒤 다시 로그인해 주세요.')
      err.authExpired = true
      throw err
    }
    return await fn()
  }
}

export const supabase = cloudEnabled
  ? createClient(URL, ANON, {
      auth: { persistSession: true, autoRefreshToken: true }
    })
  : null

const DOC_SLUGS = ['plan', 'world', 'characters', 'roadmap', 'schema', 'ledger']

// ─── 인증 ────────────────────────────────────────────────

export async function getSession() {
  if (!cloudEnabled) return null
  const { data } = await supabase.auth.getSession()
  return data.session
}

export function onAuthChange(cb) {
  if (!cloudEnabled) return () => {}
  const { data } = supabase.auth.onAuthStateChange((_e, session) => cb(session))
  return () => data.subscription.unsubscribe()
}

export async function signIn(email) {
  if (!cloudEnabled) throw new Error('클라우드가 설정되지 않았습니다.')
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin }
  })
  if (error) throw new Error(error.message)
}

export async function signOut() {
  if (!cloudEnabled) return
  await supabase.auth.signOut()
}

// ─── 작품 · 문서 ─────────────────────────────────────────

/** 클라우드의 작품 전체를 앱 형태({id,title,genre,docs,timeline})로 읽어온다. */
export async function fetchWorks() {
  if (!cloudEnabled) return null

  const [{ data: works, error: we }, { data: docs, error: de }] = await Promise.all([
    supabase.from('works').select('*').order('created_at'),
    supabase.from('documents').select('work_id, slug, content')
  ])
  if (we) throw new Error(`작품 읽기 실패: ${we.message}`)
  if (de) throw new Error(`문서 읽기 실패: ${de.message}`)

  const byWork = {}
  for (const d of docs || []) {
    byWork[d.work_id] ??= {}
    byWork[d.work_id][d.slug] = d.content || ''
  }

  const { data: eps } = await supabase
    .from('episodes')
    .select('work_id, label, meta, status')
    .in('status', ['confirmed', 'published'])
    .order('part')
    .order('no')

  const tl = {}
  for (const e of eps || []) {
    tl[e.work_id] ??= []
    if (e.meta?.타임라인요약) tl[e.work_id].push(`${e.label}: ${e.meta.타임라인요약}`)
  }

  return (works || []).map((w) => ({
    id: w.id,
    title: w.title,
    genre: w.genre || '',
    docs: Object.fromEntries(DOC_SLUGS.map((s) => [s, byWork[w.id]?.[s] ?? ''])),
    timeline: tl[w.id] || [],
    cloud: true
  }))
}

/** 작품 하나와 문서 6종을 클라우드에 밀어 넣는다. */
export async function pushWork(work) {
  if (!cloudEnabled) return
  const { error: we } = await supabase
    .from('works')
    .upsert({ id: work.id, title: work.title, genre: work.genre || '' })
  if (we) throw new Error(`작품 저장 실패: ${we.message}`)

  const titles = {
    plan: '기획안', world: '설정집', characters: '인물집',
    roadmap: '로드맵', schema: '메타스키마', ledger: '떡밥장부'
  }

  // 트리거가 문서 6칸을 자동 생성하므로 content만 갱신한다.
  for (const slug of DOC_SLUGS) {
    const content = work.docs?.[slug] ?? ''
    const { error } = await supabase
      .from('documents')
      .upsert(
        { work_id: work.id, slug, title: titles[slug], content },
        { onConflict: 'work_id,slug' }
      )
    if (error) throw new Error(`문서(${titles[slug]}) 저장 실패: ${error.message}`)
  }
}

export async function deleteWorkCloud(id) {
  if (!cloudEnabled) return
  const { error } = await supabase.from('works').delete().eq('id', id)
  if (error) throw new Error(`작품 삭제 실패: ${error.message}`)
}

// ─── 회차 ────────────────────────────────────────────────

export async function fetchEpisodes(workId) {
  if (!cloudEnabled) return []
  const { data, error } = await supabase
    .from('episodes')
    .select('id, part, no, label, title, status, char_count, char_count_ns, confirmed_at, updated_at')
    .eq('work_id', workId)
    .order('part')
    .order('no')
  if (error) throw new Error(`회차 목록 실패: ${error.message}`)
  return data || []
}

/** 개정 이력의 특정 버전 본문을 읽는다. */
export async function fetchVersionBody(episodeId, version) {
  if (!cloudEnabled) return null
  const { data, error } = await supabase
    .from('episode_versions')
    .select('version, body, meta_raw, char_count, was_confirmed, created_at')
    .eq('episode_id', episodeId)
    .eq('version', version)
    .single()
  if (error) throw new Error(`개정본 읽기 실패: ${error.message}`)
  return data
}

export async function fetchEpisodeBody(id) {
  if (!cloudEnabled) return null
  const { data, error } = await supabase
    .from('episodes')
    .select('*')
    .eq('id', id)
    .single()
  if (error) throw new Error(`회차 읽기 실패: ${error.message}`)
  return data
}

/**
 * 회차를 저장한다. (part, no)가 같으면 덮어쓰되,
 * DB 트리거가 이전 본문을 episode_versions에 자동 보관한다.
 */
export async function saveEpisode({
  workId, part, no, label, title, body, metaRaw, meta, charCountNs, status = 'draft'
}) {
  if (!cloudEnabled) throw new Error('클라우드가 설정되지 않았습니다.')
  const row = {
    work_id: workId,
    part: part ?? 1,
    no,
    label,
    title: title || '',
    body,
    meta_raw: metaRaw || null,
    meta: meta || {},
    char_count_ns: charCountNs ?? null,
    status
  }
  if (status === 'confirmed') row.confirmed_at = new Date().toISOString()

  const { data, error } = await supabase
    .from('episodes')
    .upsert(row, { onConflict: 'work_id,part,no' })
    .select()
    .single()
  if (error) throw new Error(`회차 저장 실패: ${error.message}`)
  return data
}

export async function confirmEpisode(id) {
  if (!cloudEnabled) throw new Error('클라우드가 설정되지 않았습니다.')
  const { data, error } = await supabase
    .from('episodes')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) throw new Error(`확정 실패: ${error.message}`)
  return data
}

export async function fetchVersions(episodeId) {
  if (!cloudEnabled) return []
  const { data, error } = await supabase
    .from('episode_versions')
    .select('version, char_count, was_confirmed, note, created_at')
    .eq('episode_id', episodeId)
    .order('version', { ascending: false })
  if (error) throw new Error(`개정 이력 실패: ${error.message}`)
  return data || []
}

// ─── 감수 ────────────────────────────────────────────────

export async function saveReview({ workId, episodeId, kind, round, report }) {
  if (!cloudEnabled || !episodeId) return null
  const score = typeof report?.점수 === 'number' ? report.점수 : null
  const blocking = countBlocking(report)
  const { data, error } = await supabase
    .from('reviews')
    .upsert(
      {
        work_id: workId,
        episode_id: episodeId,
        kind,
        round,
        score,
        verdict: blocking === 0 ? 'pass' : 'revise',
        report
      },
      { onConflict: 'episode_id,kind,round' }
    )
    .select()
    .single()
  if (error) throw new Error(`감수 저장 실패: ${error.message}`)
  return data
}

/** 기획안 6항 공개 기준 — 고·중 심각도 건수 */
export function countBlocking(report) {
  if (!report) return 0
  const buckets = ['설정오류', '인물불일치', '문체지적', '수위위반', '법무리스크', '구조지적']
  let n = 0
  for (const b of buckets) {
    for (const it of report[b] || []) {
      if (it.심각도 === '높음' || it.심각도 === '중간') n++
    }
  }
  return n
}

// ─── 떡밥 · 설정 자동 반영 ───────────────────────────────

/** 메타 블록에서 뽑은 떡밥을 장부에 반영한다. 상태 변화는 이벤트로 남는다. */
export async function syncPlants(workId, plants, episodeId, episodeLabel) {
  if (!cloudEnabled || !plants?.length) return { updated: 0, created: 0 }

  const codes = plants.map((p) => p.code)
  const { data: existing } = await supabase
    .from('plants')
    .select('code')
    .eq('work_id', workId)
    .in('code', codes)
  const known = new Set((existing || []).map((r) => r.code))

  const { part, no } = splitLabel(episodeLabel)

  const rows = plants.map((p) => ({
    work_id: workId,
    code: p.code,
    name: p.name,
    status: p.status,
    due_part: p.duePart,
    due_no: p.dueNo,
    ...(known.has(p.code) ? {} : { planted_part: part, planted_no: no }),
    ...(p.status === 'resolved' ? { resolved_part: part, resolved_no: no } : {}),
    updated_at: new Date().toISOString()
  }))

  const { error } = await supabase
    .from('plants')
    .upsert(rows, { onConflict: 'work_id,code' })
  if (error) throw new Error(`떡밥 저장 실패: ${error.message}`)

  await supabase.from('plant_events').insert(
    plants.map((p) => ({
      work_id: workId,
      code: p.code,
      episode_id: episodeId || null,
      action: p.status,
      note: episodeLabel
    }))
  )

  return {
    created: plants.filter((p) => !known.has(p.code)).length,
    updated: plants.filter((p) => known.has(p.code)).length
  }
}

/** 설정 신규 항목을 등재 대기 목록에 넣는다. */
export async function syncSettings(workId, settings, episodeLabel) {
  if (!cloudEnabled || !settings?.length) return 0
  const { part, no } = splitLabel(episodeLabel)
  const { error } = await supabase.from('setting_entries').upsert(
    settings.map((s) => ({
      work_id: workId,
      key: s.key,
      category: s.category,
      content: s.content,
      source_part: part,
      source_no: no,
      registered: s.registered
    })),
    { onConflict: 'work_id,key' }
  )
  if (error) throw new Error(`설정 항목 저장 실패: ${error.message}`)
  return settings.length
}

/** 설정집에 아직 반영되지 않은 항목 */
export async function fetchPendingSettings(workId) {
  if (!cloudEnabled) return []
  const { data } = await supabase
    .from('setting_entries')
    .select('key, category, content, source_part, source_no')
    .eq('work_id', workId)
    .eq('registered', false)
    .order('created_at')
  return data || []
}

/** 미회수 떡밥 + 지연 경보 */
export async function fetchOpenPlants(workId) {
  if (!cloudEnabled) return []
  const { data } = await supabase
    .from('v_open_plants')
    .select('*')
    .eq('work_id', workId)
  return data || []
}

/** 부별 떡밥 회수 부담 — 중반부 공백 확인용 */
export async function fetchPlantLoad(workId) {
  if (!cloudEnabled) return []
  const { data } = await supabase
    .from('v_plant_load')
    .select('part, open_due')
    .eq('work_id', workId)
    .order('part')
  return data || []
}

/** 집필 현황 + 문피아 승급까지 남은 글자수 */
export async function fetchProgress(workId) {
  if (!cloudEnabled) return null
  const { data } = await supabase
    .from('v_progress')
    .select('*')
    .eq('work_id', workId)
    .maybeSingle()
  return data
}

/** 주역인데 오래 안 나온 인물 */
export async function fetchNeglected(workId) {
  if (!cloudEnabled) return []
  const { data } = await supabase
    .from('v_neglected')
    .select('character, gap')
    .eq('work_id', workId)
    .order('gap', { ascending: false })
  return data || []
}

// ─── 도우미 ──────────────────────────────────────────────

function splitLabel(label) {
  const m = String(label || '').match(/(\d+)\s*부\s*[-\s]?\s*0*(\d+)/)
  if (m) return { part: +m[1], no: +m[2] }
  const only = String(label || '').match(/0*(\d+)/)
  return { part: 1, no: only ? +only[1] : null }
}

export { splitLabel, DOC_SLUGS }
