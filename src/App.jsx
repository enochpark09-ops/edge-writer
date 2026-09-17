import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { DEFAULT_WORK } from './defaultWork'
import { reviewManuscript, REVIEW_KINDS } from './api'
import { parseMeta, stripMetaBlock, summarizeLedgerChanges } from './lib/meta'
import * as cloud from './lib/supabase'

const STORE_KEY = 'edgewriter.works.v2'
const LEGACY_KEY = 'edgewriter.works.v1'

const DOC_FIELDS = [
  ['plan', '기획안', '로그라인, 구조, 핵심 원칙, 수위 원칙, 떡밥 계획…'],
  ['world', '설정집', '세계관 규칙, 지리, 제도, 풍속, 물건…'],
  ['characters', '인물집', '주요 인물 프로필, 나이, 말버릇, 관계, 아크…'],
  ['roadmap', '로드맵', '10화 단위로 갱신하는 화별 중장기 계획. 앞부분은 지우지 않고 누적…'],
  ['schema', '메타스키마', '회차 말미 메타 블록의 형식 규약. 자동화의 인터페이스이므로 형식을 고정한다…'],
  ['ledger', '떡밥장부', '떡밥 ID 발급 대장과 회수 예정. 회차마다 갱신되는 살아 있는 문서…']
]
const DOC_KEYS = DOC_FIELDS.map(([k]) => k)
const EMPTY_DOCS = Object.fromEntries(DOC_KEYS.map((k) => [k, '']))

const EMPTY_DRAFT = { title: '', genre: '', docs: { ...EMPTY_DOCS } }
const SEVERITY_GLYPH = { 높음: '●', 중간: '▲', 낮음: '○' }

function normalizeWork(w) {
  return { ...w, docs: { ...EMPTY_DOCS, ...(w.docs || {}) }, timeline: w.timeline || [] }
}

function loadLocal() {
  for (const key of [STORE_KEY, LEGACY_KEY]) {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length) return parsed.map(normalizeWork)
    } catch (e) {
      console.error('작품 데이터 로드 실패', key, e)
    }
  }
  return [normalizeWork(structuredClone(DEFAULT_WORK))]
}

function saveLocal(works) {
  localStorage.setItem(STORE_KEY, JSON.stringify(works))
}

/**
 * 로컬과 클라우드 작품을 합친다.
 * 같은 id끼리는 문서마다 '내용이 있는 쪽'을 고른다.
 * 빈 클라우드 기록이 로컬 원고를 덮어쓰는 사고를 막는 것이 이 함수의 유일한 목적이다.
 */
function mergeWorks(local, remote) {
  const out = new Map()
  for (const l of local) out.set(l.id, l)

  for (const r of remote) {
    const l = out.get(r.id)
    if (!l) {
      out.set(r.id, r)
      continue
    }
    const docs = {}
    for (const k of DOC_KEYS) {
      const rv = (r.docs?.[k] || '').trim()
      const lv = (l.docs?.[k] || '').trim()
      docs[k] = rv.length >= lv.length ? r.docs[k] || '' : l.docs[k] || ''
    }
    out.set(r.id, {
      ...l,
      ...r,
      docs,
      timeline: r.timeline?.length ? r.timeline : l.timeline || [],
      lastReview: l.lastReview
    })
  }
  return [...out.values()]
}

/** 제목이 같은데 id가 다른 작품 — 로컬 등록분과 클라우드 시드가 겹친 경우 */
function findDuplicateTitles(works) {
  const byTitle = new Map()
  for (const w of works) {
    const t = (w.title || '').trim()
    if (!t) continue
    byTitle.set(t, [...(byTitle.get(t) || []), w])
  }
  return [...byTitle.entries()].filter(([, list]) => list.length > 1)
}

