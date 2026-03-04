import { useState, useEffect, useRef } from 'react'

// ─── 종목당 최대 예산 기준 수량 계산 ───
function calcQty(code, price) {
  if (!price || price <= 0) return 1
  const budget = 5_000_000 // 종목당 최대 500만원
  return Math.max(1, Math.floor(budget / price))
}

// ─── 상단 매크로 정보 바 ───
function MacroBar({ regime, beta, warDay, wti, usdkrw, pnl, autoTrading }) {
  const pnlColor = pnl >= 0 ? '#00cc66' : '#ff4444'
  const regimeColor = {
    CRISIS: '#ff2222', CAUTIOUS: '#ffaa00',
    NEUTRAL: '#888888', BULLISH: '#00cc66',
  }[regime] || '#888888'

  return (
    <div style={{ display: 'flex', gap: 24, padding: '10px 16px', background: '#111', borderBottom: '1px solid #333', flexWrap: 'wrap', alignItems: 'center' }}>
      <span style={{ color: regimeColor, fontWeight: 'bold', fontSize: 15 }}>● {regime}</span>
      <span>β <b>{beta?.toFixed(2)}</b></span>
      <span>전쟁 D+<b>{warDay}</b></span>
      <span>WTI <b>${wti?.toFixed(1)}</b></span>
      <span>환율 <b>{usdkrw?.toFixed(0)}₩</b></span>
      <span style={{ color: pnlColor, marginLeft: 'auto' }}>
        일손익 <b>{pnl >= 0 ? '+' : ''}{pnl?.toLocaleString()}원</b>
      </span>
      <span style={{ color: autoTrading ? '#00cc66' : '#ff8800', fontSize: 12 }}>
        [{autoTrading ? '자동ON' : '자동OFF'}]
      </span>
    </div>
  )
}

// ─── 요동장 상태 배너 ───
function WhipsawBanner({ status, phase }) {
  const flagLabel = { emergency: '🚨긴급', crash: '📉폭락', near_limit: '⚠️상한근접', normal: '✅정상' }
  const items = Object.entries(status || {}).filter(([, v]) => v.flag !== 'normal')
  if (!items.length) return null

  return (
    <div style={{ background: '#1a0000', padding: '6px 16px', borderBottom: '1px solid #440000', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      <span style={{ color: '#ff8888', fontSize: 12 }}>요동장 [{phase}]</span>
      {items.map(([code, v]) => (
        <span key={code} style={{ fontSize: 12, color: '#ffaaaa' }}>
          {v.name} {flagLabel[v.flag]} 고점대비 {v.drawdown_pct}%
          {v.locked_until && ` (매수잠금 ~${v.locked_until})`}
        </span>
      ))}
    </div>
  )
}

// ─── 종목 행: 가격 + 원클릭 매매 ───
function StockRow({ code, price, whipsaw, prevPrice, onBuy, onSell }) {
  const flagColor = { emergency: '#ff0000', crash: '#ff4444', near_limit: '#ffaa00', normal: '#00cc66' }
  const chg = prevPrice > 0 ? ((price - prevPrice) / prevPrice * 100).toFixed(2) : null

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px',
      borderBottom: '1px solid #222', borderLeft: `4px solid ${flagColor[whipsaw?.flag] || '#333'}`,
    }}>
      <span style={{ width: 90, fontSize: 13 }}>{whipsaw?.name || code}</span>
      <span style={{ width: 80, textAlign: 'right', fontWeight: 'bold', color: chg >= 0 ? '#ff6666' : '#6699ff' }}>
        {price?.toLocaleString()}
      </span>
      <span style={{ width: 60, fontSize: 12, color: chg >= 0 ? '#ff6666' : '#6699ff' }}>
        {chg != null ? `${chg >= 0 ? '+' : ''}${chg}%` : ''}
      </span>
      {whipsaw?.drawdown_pct ? (
        <span style={{ fontSize: 11, color: '#ff9999' }}>↓{whipsaw.drawdown_pct}%</span>
      ) : null}
      <button
        onClick={onBuy}
        disabled={whipsaw?.flag === 'near_limit' || whipsaw?.flag === 'emergency'}
        style={{
          background: '#003300', color: '#00ff66', border: '1px solid #006600',
          padding: '3px 10px', cursor: 'pointer', fontSize: 12, borderRadius: 3,
          opacity: (whipsaw?.flag === 'near_limit' || whipsaw?.flag === 'emergency') ? 0.4 : 1,
        }}
      >
        매수 {price?.toLocaleString()}
      </button>
      <button
        onClick={onSell}
        style={{ background: '#330000', color: '#ff4444', border: '1px solid #660000', padding: '3px 10px', cursor: 'pointer', fontSize: 12, borderRadius: 3 }}
      >
        긴급매도
      </button>
    </div>
  )
}

// ─── 시그널 로그 ───
function SignalLog({ signals }) {
  const actionColor = { BUY: '#00cc66', SELL: '#ff4444', HOLD: '#888' }
  return (
    <div style={{ flex: 1, overflow: 'auto', maxHeight: 280, padding: '8px 12px' }}>
      <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>시그널 로그</div>
      {(signals || []).slice(0, 50).map((s, i) => (
        <div key={i} style={{ fontSize: 11, color: '#ccc', lineHeight: 1.6 }}>
          <span style={{ color: actionColor[s.action] || '#888' }}>[{s.action}]</span>{' '}
          {s.name} {s.price?.toLocaleString()}원 × {s.qty} ({s.chart} {Math.round((s.confidence || 0) * 100)}%) — {s.reason}
        </div>
      ))}
    </div>
  )
}

