import { useState, useEffect, useRef, useCallback } from 'react'
import { createChart, ColorType, CandlestickSeries, LineSeries, HistogramSeries } from 'lightweight-charts'

// ═══════════════════════════════════════════════════════════════
// 설정
// ═══════════════════════════════════════════════════════════════

const PREV_CLOSE = {
  '012450': 1432000, '079550': 661000, '272210': 146700, '064350': 249000,
  '010950': 141300, '096770': 130000, '011200': 25750, '028670': 4800,
  '005930': 195100, '000660': 939000,
}

const STOCK_NAMES = {
  '012450': '한화에어로', '079550': 'LIG넥스원', '272210': '한화시스템',
  '064350': '현대로템', '010950': '에쓰오일', '096770': 'SK이노베이션',
  '011200': 'HMM', '028670': '팬오션', '005930': '삼성전자', '000660': 'SK하이닉스',
}

// MDI 기본 레이아웃: 6개 차트 패널 (3열 × 2행)
const DEFAULT_PANELS = [
  { id: 'kospi',  title: 'KOSPI 지수',  type: 'index',  code: 'KOSPI',  row: 0, col: 0 },
  { id: '005930', title: '삼성전자',      type: 'stock',  code: '005930', row: 0, col: 1 },
  { id: '000660', title: 'SK하이닉스',    type: 'stock',  code: '000660', row: 0, col: 2 },
  { id: '012450', title: '한화에어로',    type: 'stock',  code: '012450', row: 1, col: 0 },
  { id: '079550', title: 'LIG넥스원',    type: 'stock',  code: '079550', row: 1, col: 1 },
  { id: '010950', title: '에쓰오일',      type: 'stock',  code: '010950', row: 1, col: 2 },
]

function calcQty(code, price) {
  if (!price || price <= 0) return 1
  return Math.max(1, Math.floor(5_000_000 / price))
}

// ═══════════════════════════════════════════════════════════════
// 실시간 캔들 차트 컴포넌트
// ═══════════════════════════════════════════════════════════════

