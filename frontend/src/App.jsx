import { useState, useEffect, useRef, useCallback } from 'react'
import { createChart, ColorType, CandlestickSeries, HistogramSeries } from 'lightweight-charts'

// ═══════════════════════════════════════════════════════════════
// 설정 상수
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

// 레이아웃 정의 (cols × rows)
const LAYOUTS = [
  { id: '1×1', cols: 1, rows: 1 },
  { id: '2×2', cols: 2, rows: 2 },
  { id: '3×2', cols: 3, rows: 2 },
  { id: '3×3', cols: 3, rows: 3 },
]

// 최대 9개 기본 패널 (3×3용)
const DEFAULT_CODES = [
  'KOSPI', '005930', '000660',
  '012450', '079550', '010950',
  '096770', '272210', '064350',
]

function makePanels(codes) {
  return codes.map(code => ({
    code,
    title: code === 'KOSPI' ? 'KOSPI 지수' : (STOCK_NAMES[code] || code),
  }))
}

function calcQty(code, price) {
  if (!price || price <= 0) return 1
  return Math.max(1, Math.floor(5_000_000 / price))
}

// ═══════════════════════════════════════════════════════════════
// 실시간 캔들 차트 — autoSize로 컨테이너 100% 채움
// ═══════════════════════════════════════════════════════════════

function RealtimeChart({ code, title, price, prevPrice, whipsaw, focused, onFocus, onBuy, onSell }) {
  const containerRef = useRef(null)
  const candleSeriesRef = useRef(null)
  const volumeSeriesRef = useRef(null)
  const lastBarRef = useRef(null)

  // 차트 초기화
  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      autoSize: true,   // ★ 컨테이너 크기에 자동 맞춤 — 수동 resize 불필요
      layout: {
        background: { type: ColorType.Solid, color: '#0a0a0a' },
        textColor: '#888',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: '#1a1a2e' },
        horzLines: { color: '#1a1a2e' },
      },
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

    candleSeriesRef.current = candleSeries
    volumeSeriesRef.current = volumeSeries

    // 과거 캔들 시드
    if (window.__CANDLE_HISTORY?.[code]) {
      const hist = window.__CANDLE_HISTORY[code]
      candleSeries.setData(hist)
      volumeSeries.setData(hist.map(c => ({
        time: c.time,
        value: c.volume || 0,
        color: c.close >= c.open ? '#ef535066' : '#2962ff66',
      })))
      if (hist.length > 0) lastBarRef.current = { ...hist[hist.length - 1] }
    }

    return () => chart.remove()
  }, [code, prevPrice])

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
  const borderColor = focused ? '#ffcc00' : flagColor
  const isBuyDisabled = whipsaw?.flag === 'near_limit' || whipsaw?.flag === 'emergency'

  return (
    <div
      onClick={onFocus}
      style={{
        display: 'flex', flexDirection: 'column',
        border: `${focused ? 2 : 1}px solid ${borderColor}`,
        borderRadius: 2, background: '#0a0a0a',
        overflow: 'hidden', height: '100%', cursor: 'pointer',
      }}
    >
      {/* 헤더 32px */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '2px 6px', background: focused ? '#1a1500' : '#111',
        borderBottom: `2px solid ${borderColor}`,
        height: 32, flexShrink: 0,
      }}>
        <span style={{ fontWeight: 'bold', fontSize: 11, color: focused ? '#ffcc00' : '#eee', minWidth: 60 }}>{title}</span>
        <span style={{ fontSize: 12, fontWeight: 'bold', color: chgColor }}>
          {price?.toLocaleString()}
        </span>
        <span style={{ fontSize: 10, color: chgColor }}>
          {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
        </span>
        {whipsaw?.drawdown_pct ? (
          <span style={{ fontSize: 9, color: '#ff8888' }}>↓{whipsaw.drawdown_pct}%</span>
        ) : null}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 3 }} onClick={e => e.stopPropagation()}>
          <button onClick={onBuy} disabled={isBuyDisabled}
            style={{
              background: '#003300', color: '#0f0', border: '1px solid #060',
              padding: '1px 5px', fontSize: 9, cursor: 'pointer', borderRadius: 2,
              opacity: isBuyDisabled ? 0.3 : 1,
            }}>매수</button>
          <button onClick={onSell}
            style={{
              background: '#330000', color: '#f44', border: '1px solid #600',
              padding: '1px 5px', fontSize: 9, cursor: 'pointer', borderRadius: 2,
            }}>매도</button>
        </div>
      </div>

      {/* 차트 — flex: 1로 남은 높이 전부 사용, autoSize가 실제 픽셀 계산 */}
      <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 매크로 바
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
      display: 'flex', alignItems: 'center', gap: 16, padding: '3px 12px',
      background: '#0d0d1a', borderBottom: '1px solid #222', fontSize: 11, flexWrap: 'wrap', flexShrink: 0,
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
      display: 'flex', gap: 12, padding: '2px 12px', flexWrap: 'wrap', flexShrink: 0,
      background: '#1a0000', borderBottom: '1px solid #330000', fontSize: 10,
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
// 우측 사이드 패널
// ═══════════════════════════════════════════════════════════════