export default function App() {
  // ── 인증 ──
  const [session, setSession] = useState(null)
  const [authChecked, setAuthChecked] = useState(!cloud.cloudEnabled)
  const [email, setEmail] = useState('')
  const [authMsg, setAuthMsg] = useState('')

  // ── 작품 ──
  const [works, setWorks] = useState(loadLocal)
  const [selectedId, setSelectedId] = useState(() => loadLocal()[0]?.id)
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState(EMPTY_DRAFT)

  // ── 원고 ──
  const [episodeLabel, setEpisodeLabel] = useState('')
  const [manuscript, setManuscript] = useState('')
  const [episodes, setEpisodes] = useState([])
  const [savedEpisode, setSavedEpisode] = useState(null)

  // ── 감수 ──
  const [kind, setKind] = useState('gam')
  const [report, setReport] = useState(null)
  const [reportKind, setReportKind] = useState('gam')
  const [reportEpisode, setReportEpisode] = useState('')
  const [prevScore, setPrevScore] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [loadedFrom, setLoadedFrom] = useState(null)   // {label, version|null}
  const [versions, setVersions] = useState([])
  const [versionsFor, setVersionsFor] = useState(null)
  const [cloudDown, setCloudDown] = useState(false)
  const [showTimeline, setShowTimeline] = useState(false)
  const [timelineApplied, setTimelineApplied] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const fileRef = useRef(null)

  const work = useMemo(
    () => works.find((w) => w.id === selectedId) || works[0],
    [works, selectedId]
  )

  const duplicates = useMemo(() => findDuplicateTitles(works), [works])

  const charCount = stripMetaBlock(manuscript).replace(/\s/g, '').length
  const charCountRaw = stripMetaBlock(manuscript).length
  const parsed = useMemo(() => (manuscript.trim() ? parseMeta(manuscript) : null), [manuscript])

  useEffect(() => saveLocal(works), [works])

  // ── 세션 ──
  useEffect(() => {
    if (!cloud.cloudEnabled) return
    cloud.getSession().then((s) => {
      setSession(s)
      setAuthChecked(true)
    })
    return cloud.onAuthChange((s) => setSession(s))
  }, [])

  // ── 로그인 뒤 클라우드에서 작품 당겨오기 ──
  //
  // 병합 원칙: 빈 클라우드 기록이 내용 있는 로컬 문서를 절대 덮어쓰지 않는다.
  // schema.sql이 만든 껍데기 작품이 로컬 원고를 날리는 사고를 막기 위한 것이다.
  const pullCloud = useCallback(async () => {
    if (!cloud.cloudEnabled || !session) return
    setSyncing(true)
    try {
      const remote = await cloud.fetchWorks()
      if (remote?.length) {
        setWorks((local) => mergeWorks(local, remote.map(normalizeWork)))
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setSyncing(false)
    }
  }, [session])

  useEffect(() => {
    if (session) pullCloud()
  }, [session, pullCloud])

  // ── 회차 목록 ──
  useEffect(() => {
    if (!session || !work?.id) return setEpisodes([])
    cloud
      .withAuthRetry(() => cloud.fetchEpisodes(work.id))
      .then((rows) => {
        setEpisodes(rows)
        setCloudDown(false)
      })
      .catch((e) => {
        setCloudDown(true)
        setError(e.message)
      })
  }, [session, work?.id])

  // ── 저장된 회차 불러오기 ──
  async function openEpisode(ep) {
    setError('')
    try {
      const row = await cloud.withAuthRetry(() => cloud.fetchEpisodeBody(ep.id))
      if (!row) return
      setManuscript(row.body || '')
      setEpisodeLabel(row.label || '')
      setSavedEpisode(row)
      setReport(null)
      setTimelineApplied(false)
      setLoadedFrom({ label: row.label, version: null })
      setVersionsFor(null)
      setVersions([])
      setCloudDown(false)
      flash(`${row.label} 불러왔습니다.`)
    } catch (e) {
      if (e.authExpired) setCloudDown(true)
      setError(e.message)
    }
  }

  async function toggleVersions(ep) {
    if (versionsFor === ep.id) {
      setVersionsFor(null)
      setVersions([])
      return
    }
    setError('')
    try {
      const rows = await cloud.withAuthRetry(() => cloud.fetchVersions(ep.id))
      setVersionsFor(ep.id)
      setVersions(rows)
      if (rows.length === 0) flash('아직 개정 이력이 없습니다. 이 회차는 한 번만 저장되었습니다.')
    } catch (e) {
      setError(e.message)
    }
  }

  async function openVersion(ep, version) {
    setError('')
    try {
      const row = await cloud.withAuthRetry(() => cloud.fetchVersionBody(ep.id, version))
      if (!row) return
      setManuscript(row.body || '')
      setEpisodeLabel(ep.label || '')
      setSavedEpisode(null)          // 과거본은 덮어쓰기 대상이 아니다
      setReport(null)
      setTimelineApplied(false)
      setLoadedFrom({ label: ep.label, version })
    } catch (e) {
      setError(e.message)
    }
  }

  function updateWork(id, updater) {
    setWorks((prev) => prev.map((w) => (w.id === id ? updater(w) : w)))
  }

  function flash(msg) {
    setNotice(msg)
    setTimeout(() => setNotice(''), 4000)
  }

  // ── 작품 편집 ──
  function openEditor(target) {
    if (target === 'new') {
      setDraft(structuredClone(EMPTY_DRAFT))
      setEditing('new')
    } else {
      const w = works.find((x) => x.id === target)
      if (!w) return
      setDraft({ title: w.title, genre: w.genre, docs: { ...EMPTY_DOCS, ...w.docs } })
      setEditing(target)
    }
  }

  async function saveDraft() {
    if (!draft.title.trim()) return
    let target
    if (editing === 'new') {
      target = {
        id: 'w-' + Date.now(),
        title: draft.title.trim(),
        genre: draft.genre.trim(),
        docs: { ...draft.docs },
        timeline: []
      }
      setWorks((prev) => [...prev, target])
      setSelectedId(target.id)
    } else {
      target = {
        ...works.find((w) => w.id === editing),
        title: draft.title.trim(),
        genre: draft.genre.trim(),
        docs: { ...draft.docs }
      }
      updateWork(editing, () => target)
    }
    setEditing(null)

    if (session) {
      try {
        await cloud.pushWork(target)
        flash('문서를 클라우드에 저장했습니다.')
      } catch (e) {
        setError(e.message)
      }
    }
  }

  async function deleteWork(id) {
    if (works.length <= 1) {
      alert('마지막 작품은 삭제할 수 없습니다. 새 작품을 먼저 등록하세요.')
      return
    }
    if (!confirm('이 작품과 타임라인을 삭제할까요? 되돌릴 수 없습니다.')) return
    setWorks((prev) => prev.filter((w) => w.id !== id))
    if (selectedId === id) setSelectedId(works.find((w) => w.id !== id)?.id)
    setEditing(null)
    if (session) cloud.deleteWorkCloud(id).catch((e) => setError(e.message))
  }

  // ── 감수 ──
  async function runReview(isRecheck = false) {
    if (!work) return
    if (!manuscript.trim()) return setError('원고를 붙여넣은 뒤 감수를 실행하세요.')
    const prevStore = work.lastReview?.[kind]
    if (isRecheck && !prevStore) {
      return setError(`재감수할 직전 ${REVIEW_KINDS[kind].name} 리포트가 없습니다.`)
    }

    setLoading(true)
    setError('')
    setReport(null)
    setTimelineApplied(false)

    const label = episodeLabel.trim() || (isRecheck ? prevStore.episode : '회차 미표기 원고')
    const prev = isRecheck ? prevStore : null

    try {
      const result = await reviewManuscript(work, label, manuscript, prev, kind)
      setReport(result)
      setReportKind(kind)
      setReportEpisode(label)
      setPrevScore(isRecheck ? (prevStore.report?.점수 ?? null) : null)
      updateWork(work.id, (w) => ({
        ...w,
        lastReview: { ...(w.lastReview || {}), [kind]: { episode: label, report: result, at: Date.now() } }
      }))

      if (session && savedEpisode?.id) {
        const round = isRecheck ? 2 : 1
        cloud
          .saveReview({ workId: work.id, episodeId: savedEpisode.id, kind, round, report: result })
          .catch((e) => setError(e.message))
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  // ── 원고 저장 / 확정 ──
  async function persistEpisode(status) {
    if (!session) return setError('클라우드 로그인이 필요합니다.')
    if (!manuscript.trim()) return setError('원고가 비어 있습니다.')
    const label = episodeLabel.trim()
    if (!label) return setError('회차 표기를 입력하세요. (예: 1부-004)')

    const p = parsed
    const { part, no } = cloud.splitLabel(label)
    if (!no) return setError('회차 번호를 읽지 못했습니다. "1부-004" 형태로 적어주세요.')

    setLoading(true)
    setError('')
    try {
      const saved = await cloud.saveEpisode({
        workId: work.id,
        part: p?.meta?.part ?? part,
        no: p?.meta?.no ?? no,
        label,
        title: p?.meta?.제목 || '',
        body: manuscript,
        metaRaw: p?.ok || p?.meta ? JSON.stringify(p.meta) : null,
        meta: {
          ...(p?.meta || {}),
          ...(report?.타임라인요약 ? { 타임라인요약: report.타임라인요약 } : {})
        },
        charCountNs: charCount,
        status
      })
      setSavedEpisode(saved)

      if (p?.plants?.length) {
        const r = await cloud.syncPlants(work.id, p.plants, saved.id, label)
        flash(
          `${status === 'confirmed' ? '확정 저장' : '임시 저장'} 완료 · 떡밥 ${r.created}건 신규, ${r.updated}건 갱신`
        )
      } else {
        flash(status === 'confirmed' ? '확정 원고를 저장했습니다.' : '임시 저장했습니다.')
      }
      if (p?.settings?.length) await cloud.syncSettings(work.id, p.settings, label)

      // 확정하면 타임라인도 함께 반영한다. 버튼을 두 번 누르게 하지 않는다.
      // 타임라인요약은 감(監)만 만들므로, 감수 없이 확정하면 이 단계는 건너뛴다.
      if (status === 'confirmed' && report?.타임라인요약 && !timelineApplied) {
        const entry = `${label}: ${report.타임라인요약}`
        updateWork(work.id, (w) => ({
          ...w,
          timeline: w.timeline.includes(entry) ? w.timeline : [...w.timeline, entry]
        }))
        setTimelineApplied(true)
      }

      setEpisodes(await cloud.fetchEpisodes(work.id))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function applyTimeline() {
    if (!report?.타임라인요약 || !work) return
    updateWork(work.id, (w) => ({
      ...w,
      timeline: [...w.timeline, `${reportEpisode}: ${report.타임라인요약}`]
    }))
    setTimelineApplied(true)
  }

  function removeTimelineEntry(idx) {
    if (!confirm('이 타임라인 항목을 삭제할까요?')) return
    updateWork(work.id, (w) => ({ ...w, timeline: w.timeline.filter((_, i) => i !== idx) }))
  }

  function exportWorks() {
    const blob = new Blob([JSON.stringify(works, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `edge-writer-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function importWorks(ev) {
    const file = ev.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsedJson = JSON.parse(reader.result)
        if (!Array.isArray(parsedJson) || !parsedJson.length) throw new Error()
        if (!confirm(`백업의 작품 ${parsedJson.length}개로 교체할까요? 현재 데이터는 사라집니다.`)) return
        const list = parsedJson.map(normalizeWork)
        setWorks(list)
        setSelectedId(list[0].id)
      } catch {
        alert('백업 파일 형식이 올바르지 않습니다.')
      }
    }
    reader.readAsText(file)
    ev.target.value = ''
  }

  async function handleSignIn(e) {
    e.preventDefault()
    setAuthMsg('')
    try {
      await cloud.signIn(email.trim())
      setAuthMsg('메일로 로그인 링크를 보냈습니다. 같은 기기에서 링크를 열어주세요.')
    } catch (err) {
      setAuthMsg(err.message)
    }
  }

  // ── 로그인 화면 ──
  if (cloud.cloudEnabled && authChecked && !session) {
    return (
      <div className="app">
        <header className="masthead">
          <div className="masthead-inner">
            <div className="brand">
              <span className="brand-word">edge</span>
              <span className="brand-bar">|</span>
              <span className="brand-word thin">writer</span>
            </div>
            <p className="brand-sub">설정 감수실 · HANOK 콘텐츠 파이프라인</p>
          </div>
          <div className="grid-strip" aria-hidden="true" />
        </header>
        <main className="auth-wrap">
          <form className="auth-card" onSubmit={handleSignIn}>
            <h2>로그인</h2>
            <p className="muted">
              확정 원고와 문서를 클라우드에 보관합니다. 메일로 링크를 보내드립니다.
            </p>
            <label className="field">
              <span>메일 주소</span>
              <input
                id="auth-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </label>
            <button className="btn primary" type="submit">
              로그인 링크 받기
            </button>
            {authMsg && <p className="auth-msg">{authMsg}</p>}
          </form>
        </main>
      </div>
    )
  }

  const kindDef = REVIEW_KINDS[reportKind] || REVIEW_KINDS.gam
  const issueSections = report
    ? kindDef.sections.map((s) => ({ ...s, items: report[s.key] || [] }))
    : []
  const blocking = report ? cloud.countBlocking(report) : 0

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead-inner">
          <div className="brand">
            <span className="brand-word">edge</span>
            <span className="brand-bar">|</span>
            <span className="brand-word thin">writer</span>
          </div>
          <p className="brand-sub">설정 감수실 · HANOK 콘텐츠 파이프라인</p>
          <div className="cloud-state">
            {!cloud.cloudEnabled ? (
              <span className="cloud-chip off">로컬 전용</span>
            ) : session ? (
              <>
                <span className={'cloud-chip ' + (cloudDown ? 'warn' : 'on')}>
                  {cloudDown ? '클라우드 끊김 · 로컬만 표시 중' : syncing ? '동기화 중…' : '클라우드 연결됨'}
                </span>
                <button className="btn ghost sm" onClick={() => cloud.signOut()}>
                  로그아웃
                </button>
              </>
            ) : (
              <span className="cloud-chip off">연결 안 됨</span>
            )}
          </div>
        </div>
        <div className="grid-strip" aria-hidden="true" />
      </header>

      <main className="layout">
        {/* ── 작품 서재 ── */}
        <aside className="library">
          <div className="panel-title">
            <h2>작품 서재</h2>
            <button className="btn ghost sm" onClick={() => openEditor('new')}>
              + 작품 등록
            </button>
          </div>

          {duplicates.length > 0 && (
            <div className="dup-warn">
              <strong>제목이 겹치는 작품이 있습니다.</strong>
              {duplicates.map(([title, list]) => (
                <p key={title}>
                  『{title}』 {list.length}개 — 내용이 있는 쪽을 남기고 빈 쪽을 지우세요.
                  작품을 눌러 문서 편집으로 확인할 수 있습니다.
                </p>
              ))}
              <p className="dup-note">
                앱에서 등록한 작품과 클라우드에 미리 심어둔 작품이 서로 다른 식별자를 갖기 때문에 생깁니다.
              </p>
            </div>
          )}

          <ul className="work-list">
            {works.map((w) => (
              <li key={w.id}>
                <button
                  className={'work-item' + (w.id === work?.id ? ' active' : '')}
                  onClick={() => {
                    setSelectedId(w.id)
                    setReport(null)
                    setError('')
                    setSavedEpisode(null)
                  }}
                >
                  <span className="work-title">{w.title}</span>
                  <span className="work-meta">
                    문서 {DOC_KEYS.reduce((n, k) => n + ((w.docs?.[k] || '').trim() ? 1 : 0), 0)}/6 ·
                    타임라인 {w.timeline.length}건
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {work && (
            <div className="work-detail">
              <p className="work-genre">{work.genre || '장르 미기재'}</p>
              <div className="doc-badges">
                {DOC_FIELDS.map(([key, name]) => (
                  <span
                    key={key}
                    className={'doc-badge' + ((work.docs[key] || '').trim() ? ' ok' : ' empty')}
                    title={
                      (work.docs[key] || '').trim()
                        ? `${work.docs[key].length.toLocaleString()}자`
                        : '비어 있음'
                    }
                  >
                    {name}
                  </span>
                ))}
              </div>
              <div className="work-actions">
                <button className="btn ghost sm" onClick={() => openEditor(work.id)}>
                  문서 편집
                </button>
                <button className="btn ghost sm" onClick={() => setShowTimeline((v) => !v)}>
                  타임라인 {showTimeline ? '닫기' : '보기'}
                </button>
              </div>
            </div>
          )}

          {session && episodes.length > 0 && (
            <div className="ep-list">
              <h3>저장된 회차 <span className="count">{episodes.length}</span></h3>
              <ul>
                {episodes.map((e) => (
                  <li key={e.id} className={'ep-row s-' + e.status}>
                    <button
                      className="ep-open"
                      onClick={() => openEpisode(e)}
                      title="편집창으로 불러오기"
                    >
                      <span className="ep-label">{e.label}</span>
                      <span className="ep-status">{
                        { draft: '초고', review: '감수중', confirmed: '확정', published: '발행' }[e.status]
                      }</span>
                      <span className="ep-chars">{(e.char_count || 0).toLocaleString()}자</span>
                    </button>
                    <button
                      className="ep-hist"
                      onClick={() => toggleVersions(e)}
                      title="개정 이력"
                    >
                      {versionsFor === e.id ? '이력 ▲' : '이력 ▼'}
                    </button>
                    {versionsFor === e.id && versions.length > 0 && (
                      <ul className="ver-list">
                        {versions.map((v) => (
                          <li key={v.version}>
                            <button onClick={() => openVersion(e, v.version)}>
                              v{v.version}
                              {v.was_confirmed && <em>확정본</em>}
                              <span>{(v.char_count || 0).toLocaleString()}자</span>
                              <time>{new Date(v.created_at).toLocaleDateString('ko-KR')}</time>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {showTimeline && work && (
            <div className="timeline">
              <h3>확정 타임라인</h3>
              {work.timeline.length === 0 && (
                <p className="muted">아직 확정된 회차가 없습니다. 감수 후 "타임라인 반영"으로 쌓입니다.</p>
              )}
              <ol>
                {work.timeline.map((t, i) => (
                  <li key={i}>
                    <span>{t}</span>
                    <button className="entry-del" onClick={() => removeTimelineEntry(i)} aria-label="항목 삭제">
                      ×
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="backup-row">
            <button className="btn ghost sm" onClick={exportWorks}>백업 내보내기</button>
            <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>백업 불러오기</button>
            <input ref={fileRef} type="file" accept="application/json" hidden onChange={importWorks} />
          </div>
        </aside>

        {/* ── 감수 데스크 ── */}
        <section className="desk">
          <div className="desk-head">
            <h2>원고 감수 <span className="desk-work">— {work?.title}</span></h2>
          </div>

          <div className="kind-row">
            {Object.values(REVIEW_KINDS).map((k) => (
              <button
                key={k.key}
                className={'kind-chip' + (kind === k.key ? ' active' : '')}
                onClick={() => setKind(k.key)}
                title={k.desc}
              >
                <span className="kind-name">{k.name}</span>
                <span className="kind-role">{k.role}</span>
              </button>
            ))}
          </div>

          {loadedFrom && (
            <div className={'loaded-bar' + (loadedFrom.version ? ' past' : '')}>
              <span>
                {loadedFrom.version
                  ? `${loadedFrom.label} · v${loadedFrom.version} (과거본 — 저장하면 새 버전이 됩니다)`
                  : `${loadedFrom.label} 불러옴 — 클라우드 최신본`}
              </span>
              <button
                className="btn ghost sm"
                onClick={() => {
                  setLoadedFrom(null)
                  setManuscript('')
                  setEpisodeLabel('')
                  setSavedEpisode(null)
                  setReport(null)
                }}
              >
                새 원고
              </button>
            </div>
          )}

          <div className="input-row">
            <input
              id="episode-label"
              className="episode-input"
              placeholder="회차 표기 (예: 1부-004)"
              value={episodeLabel}
              onChange={(e) => setEpisodeLabel(e.target.value)}
            />
            <span className="char-counter">
              {charCount.toLocaleString()}자
              <em> (공백 포함 {charCountRaw.toLocaleString()})</em>
            </span>
          </div>

          <textarea
            id="manuscript"
            className="manuscript"
            placeholder="회차 원고 전문을 붙여넣으세요. 말미의 메타 블록까지 함께 붙이면 떡밥과 설정이 자동으로 정리됩니다."
            value={manuscript}
            onChange={(e) => setManuscript(e.target.value)}
          />

          {parsed && (
            <div className={'meta-panel' + (parsed.ok ? ' ok' : ' warn')}>
              {parsed.meta.회차 ? (
                <>
                  <div className="meta-head">
                    <span className="meta-code">{parsed.meta.회차}</span>
                    <span className="meta-sum">
                      떡밥 {parsed.plants.length} · 설정 {parsed.settings.length} · 주역{' '}
                      {parsed.meta.등장?.주역?.length ?? 0}
                    </span>
                  </div>
                  {parsed.plants.length > 0 && (
                    <p className="meta-line">{summarizeLedgerChanges(parsed.plants, parsed.meta.회차)}</p>
                  )}
                  {parsed.settings.filter((s) => !s.registered).length > 0 && (
                    <p className="meta-line warn-line">
                      설정집 미등재 {parsed.settings.filter((s) => !s.registered).length}건 —{' '}
                      {parsed.settings.filter((s) => !s.registered).map((s) => s.key).join(', ')}
                    </p>
                  )}
                </>
              ) : (
                <p className="meta-line">메타 블록이 없습니다. 떡밥·설정 자동 정리는 건너뜁니다.</p>
              )}
              {parsed.warnings.map((w, i) => (
                <p className="meta-line warn-line" key={i}>{w}</p>
              ))}
            </div>
          )}

          <div className="run-row">
            <button className="btn primary" onClick={() => runReview(false)} disabled={loading}>
              {loading ? '처리 중…' : `${REVIEW_KINDS[kind].name} 감수 실행`}
            </button>
            <button
              className="btn recheck"
              onClick={() => runReview(true)}
              disabled={loading || !work?.lastReview?.[kind]}
              title={
                work?.lastReview?.[kind]
                  ? `직전 ${REVIEW_KINDS[kind].name} 리포트와 대조하여 개정고를 감수합니다`
                  : '먼저 감수를 1회 실행하면 활성화됩니다'
              }
            >
              재감수
            </button>
            {session && (
              <>
                <button className="btn ghost" onClick={() => persistEpisode('review')} disabled={loading}>
                  임시 저장
                </button>
                <button
                  className="btn confirm"
                  onClick={() => {
                    if (!report?.타임라인요약 && !confirm('감(監) 감수를 아직 돌리지 않았습니다.\n지금 확정하면 이 회차에 타임라인 요약이 비어 있게 되고, 다음 회차 감수가 이 회차를 참고하지 못합니다.\n\n그래도 확정할까요?')) return
                    if (blocking > 0 && !confirm(`고·중 심각도 지적이 ${blocking}건 남아 있습니다. 그래도 확정할까요?\n(감수는 자문이며 결정은 대표가 합니다)`)) return
                    persistEpisode('confirmed')
                  }}
                  disabled={loading}
                >
                  원고 확정
                </button>
              </>
            )}
          </div>

          {notice && <p className="notice">{notice}</p>}
          {error && <p className="error">{error}</p>}

          {loading && (
            <div className="loading-note">
              {REVIEW_KINDS[kind].name}이(가) {REVIEW_KINDS[kind].docs.length}종 문서와 타임라인{' '}
              {work?.timeline.length ?? 0}건을 대조하고 있습니다…
            </div>
          )}

          {report && (
            <div className="report">
              <div className="report-head">
                <div>
                  <p className="report-episode">
                    {reportEpisode} · {kindDef.name}({kindDef.hanja}) {kindDef.role}
                  </p>
                  <h3>감수 리포트</h3>
                </div>
                <div className="score">
                  <span className="score-num">{report.점수}</span>
                  <span className="score-label">/100</span>
                  {prevScore != null && typeof report.점수 === 'number' && (
                    <span className={'score-delta' + (report.점수 >= prevScore ? ' up' : ' down')}>
                      {report.점수 >= prevScore ? '▲' : '▼'}
                      {Math.abs(report.점수 - prevScore)} (직전 {prevScore})
                    </span>
                  )}
                </div>
              </div>

              <p className="verdict">{report.총평}</p>

              <div className={'gate' + (blocking === 0 ? ' pass' : ' fail')}>
                {blocking === 0
                  ? '공개 기준 충족 — 고·중 심각도 0건'
                  : `공개 기준 미달 — 고·중 심각도 ${blocking}건 (감수는 자문이며 확정은 대표가 결정합니다)`}
              </div>

              {(report.이전지적처리?.length ?? 0) > 0 && (
                <div className="issue-section">
                  <h4>이전 지적 처리<span className="count">{report.이전지적처리.length}</span></h4>
                  {report.이전지적처리.map((p, i) => (
                    <div
                      className={'issue prev-' + (p.처리 === '해결' ? 'ok' : p.처리 === '부분해결' ? 'half' : 'no')}
                      key={i}
                    >
                      <div className="issue-top">
                        <span className={'prev-state s-' + p.처리}>{p.처리}</span>
                        <span className="quote">{p.지적}</span>
                      </div>
                      {p.코멘트 && <p className="issue-body">{p.코멘트}</p>}
                    </div>
                  ))}
                </div>
              )}

              <div className="quick-row">
                {report.분량판정 && (
                  <div className="quick">
                    <span className="quick-label">분량</span>
                    <span className="quick-value">
                      {report.분량판정.자수?.toLocaleString?.() ?? '-'}자 · {report.분량판정.판정 ?? '-'}
                    </span>
                  </div>
                )}
                {report.훅판정 && (
                  <div className={'quick' + (report.훅판정.통과 ? ' pass' : ' fail')}>
                    <span className="quick-label">말미 훅</span>
                    <span className="quick-value">
                      {report.훅판정.통과 ? '통과' : '보완 필요'} — {report.훅판정.코멘트}
                    </span>
                  </div>
                )}
                {report.메타블록 && (
                  <div className={'quick' + (report.메타블록.통과 ? ' pass' : ' fail')}>
                    <span className="quick-label">메타 블록</span>
                    <span className="quick-value">
                      {report.메타블록.통과 ? '규약 준수' : '형식 오류'} — {report.메타블록.코멘트}
                    </span>
                  </div>
                )}
                {report.등급판정 && (
                  <div className={'quick' + (report.등급판정.적합 ? ' pass' : ' fail')}>
                    <span className="quick-label">등급</span>
                    <span className="quick-value">
                      {report.등급판정.적합 ? '적합' : `권장 ${report.등급판정.권장등급}세`} —{' '}
                      {report.등급판정.코멘트}
                    </span>
                  </div>
                )}
                {report.페이스판정 && (
                  <div className={'quick' + (report.페이스판정.적정 ? ' pass' : ' fail')}>
                    <span className="quick-label">페이스</span>
                    <span className="quick-value">
                      {report.페이스판정.적정 ? '적정' : '조정 필요'} — {report.페이스판정.코멘트}
                    </span>
                  </div>
                )}
                {report.무대체크 && (
                  <div
                    className={
                      'quick' +
                      (report.무대체크.반복경고 || report.무대체크.시야경고 ? ' fail' : ' pass')
                    }
                  >
                    <span className="quick-label">무대</span>
                    <span className="quick-value">
                      {report.무대체크.반복경고 ? '반복 경고' : '반복 정상'}
                      {' · '}
                      {report.무대체크.시야경고 ? '시야 좁음' : '시야 정상'}
                      {(report.무대체크.신규인물?.length ?? 0) > 0
                        ? ` · 신규 ${report.무대체크.신규인물.join(', ')}`
                        : ' · 신규 인물 없음'}
                      {report.무대체크.코멘트 ? ` — ${report.무대체크.코멘트}` : ''}
                    </span>
                  </div>
                )}
              </div>

              {(report.무대체크?.최근5회무대?.length ?? 0) > 0 && (
                <div className="issue-section">
                  <h4>
                    최근 5회 무대<span className="count">{report.무대체크.최근5회무대.length}</span>
                  </h4>
                  {report.무대체크.최근5회무대.map((s, i) => (
                    <div className="issue" key={i}>
                      <p className="issue-body">{s}</p>
                    </div>
                  ))}
                </div>
              )}

              {(report.연령확인?.length ?? 0) > 0 && (
                <div className="issue-section">
                  <h4>연령 확인<span className="count">{report.연령확인.length}</span></h4>
                  {report.연령확인.map((a, i) => (
                    <div className={'issue age-' + (a.판정 === '성인' ? 'ok' : 'no')} key={i}>
                      <div className="issue-top">
                        <span className="bait-name">{a.인물} ({a.나이})</span>
                        <span className="bait-state">{a.판정}</span>
                      </div>
                      <p className="issue-body">{a.장면}</p>
                    </div>
                  ))}
                </div>
              )}

              {issueSections.map((sec) => (
                <div className="issue-section" key={sec.key}>
                  <h4>{sec.label}<span className="count">{sec.items.length}</span></h4>
                  {sec.items.length === 0 ? (
                    <p className="clean">지적 사항 없음</p>
                  ) : (
                    sec.items.map((it, i) => (
                      <div className={'issue sev-' + (it.심각도 || '낮음')} key={i}>
                        <div className="issue-top">
                          <span className="sev-glyph">{SEVERITY_GLYPH[it.심각도] || '○'}</span>
                          <span className="sev-name">{it.심각도}</span>
                          {it.대목 && <span className="quote">“{it.대목}”</span>}
                        </div>
                        <p className="issue-body">{it.지적}</p>
                        {it.수정제안 && (
                          <p className="issue-fix"><span>수정 제안</span> {it.수정제안}</p>
                        )}
                      </div>
                    ))
                  )}
                </div>
              ))}

              {(report.떡밥체크?.length ?? 0) > 0 && (
                <div className="issue-section">
                  <h4>떡밥 체크<span className="count">{report.떡밥체크.length}</span></h4>
                  {report.떡밥체크.map((b, i) => (
                    <div className="issue bait" key={i}>
                      <div className="issue-top">
                        <span className="bait-name">{b.떡밥}</span>
                        <span className="bait-state">{b.상태}</span>
                      </div>
                      <p className="issue-body">{b.코멘트}</p>
                    </div>
                  ))}
                </div>
              )}

              {(report.로드맵체크?.length ?? 0) > 0 && (
                <div className="issue-section">
                  <h4>로드맵 체크<span className="count">{report.로드맵체크.length}</span></h4>
                  {report.로드맵체크.map((r, i) => (
                    <div className={'issue bait' + (r.판정 === '조기노출' ? ' prev-no' : '')} key={i}>
                      <div className="issue-top">
                        <span className="bait-name">{r.항목}</span>
                        <span className="bait-state">{r.판정}</span>
                      </div>
                      <p className="issue-body">{r.코멘트}</p>
                    </div>
                  ))}
                </div>
              )}

              {report.타임라인요약 && (
                <div className="timeline-apply">
                  <p className="tl-summary"><span>타임라인 요약</span> {report.타임라인요약}</p>
                  <button
                    className="btn primary"
                    onClick={applyTimeline}
                    disabled={timelineApplied}
                    title="원고 확정을 누르면 자동으로 반영됩니다. 확정하지 않고 타임라인에만 넣고 싶을 때 쓰세요."
                  >
                    {timelineApplied ? '타임라인 반영 완료' : '타임라인만 반영'}
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      {/* ── 작품 등록/편집 모달 ── */}
      {editing !== null && (
        <div className="modal-scrim" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editing === 'new' ? '작품 등록' : '작품 문서 편집'}</h3>
            <label className="field">
              <span>작품명</span>
              <input
                id="w-title"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder="예: 패수"
              />
            </label>
            <label className="field">
              <span>장르 / 연재 조건</span>
              <input
                id="w-genre"
                value={draft.genre}
                onChange={(e) => setDraft({ ...draft, genre: e.target.value })}
                placeholder="예: 대체역사, 문피아, 19세, 주5회, 회당 5,500~6,500자"
              />
            </label>
            {DOC_FIELDS.map(([key, name, ph]) => (
              <label className="field" key={key}>
                <span>
                  {name}
                  <em className="field-count">{(draft.docs[key] || '').length.toLocaleString()}자</em>
                </span>
                <textarea
                  id={'doc-' + key}
                  value={draft.docs[key] || ''}
                  onChange={(e) => setDraft({ ...draft, docs: { ...draft.docs, [key]: e.target.value } })}
                  placeholder={ph}
                />
              </label>
            ))}
            <div className="modal-actions">
              {editing !== 'new' && (
                <button className="btn danger" onClick={() => deleteWork(editing)}>작품 삭제</button>
              )}
              <div className="spacer" />
              <button className="btn ghost" onClick={() => setEditing(null)}>취소</button>
              <button className="btn primary" onClick={saveDraft}>저장</button>
            </div>
          </div>
        </div>
      )}

      <footer className="foot">
        edge writer v2.2 · 감수 3종(감·어사·도목수) · 문서 6종 · 확정 원고 클라우드 보관 · 개정 이력
      </footer>
    </div>
  )
}
