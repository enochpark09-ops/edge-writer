// Vercel 서버리스 함수 — Anthropic API 프록시
//
// 왜 필요한가:
//   기존 src/api.js는 import.meta.env.VITE_ANTHROPIC_API_KEY를 썼다.
//   Vite는 VITE_ 접두사 변수를 빌드 때 번들에 그대로 박아 넣으므로,
//   배포된 사이트에서 개발자도구만 열면 누구나 API 키를 읽을 수 있었다.
//   이 함수는 서버에서만 키를 읽고 브라우저에는 결과만 돌려준다.
//
// Vercel 환경변수 (Settings → Environment Variables):
//   ANTHROPIC_API_KEY   ← VITE_ 접두사를 붙이지 않는다. 이게 핵심이다.
//   EDGE_WRITER_SECRET  ← 선택. 설정하면 이 값을 아는 요청만 통과시킨다.

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST만 허용합니다.' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY가 없습니다. Vercel 환경변수를 확인하세요. (VITE_ 접두사를 붙이면 안 됩니다)'
    })
  }

  // 선택적 접근 제한 — 공개 URL에 프록시를 그대로 열어두지 않기 위한 최소 장치
  const secret = process.env.EDGE_WRITER_SECRET
  if (secret && req.headers['x-edge-secret'] !== secret) {
    return res.status(401).json({ error: '접근 권한이 없습니다.' })
  }

  const { system, message, maxTokens = 8000 } = req.body || {}
  if (!system || !message) {
    return res.status(400).json({ error: 'system과 message가 필요합니다.' })
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: message }]
      })
    })

    const data = await upstream.json()

    if (!upstream.ok) {
      const msg = data?.error?.message || '알 수 없는 오류'
      // 모델 오류를 API 키 문제로 잘못 안내하던 기존 버그를 여기서 바로잡는다
      const hint = /model/i.test(msg)
        ? ` (모델 이름을 확인하세요. 현재 설정: ${MODEL} — Vercel 환경변수 ANTHROPIC_MODEL로 바꿀 수 있습니다)`
        : ''
      return res.status(upstream.status).json({ error: msg + hint })
    }

    if (data.stop_reason === 'max_tokens') {
      return res.status(422).json({
        error: '감수 응답이 길이 제한에 걸려 잘렸습니다. 원고를 나눠서 감수하거나 다시 실행해 주세요.'
      })
    }

    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')

    return res.status(200).json({ text, usage: data.usage })
  } catch (e) {
    return res.status(502).json({ error: `Anthropic 호출 실패: ${e.message}` })
  }
}