function RealtimeChart({ code, title, price, prevPrice, whipsaw, onBuy, onSell }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const candleSeriesRef = useRef(null)
  const volumeSeriesRef = useRef(null)
  const lastBarRef = useRef(null)

  // 차트 초기화
  useEffect(() => {
    if (!containerRef.current) return

    // 높이 보호 — 컨테이너가 아직 렌더링되지 않았으면 최소값 보장
    const cw = containerRef.current.clientWidth || 300
    const ch = containerRef.current.clientHeight
    const chartHeight = Math.max(ch - 36, 100)

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0a0a0a' },
        textColor: '#888',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: '#1a1a2e' },
        horzLines: { color: '#1a1a2e' },
      },
      width: cw,
      height: chartHeight,
      timeScale: {
        timeVisible: true,
        secondsVisible: true,
        borderColor: '#333',
      },
      rightPriceScale: {
        borderColor: '#333',
        scaleMargins: { top: 0.1, bottom: 0.2 },
      },
      crosshair: {
        mode: 0,
        vertLine: { color: '#444', style: 2 },
        horzLine: { color: '#444', style: 2 },
      },
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#ef5350',
      downColor: '#2962ff',
      borderUpColor: '#ef5350',
      borderDownColor: '#2962ff',
      wickUpColor: '#ef5350',
      wickDownColor: '#2962ff',
    })

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    })

    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    })

    // 전일 종가 기준선
    if (prevPrice && prevPrice > 0) {
      candleSeries.createPriceLine({
        price: prevPrice,
        color: '#ffffff33',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: '전일',
      })
    }

    chartRef.current = chart
    candleSeriesRef.current = candleSeries
    volumeSeriesRef.current = volumeSeries

    // 과거 캔들 시드 로드 (snapshot의 candle_history)
    if (window.__CANDLE_HISTORY && window.__CANDLE_HISTORY[code]) {
      const hist = window.__CANDLE_HISTORY[code]
      candleSeries.setData(hist)
      volumeSeries.setData(hist.map(c => ({
        time: c.time,
        value: c.volume || 0,
        color: c.close >= c.open ? '#ef535066' : '#2962ff66',
      })))
      if (hist.length > 0) {
        lastBarRef.current = { ...hist[hist.length - 1] }
      }
    }

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth || 300,
          height: Math.max(containerRef.current.clientHeight - 36, 100),
        })
      }
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
    }
  }, [prevPrice])

  // 실시간 틱 → 1분봉 누적
  useEffect(() => {
    if (!price || price <= 0 || !candleSeriesRef.current) return

    const now = Math.floor(Date.now() / 1000)
    const barTime = now - (now % 60)
    const lastBar = lastBarRef.current

    if (lastBar && lastBar.time === barTime) {
      lastBar.high = Math.max(lastBar.high, price)
      lastBar.low = Math.min(lastBar.low, price)
      lastBar.close = price
      lastBar.volume = (lastBar.volume || 0) + 1
      candleSeriesRef.current.update(lastBar)
      volumeSeriesRef.current.update({
        time: barTime,
        value: lastBar.volume,
        color: price >= lastBar.open ? '#ef535066' : '#2962ff66',
      })
    } else {
      const newBar = { time: barTime, open: price, high: price, low: price, close: price, volume: 1 }
      lastBarRef.current = newBar
      candleSeriesRef.current.update(newBar)
      volumeSeriesRef.current.update({ time: barTime, value: 1, color: '#888' })
    }
  }, [price])

  const chg = prevPrice > 0 ? ((price - prevPrice) / prevPrice * 100) : 0
  const chgColor = chg >= 0 ? '#ef5350' : '#2962ff'
  const flagColor = {
    emergency: '#ff0000', crash: '#ff4444', near_limit: '#ffaa00', normal: '#00cc66'
  }[whipsaw?.flag] || '#333'
  const isBuyDisabled = whipsaw?.flag === 'near_limit' || whipsaw?.flag === 'emergency'

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      border: `1px solid ${flagColor}`, borderRadius: 2,
      background: '#0a0a0a', overflow: 'hidden', minHeight: 0,
    }}>
      {/* 헤더 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '3px 8px', background: '#111', borderBottom: `2px solid ${flagColor}`,
        height: 32, flexShrink: 0,
      }}>
        <span style={{ fontWeight: 'bold', fontSize: 12, color: '#eee', minWidth: 70 }}>{title}</span>
        <span style={{ fontSize: 13, fontWeight: 'bold', color: chgColor }}>
          {price?.toLocaleString()}
        </span>
        <span style={{ fontSize: 11, color: chgColor }}>
          {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
        </span>
        {whipsaw?.drawdown_pct ? (
          <span style={{ fontSize: 10, color: '#ff8888' }}>↓{whipsaw.drawdown_pct}%</span>
        ) : null}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button onClick={onBuy} disabled={isBuyDisabled}
            style={{
              background: '#003300', color: '#0f0', border: '1px solid #060',
              padding: '1px 6px', fontSize: 10, cursor: 'pointer', borderRadius: 2,
              opacity: isBuyDisabled ? 0.3 : 1,
            }}>매수</button>
          <button onClick={onSell}
            style={{
              background: '#330000', color: '#f44', border: '1px solid #600',
              padding: '1px 6px', fontSize: 10, cursor: 'pointer', borderRadius: 2,
            }}>매도</button>
        </div>
      </div>

      {/* 차트 영역 */}
      <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 매크로 바 (상단)
// ═══════════════════════════════════════════════════════════════

function MacroBar({ state }) {
  if (!state) return null
  const { regime, beta, war_day, wti, usdkrw, daily_pnl, auto_trading, news_sentiment } = state
  const pnlColor = daily_pnl >= 0 ? '#00cc66' : '#ff4444'
  const regimeColors = {
    EXTREME_CRISIS: '#ff0000', CRISIS: '#ff2222', CAUTIOUS: '#ffaa00',
    RECOVERY: '#00cc66', AGGRESSIVE: '#00ff44',
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, padding: '4px 12px',
      background: '#0d0d1a', borderBottom: '1px solid #222', fontSize: 12, flexWrap: 'wrap',
    }}>
      <span style={{ color: regimeColors[regime] || '#888', fontWeight: 'bold' }}>● {regime}</span>
      <span>β <b>{beta?.toFixed(2)}</b></span>
      <span>D+<b>{war_day}</b></span>
      <span>WTI <b>${wti?.toFixed(1)}</b></span>
      <span>환율 <b>{usdkrw?.toFixed(0)}₩</b></span>
      <span style={{ fontSize: 10, color: news_sentiment?.startsWith('NEG') ? '#ff6666' : news_sentiment?.startsWith('POS') ? '#66ff99' : '#888' }}>
        뉴스:{news_sentiment}
      </span>
      <span style={{ marginLeft: 'auto', color: pnlColor, fontWeight: 'bold' }}>
        일손익 {daily_pnl >= 0 ? '+' : ''}{daily_pnl?.toLocaleString()}원
      </span>
      <span style={{ color: auto_trading ? '#0c6' : '#f80', fontSize: 10 }}>
        [{auto_trading ? '자동ON' : '자동OFF'}]
      </span>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 요동장 배너