// ─── 보유종목 패널 ───
function HoldingsPanel({ holdings }) {
  if (!holdings?.length) return <div style={{ padding: 12, color: '#555', fontSize: 12 }}>보유종목 없음</div>
  return (
    <div style={{ padding: '8px 12px' }}>
      <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>보유종목</div>
      {holdings.map(h => (
        <div key={h.code} style={{ display: 'flex', gap: 16, fontSize: 12, lineHeight: 1.8 }}>
          <span style={{ width: 80 }}>{h.name}</span>
          <span>{h.qty}주</span>
          <span>평균 {h.avg_price?.toLocaleString()}</span>
          <span>현재 {h.current?.toLocaleString()}</span>
          <span style={{ color: h.pnl >= 0 ? '#ff6666' : '#6699ff' }}>
            {h.pnl >= 0 ? '+' : ''}{h.pnl?.toLocaleString()}원 ({h.pnl_pct >= 0 ? '+' : ''}{h.pnl_pct}%)
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── 메인 대시보드 ───
export default function TradingDashboard() {
  const [state, setState] = useState(null)
  const [connected, setConnected] = useState(false)
  const ws = useRef(null)

  useEffect(() => {
    let reconnectTimer = null

    function connect() {
      const WS_URL = `ws://${window.location.hostname}:5000/ws/dashboard`
      ws.current = new WebSocket(WS_URL)
      ws.current.onopen = () => setConnected(true)
      ws.current.onclose = () => {
        setConnected(false)
        reconnectTimer = setTimeout(connect, 2000)
      }
      ws.current.onmessage = (e) => {
        const msg = JSON.parse(e.data)
        if (msg.type === 'snapshot') setState(msg.data)
        if (msg.type === 'update') setState(prev => prev ? { ...prev, ...msg } : null)
      }
    }

    connect()
    return () => {
      clearTimeout(reconnectTimer)
      ws.current?.close()
    }
  }, [])

  const send = (payload) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(payload))
    }
  }

  const handleBuy = (code, price) => send({ cmd: 'buy', code, price, qty: calcQty(code, price) })
  const handleEmergencySell = (code) => send({ cmd: 'emergency_sell', code })
  const toggleAuto = () => send({ cmd: 'toggle_auto', enabled: !state?.auto_trading })
  const cancelAll = () => send({ cmd: 'cancel_all' })

  if (!state) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#555', fontSize: 14 }}>
        {connected ? '데이터 수신 중...' : '🔴 서버 연결 중... (war_engine.py 실행 확인)'}
      </div>
    )
  }

  const TARGETS_ORDER = ['012450', '079550', '272210', '064350', '010950', '096770', '011200', '028670', '005930', '000660']
  const PREV_CLOSE = {
    '012450': 1432000, '079550': 661000, '272210': 146700, '064350': 249000,
    '010950': 141300, '096770': 130000, '011200': 25750, '028670': 4800,
    '005930': 195100, '000660': 939000,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <MacroBar
        regime={state.regime} beta={state.beta} warDay={state.war_day}
        wti={state.wti} usdkrw={state.usdkrw} pnl={state.daily_pnl}
        autoTrading={state.auto_trading}
      />
      <WhipsawBanner status={state.whipsaw_status || state.whipsaw} phase={state.phase} />

      {/* 뉴스 감성 바 */}
      <div style={{ background: '#0a0a1a', padding: '4px 16px', fontSize: 11, color: '#8888cc', borderBottom: '1px solid #222' }}>
        뉴스 감성: <b style={{ color: state.news_sentiment?.startsWith('NEG') ? '#ff6666' : state.news_sentiment?.startsWith('POS') ? '#66ff99' : '#888' }}>{state.news_sentiment}</b>
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* 좌측: 종목 그리드 */}
        <div style={{ flex: 1, overflow: 'auto', borderRight: '1px solid #222' }}>
          <div style={{ display: 'flex', gap: 8, padding: '6px 12px', background: '#111' }}>
            <button onClick={toggleAuto} style={{ fontSize: 11, padding: '3px 10px', background: state.auto_trading ? '#003300' : '#330000', color: state.auto_trading ? '#00ff66' : '#ff6666', border: '1px solid #444', cursor: 'pointer', borderRadius: 3 }}>
              {state.auto_trading ? '자동 ON → OFF' : '자동 OFF → ON'}
            </button>
            <button onClick={cancelAll} style={{ fontSize: 11, padding: '3px 10px', background: '#221100', color: '#ffaa44', border: '1px solid #443300', cursor: 'pointer', borderRadius: 3 }}>
              전체취소
            </button>
          </div>
          {TARGETS_ORDER.map(code => {
            const price = (state.prices || {})[code]
            if (!price) return null
            const whipsaw = (state.whipsaw_status || state.whipsaw || {})[code]
            return (
              <StockRow
                key={code} code={code} price={price} whipsaw={whipsaw}
                prevPrice={PREV_CLOSE[code]}
                onBuy={() => handleBuy(code, price)}
                onSell={() => handleEmergencySell(code)}
              />
            )
          })}
          <HoldingsPanel holdings={state.holdings} />
        </div>

        {/* 우측: 시그널 로그 */}
        <div style={{ width: 420, overflow: 'auto' }}>
          <SignalLog signals={state.signals} />
        </div>
      </div>
    </div>
  )
}
