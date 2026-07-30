import { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_WORK } from './defaultWork'
import { reviewManuscript } from './api'

const STORE_KEY = 'edgewriter.works.v1'

function loadWorks() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length) return parsed
    }
  } catch (e) {
    console.error('작품 데이터 로드 실패', e)
  }
  return [structuredClone(DEFAULT_WORK)]
}

function saveWorks(works) {
  localStorage.setItem(STORE_KEY, JSON.stringify(works))
}

const EMPTY_DRAFT = {
  title: '',
  genre: '',
  docs: { plan: '', world: '', characters: '' }
}

const SEVERITY_GLYPH = { 높음: '●', 중간: '▲', 낮음: '○' }

export default function App() {
  const [works, setWorks] = useState(loadWorks)
  const [selectedId, setSelectedId] = useState(() => loadWorks()[0]?.id)
  const [episodeLabel, setEpisodeLabel] = useState('')
  const [manuscript, setManuscript] = useState('')
  const [report, setReport] = useState(null)
  const [reportEpisode, setReportEpisode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null) // null | 'new' | workId
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const [showTimeline, setShowTimeline] = useState(false)
  const [timelineApplied, setTimelineApplied] = useState(false)
  const [prevScore, setPrevScore] = useState(null)
  const fileRef = useRef(null)

  const work = useMemo(
    () => works.find((w) => w.id === selectedId) || works[0],
    [works, selectedId]
  )

  useEffect(() => saveWorks(works), [works])

  const charCount = manuscript.replace(/\s/g, '').length
  const charCountRaw = manuscript.length

  function updateWork(id, updater) {
    setWorks((prev) => prev.map((w) => (w.id === id ? updater(w) : w)))
  }

  function openEditor(target) {
    if (target === 'new') {
      setDraft(structuredClone(EMPTY_DRAFT))
      setEditing('new')
    } else {
      const w = works.find((x) => x.id === target)
      if (!w) return
      setDraft({ title: w.title, genre: w.genre, docs: { ...w.docs } })
      setEditing(target)
    }
  }

  function saveDraft() {
    if (!draft.title.trim()) return
    if (editing === 'new') {
      const nw = {
        id: 'w-' + Date.now(),
        title: draft.title.trim(),
        genre: draft.genre.trim(),
        docs: { ...draft.docs },
        timeline: []
      }
      setWorks((prev) => [...prev, nw])
      setSelectedId(nw.id)
    } else {
      updateWork(editing, (w) => ({
        ...w,
        title: draft.title.trim(),
        genre: draft.genre.trim(),
        docs: { ...draft.docs }
      }))
    }
    setEditing(null)
  }

  function deleteWork(id) {
    if (works.length <= 1) {
      alert('마지막 작품은 삭제할 수 없습니다. 새 작품을 먼저 등록하세요.')
      return
    }
    if (!confirm('이 작품과 타임라인을 삭제할까요? 되돌릴 수 없습니다.')) return
    setWorks((prev) => prev.filter((w) => w.id !== id))
    if (selectedId === id) setSelectedId(works.find((w) => w.id !== id)?.id)
    setEditing(null)
  }

  async function runReview(isRecheck = false) {
    if (!work) return
    if (!manuscript.trim()) {
      setError('원고를 붙여넣은 뒤 감수를 실행하세요.')
      return
    }
    if (isRecheck && !work.lastReview) {
      setError('재감수할 직전 리포트가 없습니다. 먼저 감수를 실행하세요.')
      return
    }
    setLoading(true)
    setError('')
    setReport(null)
    setTimelineApplied(false)
    const label =
      episodeLabel.trim() ||
      (isRecheck ? work.lastReview.episode : '회차 미표기 원고')
    const prev = isRecheck ? work.lastReview : null
    try {
      const result = await reviewManuscript(work, label, manuscript, prev)
      setReport(result)
      setReportEpisode(label)
      setPrevScore(isRecheck ? prev.report?.점수 ?? null : null)
      updateWork(work.id, (w) => ({
        ...w,
        lastReview: { episode: label, report: result, at: Date.now() }
      }))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function applyTimeline() {
    if (!report?.타임라인요약 || !work) return
    const entry = `${reportEpisode}: ${report.타임라인요약}`
    updateWork(work.id, (w) => ({ ...w, timeline: [...w.timeline, entry] }))
    setTimelineApplied(true)
  }

  function removeTimelineEntry(idx) {
    if (!confirm('이 타임라인 항목을 삭제할까요?')) return
    updateWork(work.id, (w) => ({
      ...w,
      timeline: w.timeline.filter((_, i) => i !== idx)
    }))
  }

  function exportWorks() {
    const blob = new Blob([JSON.stringify(works, null, 2)], {
      type: 'application/json'
    })
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
        const parsed = JSON.parse(reader.result)
        if (!Array.isArray(parsed) || !parsed.length) throw new Error()
        if (!confirm(`백업의 작품 ${parsed.length}개로 교체할까요? 현재 데이터는 사라집니다.`)) return
        setWorks(parsed)
        setSelectedId(parsed[0].id)
      } catch {
        alert('백업 파일 형식이 올바르지 않습니다.')
      }
    }
    reader.readAsText(file)
    ev.target.value = ''
  }

  const issueSections = report
    ? [
        { key: '설정오류', label: '설정 오류', items: report.설정오류 || [] },
        { key: '인물불일치', label: '인물 불일치', items: report.인물불일치 || [] },
        { key: '문체지적', label: '문체 지적', items: report.문체지적 || [] }
      ]
    : []

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

      <main className="layout">
        {/* ── 작품 서재 ── */}
        <aside className="library">
          <div className="panel-title">
            <h2>작품 서재</h2>
            <button className="btn ghost sm" onClick={() => openEditor('new')}>
              + 작품 등록
            </button>
          </div>

          <ul className="work-list">
            {works.map((w) => (
              <li key={w.id}>
                <button
                  className={'work-item' + (w.id === work?.id ? ' active' : '')}
                  onClick={() => {
                    setSelectedId(w.id)
                    setReport(null)
                    setError('')
                  }}
                >
                  <span className="work-title">{w.title}</span>
                  <span className="work-meta">
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
                {[
                  ['기획안', work.docs.plan],
                  ['설정집', work.docs.world],
                  ['인물집', work.docs.characters]
                ].map(([name, body]) => (
                  <span
                    key={name}
                    className={'doc-badge' + (body.trim() ? ' ok' : ' empty')}
                    title={body.trim() ? `${body.length.toLocaleString()}자` : '비어 있음'}
                  >
                    {name}
                  </span>
                ))}
              </div>
              <div className="work-actions">
                <button className="btn ghost sm" onClick={() => openEditor(work.id)}>
                  문서 편집
                </button>
                <button
                  className="btn ghost sm"
                  onClick={() => setShowTimeline((v) => !v)}
                >
                  타임라인 {showTimeline ? '닫기' : '보기'}
                </button>
              </div>
            </div>
          )}

          {showTimeline && work && (
            <div className="timeline">
              <h3>확정 타임라인</h3>
              {work.timeline.length === 0 && (
                <p className="muted">
                  아직 확정된 회차가 없습니다. 감수 후 "타임라인 반영"으로 쌓입니다.
                </p>
              )}
              <ol>
                {work.timeline.map((t, i) => (
                  <li key={i}>
                    <span>{t}</span>
                    <button
                      className="entry-del"
                      onClick={() => removeTimelineEntry(i)}
                      aria-label="항목 삭제"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="backup-row">
            <button className="btn ghost sm" onClick={exportWorks}>
              백업 내보내기
            </button>
            <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>
              백업 불러오기
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              hidden
              onChange={importWorks}
            />
          </div>
        </aside>

        {/* ── 감수 데스크 ── */}
        <section className="desk">
          <div className="desk-head">
            <h2>
              원고 감수 <span className="desk-work">— {work?.title}</span>
            </h2>
          </div>

          <div className="input-row">
            <input
              className="episode-input"
              placeholder="회차 표기 (예: 2화. 3일의 설계)"
              value={episodeLabel}
              onChange={(e) => setEpisodeLabel(e.target.value)}
            />
            <span className="char-counter">
              {charCount.toLocaleString()}자
              <em> (공백 포함 {charCountRaw.toLocaleString()})</em>
            </span>
          </div>

          <textarea
            className="manuscript"
            placeholder="회차 원고 전문을 붙여넣으세요."
            value={manuscript}
            onChange={(e) => setManuscript(e.target.value)}
          />

          <div className="run-row">
            <button
              className="btn primary"
              onClick={() => runReview(false)}
              disabled={loading}
            >
              {loading ? '감수 중…' : '감수 실행'}
            </button>
            <button
              className="btn recheck"
              onClick={() => runReview(true)}
              disabled={loading || !work?.lastReview}
              title={
                work?.lastReview
                  ? `직전 리포트(${work.lastReview.episode}, ${work.lastReview.report?.점수 ?? '-'}점)와 대조하여 개정고를 감수합니다`
                  : '먼저 감수를 1회 실행하면 활성화됩니다'
              }
            >
              재감수 실행
            </button>
            {work?.lastReview && !loading && (
              <span className="recheck-hint">
                직전: {work.lastReview.episode} ·{' '}
                {work.lastReview.report?.점수 ?? '-'}점
              </span>
            )}
            {error && <p className="error">{error}</p>}
          </div>

          {loading && (
            <div className="loading-note">
              설정 문서 3종과 타임라인 {work?.timeline.length ?? 0}건을 대조하고
              있습니다…
            </div>
          )}

          {report && (
            <div className="report">
              <div className="report-head">
                <div>
                  <p className="report-episode">{reportEpisode}</p>
                  <h3>감수 리포트</h3>
                </div>
                <div className="score">
                  <span className="score-num">{report.점수}</span>
                  <span className="score-label">/100</span>
                  {prevScore != null && typeof report.점수 === 'number' && (
                    <span
                      className={
                        'score-delta' +
                        (report.점수 >= prevScore ? ' up' : ' down')
                      }
                    >
                      {report.점수 >= prevScore ? '▲' : '▼'}
                      {Math.abs(report.점수 - prevScore)} (직전 {prevScore})
                    </span>
                  )}
                </div>
              </div>

              <p className="verdict">{report.총평}</p>

              {(report.이전지적처리?.length ?? 0) > 0 && (
                <div className="issue-section">
                  <h4>
                    이전 지적 처리
                    <span className="count">{report.이전지적처리.length}</span>
                  </h4>
                  {report.이전지적처리.map((p, i) => (
                    <div
                      className={
                        'issue prev-' +
                        (p.처리 === '해결'
                          ? 'ok'
                          : p.처리 === '부분해결'
                            ? 'half'
                            : 'no')
                      }
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
                <div className="quick">
                  <span className="quick-label">분량</span>
                  <span className="quick-value">
                    {report.분량판정?.자수?.toLocaleString?.() ?? '-'}자 ·{' '}
                    {report.분량판정?.판정 ?? '-'}
                  </span>
                </div>
                <div className={'quick' + (report.훅판정?.통과 ? ' pass' : ' fail')}>
                  <span className="quick-label">말미 훅</span>
                  <span className="quick-value">
                    {report.훅판정?.통과 ? '통과' : '보완 필요'} —{' '}
                    {report.훅판정?.코멘트}
                  </span>
                </div>
              </div>

              {issueSections.map((sec) => (
                <div className="issue-section" key={sec.key}>
                  <h4>
                    {sec.label}
                    <span className="count">{sec.items.length}</span>
                  </h4>
                  {sec.items.length === 0 ? (
                    <p className="clean">지적 사항 없음</p>
                  ) : (
                    sec.items.map((it, i) => (
                      <div className={'issue sev-' + (it.심각도 || '낮음')} key={i}>
                        <div className="issue-top">
                          <span className="sev-glyph">
                            {SEVERITY_GLYPH[it.심각도] || '○'}
                          </span>
                          <span className="sev-name">{it.심각도}</span>
                          {it.대목 && <span className="quote">“{it.대목}”</span>}
                        </div>
                        <p className="issue-body">{it.지적}</p>
                        {it.수정제안 && (
                          <p className="issue-fix">
                            <span>수정 제안</span> {it.수정제안}
                          </p>
                        )}
                      </div>
                    ))
                  )}
                </div>
              ))}

              {(report.떡밥체크?.length ?? 0) > 0 && (
                <div className="issue-section">
                  <h4>
                    떡밥 체크
                    <span className="count">{report.떡밥체크.length}</span>
                  </h4>
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

              <div className="timeline-apply">
                <p className="tl-summary">
                  <span>타임라인 요약</span> {report.타임라인요약}
                </p>
                <button
                  className="btn primary"
                  onClick={applyTimeline}
                  disabled={timelineApplied}
                >
                  {timelineApplied ? '타임라인 반영 완료' : '타임라인 반영'}
                </button>
              </div>
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
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder="예: 최약체 회귀병사"
              />
            </label>
            <label className="field">
              <span>장르 / 연재 조건</span>
              <input
                value={draft.genre}
                onChange={(e) => setDraft({ ...draft, genre: e.target.value })}
                placeholder="예: 회귀/밀리터리, 문피아, 주5회, 회당 5,000~5,500자"
              />
            </label>
            {[
              ['plan', '기획안', '로그라인, 구조, 핵심 원칙, 떡밥 계획…'],
              ['world', '설정집', '세계관 규칙, 시스템, 세력…'],
              ['characters', '인물집', '주요 인물 프로필, 말버릇, 관계, 아크…']
            ].map(([key, name, ph]) => (
              <label className="field" key={key}>
                <span>
                  {name}
                  <em className="field-count">
                    {draft.docs[key].length.toLocaleString()}자
                  </em>
                </span>
                <textarea
                  value={draft.docs[key]}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      docs: { ...draft.docs, [key]: e.target.value }
                    })
                  }
                  placeholder={ph}
                />
              </label>
            ))}
            <div className="modal-actions">
              {editing !== 'new' && (
                <button className="btn danger" onClick={() => deleteWork(editing)}>
                  작품 삭제
                </button>
              )}
              <div className="spacer" />
              <button className="btn ghost" onClick={() => setEditing(null)}>
                취소
              </button>
              <button className="btn primary" onClick={saveDraft}>
                저장
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="foot">
        edge writer v1.1 · 감수 기준: 작품별 기획안·설정집·인물집 + 확정 타임라인
      </footer>
    </div>
  )
}