function SidePanel({ state, panels, focusedIdx, onChangeFocused, onChangePanel }) {
  const signals = state?.signals || []
  const holdings = state?.holdings || []
  const actionColor = { BUY: '#0c6', SELL: '#f44', HOLD: '#888' }

  return (
    <div style={{
      width: 240, display: 'flex', flexDirection: 'column',
      borderLeft: '1px solid #222', background: '#0a0a0a', overflow: 'hidden', flexShrink: 0,
    }}>
      {/* ★ 포커스 차트 종목 선택기 */}
      <div style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>
        <div style={{ fontSize: 10, color: '#ffcc00', marginBottom: 4 }}>
          포커스 차트 [{focusedIdx + 1}번] 종목
        </div>
        <select value={panels[focusedIdx]?.code || 'KOSPI'}
          onChange={e => onChangePanel(focusedIdx, e.target.value)}
          style={{
            width: '100%', background: '#1a1500', color: '#ffcc00',
            border: '1px solid #665500', fontSize: 11, padding: '3px 4px',
          }}>
          <option value="KOSPI">KOSPI 지수</option>
          {Object.entries(STOCK_NAMES).map(([c, n]) => (
            <option key={c} value={c}>{n} ({c})</option>
          ))}
        </select>
      </div>

      {/* 패널 목록 (클릭으로 포커스) */}
      <div style={{ padding: '4px 8px', borderBottom: '1px solid #222' }}>
        <div style={{ fontSize: 10, color: '#666', marginBottom: 3 }}>차트 패널 (클릭=포커스)</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
          {panels.map((p, i) => (
            <button key={i} onClick={() => onChangeFocused(i)}
              style={{
                fontSize: 9, padding: '1px 5px', cursor: 'pointer', borderRadius: 2,
                background: i === focusedIdx ? '#1a1500' : '#111',
                color: i === focusedIdx ? '#ffcc00' : '#888',
                border: `1px solid ${i === focusedIdx ? '#665500' : '#333'}`,
              }}>
              {i + 1}.{p.title}
            </button>
          ))}
        </div>
      </div>

      {/* 보유종목 */}
      <div style={{ padding: '5px 8px', borderBottom: '1px solid #222' }}>
        <div style={{ fontSize: 10, color: '#666', marginBottom: 3 }}>보유종목</div>
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
      <div style={{ flex: 1, overflow: 'auto', padding: '5px 8px' }}>
        <div style={{ fontSize: 10, color: '#666', marginBottom: 3 }}>시그널 로그</div>
        {signals.slice(0, 100).map((s, i) => (
          <div key={i} style={{ fontSize: 9, color: '#aaa', lineHeight: 1.5 }}>
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
  const [layoutIdx, setLayoutIdx] = useState(2)          // 기본 3×2
  const [panels, setPanels] = useState(makePanels(DEFAULT_CODES))
  const [focusedIdx, setFocusedIdx] = useState(0)
  const ws = useRef(null)

  const layout = LAYOUTS[layoutIdx]
  const visibleCount = layout.cols * layout.rows

  // WebSocket 연결
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
          if (msg.data.candle_history) window.__CANDLE_HISTORY = msg.data.candle_history
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
      next[index] = {
        code: newCode,
        title: newCode === 'KOSPI' ? 'KOSPI 지수' : (STOCK_NAMES[newCode] || newCode),
      }
      return next
    })
  }, [])

  if (!state) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', color: '#555', fontSize: 14, background: '#0a0a0a',
      }}>
        {connected ? '데이터 수신 중...' : '🔴 서버 연결 중... (war_engine.py 또는 demo_server.py 실행 확인)'}
      </div>
    )
  }

  const prices = state.prices || {}
  const whipsawStatus = state.whipsaw_status || {}
  const visiblePanels = panels.slice(0, visibleCount)

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
        display: 'flex', gap: 6, padding: '2px 10px', background: '#111',
        borderBottom: '1px solid #222', alignItems: 'center', flexShrink: 0,
      }}>
        {/* 레이아웃 선택 버튼 */}
        {LAYOUTS.map((l, i) => (
          <button key={l.id} onClick={() => { setLayoutIdx(i); setFocusedIdx(0) }}
            style={{
              fontSize: 10, padding: '1px 7px', cursor: 'pointer', borderRadius: 2,
              background: i === layoutIdx ? '#003366' : '#111',
              color: i === layoutIdx ? '#66aaff' : '#666',
              border: `1px solid ${i === layoutIdx ? '#336699' : '#333'}`,
              fontWeight: i === layoutIdx ? 'bold' : 'normal',
            }}>{l.id}</button>
        ))}
        <div style={{ width: 1, height: 14, background: '#333', margin: '0 2px' }} />
        <button onClick={() => send({ cmd: 'toggle_auto', enabled: !state.auto_trading })}
          style={{
            fontSize: 10, padding: '1px 7px', cursor: 'pointer', borderRadius: 2,
            background: state.auto_trading ? '#030' : '#300',
            color: state.auto_trading ? '#0f0' : '#f66',
            border: '1px solid #444',
          }}>
          {state.auto_trading ? '자동ON→OFF' : '자동OFF→ON'}
        </button>
        <button onClick={() => send({ cmd: 'cancel_all' })}
          style={{
            fontSize: 10, padding: '1px 7px', cursor: 'pointer', borderRadius: 2,
            background: '#210', color: '#fa4', border: '1px solid #432',
          }}>전체취소</button>
        <span style={{ fontSize: 9, color: '#444', marginLeft: 4 }}>
          차트 클릭 → 포커스 → 우측에서 종목 변경
        </span>
      </div>

      {/* 메인 영역 */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {/* ★ 차트 그리드 — CSS grid로 정확한 cols×rows 분할 */}
        <div style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: `repeat(${layout.cols}, 1fr)`,
          gridTemplateRows: `repeat(${layout.rows}, 1fr)`,
          gap: 2,
          padding: 2,
          overflow: 'hidden',
          minHeight: 0,
        }}>
          {visiblePanels.map((panel, idx) => {
            const code = panel.code
            const price = code === 'KOSPI' ? (state.kospi || 0) : (prices[code] || 0)
            const prev = PREV_CLOSE[code] || 0
            const whipsaw = whipsawStatus[code]

            return (
              <RealtimeChart
                key={`${code}-${idx}`}
                code={code}
                title={panel.title}
                price={price}
                prevPrice={prev}
                whipsaw={whipsaw}
                focused={idx === focusedIdx}
                onFocus={() => setFocusedIdx(idx)}
                onBuy={() => handleBuy(code, price)}
                onSell={() => handleSell(code)}
              />
            )
          })}
        </div>

        {/* 우측 사이드 패널 */}
        <SidePanel
          state={state}
          panels={visiblePanels}
          focusedIdx={focusedIdx}
          onChangeFocused={setFocusedIdx}
          onChangePanel={handleChangePanel}
        />
      </div>
    </div>
  )
}