// ═══════════════════════════════════════════════════════════════

function WhipsawBanner({ status, phase }) {
  const flags = { emergency: '🚨긴급', crash: '📉폭락', near_limit: '⚠️상한근접' }
  const items = Object.entries(status || {}).filter(([, v]) => v.flag !== 'normal')
  if (!items.length) return null

  return (
    <div style={{
      display: 'flex', gap: 12, padding: '3px 12px', flexWrap: 'wrap',
      background: '#1a0000', borderBottom: '1px solid #330000', fontSize: 11,
    }}>
      <span style={{ color: '#ff8888' }}>요동장 [{phase}]</span>
      {items.map(([code, v]) => (
        <span key={code} style={{ color: '#ffaaaa' }}>
          {v.name} {flags[v.flag]} {v.drawdown_pct}%
          {v.locked_until && ` (~${v.locked_until})`}
        </span>
      ))}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 우측 사이드 패널: 보유종목 + 시그널 + 차트 배치 변경기
// ═══════════════════════════════════════════════════════════════

function SidePanel({ state, panels, onChangePanel }) {
  const signals = state?.signals || []
  const holdings = state?.holdings || []
  const actionColor = { BUY: '#0c6', SELL: '#f44', HOLD: '#888' }

  return (
    <div style={{
      width: 280, display: 'flex', flexDirection: 'column',
      borderLeft: '1px solid #222', background: '#0a0a0a', overflow: 'hidden',
    }}>
      {/* 차트 배치 변경기 */}
      <div style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>
        <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>차트 배치 변경</div>
        {panels.map((p, i) => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
            <span style={{ fontSize: 10, color: '#888', width: 14 }}>{i + 1}</span>
            <select value={p.code} onChange={e => onChangePanel(i, e.target.value)}
              style={{
                flex: 1, background: '#111', color: '#ccc', border: '1px solid #333',
                fontSize: 10, padding: '1px 4px',
              }}>
              <option value="KOSPI">KOSPI 지수</option>
              {Object.entries(STOCK_NAMES).map(([c, n]) => (
                <option key={c} value={c}>{n} ({c})</option>
              ))}
            </select>
          </div>
        ))}
      </div>

      {/* 보유종목 */}
      <div style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>
        <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>보유종목</div>
        {holdings.length === 0
          ? <div style={{ fontSize: 10, color: '#444' }}>없음</div>
          : holdings.map(h => (
            <div key={h.code} style={{ fontSize: 10, lineHeight: 1.6, color: '#ccc' }}>
              {h.name} {h.qty}주
              <span style={{ color: h.pnl >= 0 ? '#f66' : '#69f', marginLeft: 4 }}>
                {h.pnl >= 0 ? '+' : ''}{h.pnl?.toLocaleString()}원
              </span>
            </div>
          ))
        }
      </div>

      {/* 시그널 로그 */}
      <div style={{ flex: 1, overflow: 'auto', padding: '6px 8px' }}>
        <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>시그널 로그</div>
        {signals.slice(0, 80).map((s, i) => (
          <div key={i} style={{ fontSize: 10, color: '#aaa', lineHeight: 1.5 }}>
            <span style={{ color: actionColor[s.action] || '#888' }}>[{s.action}]</span>{' '}
            {s.name} {s.price?.toLocaleString()} × {s.qty} — {s.reason}
          </div>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 메인: MDI 멀티차트 대시보드
// ═══════════════════════════════════════════════════════════════

export default function TradingDashboard() {
  const [state, setState] = useState(null)
  const [connected, setConnected] = useState(false)
  const [panels, setPanels] = useState(DEFAULT_PANELS)
  const ws = useRef(null)

  // WebSocket 연결 + 자동 재연결
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
        if (msg.type === 'snapshot') {
          if (msg.data.candle_history) {
            window.__CANDLE_HISTORY = msg.data.candle_history
          }
          setState(msg.data)
        }
        if (msg.type === 'update') {
          setState(prev => {
            if (!prev) return null
            return {
              ...prev,
              prices: msg.prices ?? prev.prices,
              regime: msg.regime ?? prev.regime,
              beta: msg.beta ?? prev.beta,
              war_day: msg.war_day ?? prev.war_day,
              wti: msg.wti ?? prev.wti,
              usdkrw: msg.usdkrw ?? prev.usdkrw,
              news_sentiment: msg.news_sentiment ?? prev.news_sentiment,
              phase: msg.phase ?? prev.phase,
              whipsaw_status: msg.whipsaw_status ?? prev.whipsaw_status,
              daily_pnl: msg.daily_pnl ?? prev.daily_pnl,
              holdings: msg.holdings ?? prev.holdings,
              signals: msg.signals ?? prev.signals,
              kospi: msg.kospi ?? prev.kospi,
              auto_trading: msg.auto_trading ?? prev.auto_trading,
            }
          })
        }
      }
    }

    connect()
    return () => { clearTimeout(reconnectTimer); ws.current?.close() }
  }, [])

  const send = useCallback((payload) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(payload))
    }
  }, [])

  const handleBuy = useCallback((code, price) => {
    send({ cmd: 'buy', code, price, qty: calcQty(code, price) })
  }, [send])

  const handleSell = useCallback((code) => {
    send({ cmd: 'emergency_sell', code })
  }, [send])

  const handleChangePanel = useCallback((index, newCode) => {
    setPanels(prev => {
      const next = [...prev]
      const name = newCode === 'KOSPI' ? 'KOSPI 지수' : (STOCK_NAMES[newCode] || newCode)
      next[index] = { ...next[index], code: newCode, title: name, type: newCode === 'KOSPI' ? 'index' : 'stock' }
      return next
    })
  }, [])

  if (!state) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', color: '#555', fontSize: 14, background: '#0a0a0a',
      }}>
        {connected ? '데이터 수신 중...' : '🔴 서버 연결 중... (war_engine.py 실행 확인)'}
      </div>
    )
  }

  const prices = state.prices || {}
  const whipsawStatus = state.whipsaw_status || {}
  const rows = [
    panels.filter(p => p.row === 0),
    panels.filter(p => p.row === 1),
  ]

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100vh', overflow: 'hidden', background: '#0a0a0a', color: '#ccc',
      fontFamily: "'Consolas', 'Courier New', monospace",
    }}>
      <MacroBar state={state} />
      <WhipsawBanner status={whipsawStatus} phase={state.phase} />

      {/* 컨트롤 바 */}
      <div style={{
        display: 'flex', gap: 8, padding: '3px 12px', background: '#111',
        borderBottom: '1px solid #222', alignItems: 'center',
      }}>
        <button onClick={() => send({ cmd: 'toggle_auto', enabled: !state.auto_trading })}
          style={{
            fontSize: 10, padding: '2px 8px', cursor: 'pointer', borderRadius: 2,
            background: state.auto_trading ? '#030' : '#300',
            color: state.auto_trading ? '#0f0' : '#f66',
            border: '1px solid #444',
          }}>
          {state.auto_trading ? '자동ON→OFF' : '자동OFF→ON'}
        </button>
        <button onClick={() => send({ cmd: 'cancel_all' })}
          style={{
            fontSize: 10, padding: '2px 8px', cursor: 'pointer', borderRadius: 2,
            background: '#210', color: '#fa4', border: '1px solid #432',
          }}>전체취소</button>
      </div>

      {/* 메인 영역: 차트 그리드 + 사이드 패널 */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* 차트 그리드 (3×2) */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          gap: 2, padding: 2, overflow: 'hidden',
        }}>
          {rows.map((row, ri) => (
            <div key={ri} style={{ display: 'flex', flex: 1, gap: 2, minHeight: 0 }}>
              {row.map(panel => {
                const code = panel.code
                const price = code === 'KOSPI' ? (state.kospi || 0) : (prices[code] || 0)
                const prev = PREV_CLOSE[code] || 0
                const whipsaw = whipsawStatus[code]

                return (
                  <div key={panel.id} style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <RealtimeChart
                      code={code}
                      title={panel.title}
                      price={price}
                      prevPrice={prev}
                      whipsaw={whipsaw}
                      onBuy={() => handleBuy(code, price)}
                      onSell={() => handleSell(code)}
                    />
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        {/* 우측 사이드 패널 */}
        <SidePanel state={state} panels={panels} onChangePanel={handleChangePanel} />
      </div>
    </div>
  )
}
