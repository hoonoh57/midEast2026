import { useState, useEffect, useRef, useCallback } from 'react'
import { createChart, createSeriesMarkers, ColorType, CandlestickSeries, HistogramSeries, LineSeries } from 'lightweight-charts'

// ═══════════════════════════════════════════════════════════════
// 상수
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
const LAYOUTS = [
  { id: '1×1', cols: 1, rows: 1 },
  { id: '2×2', cols: 2, rows: 2 },
  { id: '3×2', cols: 3, rows: 2 },
  { id: '3×3', cols: 3, rows: 3 },
]
const DEFAULT_CODES = ['KOSPI','005930','000660','012450','079550','010950','096770','272210','064350']
const DEFAULT_THEME_ITEMS = DEFAULT_CODES.map(code => ({
  code,
  enabled: true,
  description: '',
  trade_focus: '',
  risk_note: '',
}))
const DEFAULT_THEMES = [{ name: 'IranWar', codes: DEFAULT_CODES, items: DEFAULT_THEME_ITEMS }]
const TIMEFRAMES = ['m1','m3','m5','m10','m15','m60','D']
const TF_LABELS = { m1:'1분', m3:'3분', m5:'5분', m10:'10분', m15:'15분', m60:'1시간', D:'일봉' }
const INDICATOR_COLORS = {
  supertrendUp: '#22c55e',
  supertrendDown: '#ff4d6d',
  jmaUp: '#00d4ff',
  jmaDown: '#ff9f1c',
}

function makePanels(codes) {
  return codes.map(code => ({ code, title: code === 'KOSPI' ? 'KOSPI 지수' : (STOCK_NAMES[code] || code) }))
}
function normalizeThemes(themes) {
  const items = Array.isArray(themes) ? themes : []
  const normalized = items
    .map(theme => {
      const rawItems = Array.isArray(theme?.items) && theme.items.length
        ? theme.items
        : (theme?.codes || []).map(code => ({ code }))
      const seen = new Set()
      const mappedItems = rawItems
        .map(item => ({
          code: String(item?.code || '').trim(),
          enabled: item?.enabled !== false,
          description: String(item?.description || '').trim(),
          trade_focus: String(item?.trade_focus || '').trim(),
          risk_note: String(item?.risk_note || '').trim(),
        }))
        .filter(item => {
          if (!item.code || seen.has(item.code)) return false
          seen.add(item.code)
          return true
        })
      return {
        name: String(theme?.name || '').trim(),
        codes: mappedItems.map(item => item.code),
        items: mappedItems,
      }
    })
    .filter(theme => theme.name && theme.items.length > 0)
  return normalized.length ? normalized : DEFAULT_THEMES
}
function calcQty(code, price, budget = 5000000) {
  if (!price || price <= 0) return 1
  return Math.max(1, Math.floor(budget / price))
}
function kstTimeFormatter(time) {
  const d = new Date((time + 9 * 3600) * 1000)
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`
}
function playBeep(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const osc = ctx.createOscillator(); const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination); gain.gain.value = 0.08
    osc.frequency.value = type === 'buy' ? 880 : type === 'sell' ? 440 : 660
    osc.start(); osc.stop(ctx.currentTime + 0.15)
  } catch(e) {}
}

// ═══════════════════════════════════════════════════════════════
// 기술적 지표 계산
// ═══════════════════════════════════════════════════════════════

function calcATR(candles, period) {
  const tr = []
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { tr.push(candles[i].high - candles[i].low); continue }
    const prev = candles[i-1].close
    tr.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - prev), Math.abs(candles[i].low - prev)))
  }
  const atr = new Array(candles.length).fill(null)
  let sum = 0
  for (let i = 0; i < tr.length; i++) {
    sum += tr[i]
    if (i >= period - 1) {
      if (i === period - 1) { atr[i] = sum / period }
      else { atr[i] = (atr[i-1] * (period - 1) + tr[i]) / period }
    }
  }
  return atr
}

function calcSuperTrend(candles, period = 10, multiplier = 3) {
  if (candles.length < period) return { data: [], state: null }
  const atr = calcATR(candles, period)
  const result = []
  let upperBand = 0, lowerBand = 0, supertrend = 0, isUptrend = true

  for (let i = period - 1; i < candles.length; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2
    const basicUpper = hl2 + multiplier * atr[i]
    const basicLower = hl2 - multiplier * atr[i]

    if (i === period - 1) {
      upperBand = basicUpper; lowerBand = basicLower
      isUptrend = candles[i].close > hl2
    } else {
      upperBand = basicUpper < upperBand || candles[i-1].close > upperBand ? basicUpper : upperBand
      lowerBand = basicLower > lowerBand || candles[i-1].close < lowerBand ? basicLower : lowerBand
      const wasUp = isUptrend
      isUptrend = wasUp ? candles[i].close >= lowerBand : candles[i].close > upperBand
    }
    supertrend = isUptrend ? lowerBand : upperBand
    result.push({ time: candles[i].time, value: supertrend, isUptrend })
  }

  return {
    data: result,
    state: { upperBand, lowerBand, isUptrend, supertrend,
             lastAtr: atr[atr.length - 1], prevClose: candles[candles.length - 1].close }
  }
}

function segmentByTrend(data) {
  const segments = []
  let seg = [], curUp = null
  for (const pt of data) {
    if (curUp !== null && curUp !== pt.isUptrend) {
      segments.push({ points: seg, isUptrend: curUp })
      seg = [{ time: pt.time, value: pt.value }]
      curUp = pt.isUptrend
    } else {
      seg.push({ time: pt.time, value: pt.value })
      curUp = pt.isUptrend
    }
  }
  if (seg.length) segments.push({ points: seg, isUptrend: curUp })
  return segments
}

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return []
  const result = []
  let avgGain = 0, avgLoss = 0

  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close
    avgGain += change > 0 ? change : 0
    avgLoss += change < 0 ? -change : 0
  }
  avgGain /= period; avgLoss /= period
  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss
  result.push({ time: candles[period].time, value: Math.round(100 - 100 / (1 + rs0)) })

  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss
    result.push({ time: candles[i].time, value: Math.round(100 - 100 / (1 + rs)) })
  }
  return result
}

function calcJMA(candles, period = 7, phase = 50, power = 2) {
  if (candles.length <= period) return { data: [], state: null }

  const phaseRatio = phase < -100 ? 0.5 : phase > 100 ? 2.5 : phase / 100 + 1.5
  const beta = 0.45 * (period - 1) / (0.45 * (period - 1) + 2)
  const alpha = Math.pow(beta, power)

  // SMA로 초기화 — warmup 누적 없이 깨끗하게 시작
  let sumInit = 0
  for (let i = 0; i < period; i++) sumInit += candles[i].close
  let prevJMA = sumInit / period
  let e0 = prevJMA, e1 = 0, e2 = 0

  const result = []

  for (let i = period; i < candles.length; i++) {
    const src = candles[i].close
    e0 = (1 - alpha) * src + alpha * e0
    e1 = (src - e0) * (1 - beta) + beta * e1
    e2 = (e0 + phaseRatio * e1 - prevJMA) * Math.pow(1 - alpha, 2) + Math.pow(alpha, 2) * e2
    const jma = Math.round((e2 + prevJMA) * 10) / 10
    const isUptrend = jma > prevJMA ? true : jma < prevJMA ? false
      : (result.length > 0 ? result[result.length - 1].isUptrend : true)
    result.push({ time: candles[i].time, value: jma, isUptrend })
    prevJMA = jma
  }

  return {
    data: result,
    state: { e0, e1, e2, prevJMA, lastIsUptrend: result[result.length - 1]?.isUptrend ?? true }
  }
}

// ═══════════════════════════════════════════════════════════════
// 실시간 캔들 차트 + SuperTrend + JMA + RSI
// ═══════════════════════════════════════════════════════════════

function RealtimeChart({ code, title, price, prevPrice, whipsaw, buyLevels, positionOverlay, signalMarkers, codeStatus, focused, onFocus, onBuy, onSell, tf, indicators, onToggleIndicator, candleData, chartKey, onChartReady, onChartDestroy }) {
  const containerRef = useRef(null)
  const candleSeriesRef = useRef(null)
  const volumeSeriesRef = useRef(null)
  const stSeriesListRef = useRef([])   // [{series, isUptrend}]
  const stStateRef = useRef(null)      // {upperBand, lowerBand, isUptrend, supertrend, lastAtr, prevClose}
  const jmaSeriesListRef = useRef([])  // [{series, isUptrend}]
  const jmaStateRef = useRef(null)     // {e0, e1, e2, prevJMA, lastIsUptrend}
  const rsiSeriesRef = useRef(null)
  const lastBarRef = useRef(null)
  const chartRef = useRef(null)
  const candlesRef = useRef([])        // 현재 캔들 데이터 (RSI 실시간 계산용)
  const indicatorsRef = useRef(indicators) // 최신 indicators 참조 (stale closure 방지)
  const redrawIndicatorsRef = useRef(null)
  const [rsiValue, setRsiValue] = useState(null)
  const [stTrend, setStTrend] = useState(null) // 1=bull, -1=bear

  useEffect(() => {
    if (!containerRef.current) return
    if (tf !== 'm1' && candleData == null) return  // fetch 완료 전 빈 차트 방지

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#0a0a0a' }, textColor: '#888', fontSize: 10,
        panes: { separatorColor: '#222', enableResize: true },
      },
      grid: { vertLines: { color: '#1a1a2e' }, horzLines: { color: '#1a1a2e' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#333', tickMarkFormatter: kstTimeFormatter, rightOffset: 5 },
      localization: { timeFormatter: kstTimeFormatter },
      rightPriceScale: { borderColor: '#333', scaleMargins: { top: 0.05, bottom: 0.25 } },
      crosshair: { mode: 0, vertLine: { color: '#555', style: 2 }, horzLine: { color: '#555', style: 2 } },
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#ef5350', downColor: '#2962ff',
      borderUpColor: '#ef5350', borderDownColor: '#2962ff',
      wickUpColor: '#ef5350', wickDownColor: '#2962ff',
      priceFormat: {
        type: 'custom',
        minMove: 1,
        formatter: (price) => Math.round(Number(price || 0)).toLocaleString('ko-KR'),
      },
    })
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' }, priceScaleId: 'volume',
    })
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })

    if (prevPrice > 0) {
      candleSeries.createPriceLine({ price: prevPrice, color: '#ffffff44', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '전일' })
    }
    if (buyLevels) {
      if (buyLevels.L1) candleSeries.createPriceLine({ price: buyLevels.L1, color: '#00cc66aa', lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: 'L1' })
      if (buyLevels.L2) candleSeries.createPriceLine({ price: buyLevels.L2, color: '#00aaffaa', lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: 'L2' })
      if (buyLevels.L3) candleSeries.createPriceLine({ price: buyLevels.L3, color: '#aa88ffaa', lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: 'L3' })
      if (buyLevels.L4) candleSeries.createPriceLine({ price: buyLevels.L4, color: '#cc66ffaa', lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: 'L4' })
      if (buyLevels.L5) candleSeries.createPriceLine({ price: buyLevels.L5, color: '#ffaa00aa', lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: 'L5' })
      if (buyLevels.stop) candleSeries.createPriceLine({ price: buyLevels.stop, color: '#ff0000aa', lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: '손절' })
    }
    if (positionOverlay?.avg_price) {
      candleSeries.createPriceLine({ price: positionOverlay.avg_price, color: '#ffffff99', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '매수가' })
    }
    if (positionOverlay?.target) {
      candleSeries.createPriceLine({ price: positionOverlay.target, color: '#00cc6688', lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: '목표' })
    }
    if (positionOverlay?.atr_target) {
      candleSeries.createPriceLine({ price: positionOverlay.atr_target, color: '#00ffaa88', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'ATR목표' })
    }
    if (positionOverlay?.stop) {
      candleSeries.createPriceLine({ price: positionOverlay.stop, color: '#ff444488', lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: '손절' })
    }
    if (positionOverlay?.atr_stop) {
      candleSeries.createPriceLine({ price: positionOverlay.atr_stop, color: '#ffcc0088', lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: 'ATR손절' })
    }
    if (signalMarkers?.length) {
      createSeriesMarkers(candleSeries, signalMarkers)
    }

    chartRef.current = chart
    candleSeriesRef.current = candleSeries
    volumeSeriesRef.current = volumeSeries
    stSeriesListRef.current = []
    stStateRef.current = null
    jmaSeriesListRef.current = []
    jmaStateRef.current = null

    let rsiSeries = null
    if (indicators.rsi.enabled) {
      rsiSeries = chart.addSeries(LineSeries, {
        color: '#e0aa00', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
      }, 1)
      rsiSeries.createPriceLine({ price: 70, color: '#ff444466', lineWidth: 1, lineStyle: 2, axisLabelVisible: false })
      rsiSeries.createPriceLine({ price: 30, color: '#00cc6666', lineWidth: 1, lineStyle: 2, axisLabelVisible: false })
      rsiSeries.createPriceLine({ price: 50, color: '#ffffff22', lineWidth: 1, lineStyle: 2, axisLabelVisible: false })
      try {
        const totalPaneHeight = Math.max(containerRef.current?.clientHeight || 260, 180)
        const mainPaneHeight = Math.round(totalPaneHeight * 0.7)
        const subPaneHeight = Math.max(60, totalPaneHeight - mainPaneHeight)
        chart.panes()[0]?.setHeight(mainPaneHeight)
        chart.panes()[1]?.setHeight(subPaneHeight)
      } catch(_) {}
    }
    rsiSeriesRef.current = rsiSeries

    const redrawIndicators = (candles) => {
      stSeriesListRef.current.forEach(({ series }) => chart.removeSeries(series))
      jmaSeriesListRef.current.forEach(({ series }) => chart.removeSeries(series))
      stSeriesListRef.current = []
      jmaSeriesListRef.current = []
      stStateRef.current = null
      jmaStateRef.current = null

      if (indicators.supertrend.enabled && candles.length >= indicators.supertrend.period) {
        const { data: stData, state: stState } = calcSuperTrend(
          candles, indicators.supertrend.period, indicators.supertrend.multiplier
        )
        stStateRef.current = stState
        const segments = segmentByTrend(stData)
        stSeriesListRef.current = segments.map(seg => {
          const s = chart.addSeries(LineSeries, {
            color: seg.isUptrend ? INDICATOR_COLORS.supertrendUp : INDICATOR_COLORS.supertrendDown,
            lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
          })
          s.setData(seg.points)
          return { series: s, isUptrend: seg.isUptrend }
        })
        if (stData.length > 0) setStTrend(stData[stData.length - 1].isUptrend ? 1 : -1)
      } else {
        setStTrend(null)
      }

      if (indicators.jma.enabled && candles.length >= indicators.jma.period) {
        const { data: jmaData, state: jmaState } = calcJMA(
          candles, indicators.jma.period, indicators.jma.phase, indicators.jma.power
        )
        jmaStateRef.current = jmaState
        jmaSeriesListRef.current = segmentByTrend(jmaData).map(seg => {
          const s = chart.addSeries(LineSeries, {
            color: seg.isUptrend ? INDICATOR_COLORS.jmaUp : INDICATOR_COLORS.jmaDown,
            lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
          })
          s.setData(seg.points)
          return { series: s, isUptrend: seg.isUptrend }
        })
      }

      if (rsiSeries && indicators.rsi.enabled) {
        const rsi = calcRSI(candles, indicators.rsi.period)
        rsiSeries.setData(rsi)
        const lastRsi = rsi[rsi.length - 1]
        setRsiValue(lastRsi ? lastRsi.value : null)
      } else {
        setRsiValue(null)
      }
    }

    redrawIndicatorsRef.current = redrawIndicators

    const applyCandles = (candles) => {
      candlesRef.current = [...candles]
      if (candles.length === 0) return

      candleSeries.setData(candles)
      const avgVol = candles.reduce((s, c) => s + (c.volume || 0), 0) / (candles.length || 1)
      volumeSeries.setData(candles.map(c => ({
        time: c.time, value: c.volume || 0,
        color: (c.volume || 0) > avgVol * 2 ? '#ffcc0099'
             : c.close >= c.open ? '#ef535066' : '#2962ff66',
      })))
      lastBarRef.current = { ...candles[candles.length - 1] }
      redrawIndicators(candles)
    }

    // 중앙 candle_store/state만 사용한다. 차트별 개별 fetch는 금지.
    const candles = Array.isArray(candleData) ? candleData : []
    applyCandles(candles)

    if (onChartReady && chartKey) onChartReady(chartKey, chart, candleSeries)

    return () => {
      redrawIndicatorsRef.current = null
      if (onChartDestroy && chartKey) onChartDestroy(chartKey)
      chart.remove()
    }
  }, [code, prevPrice, JSON.stringify(buyLevels), JSON.stringify(positionOverlay), JSON.stringify(signalMarkers), tf, JSON.stringify(indicators), candleData])

  // indicatorsRef 최신 유지
  useEffect(() => { indicatorsRef.current = indicators }, [indicators])

  // 실시간 틱 → 1분봉 누적 + RSI 실시간 업데이트
  useEffect(() => {
    if (tf !== 'm1') return
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
      volumeSeriesRef.current.update({ time: barTime, value: lastBar.volume, color: price >= lastBar.open ? '#ef535066' : '#2962ff66' })
      // 현재 봉 갱신
      const cr = candlesRef.current
      if (cr.length > 0) cr[cr.length - 1] = { ...lastBar }
    } else {
      const newBar = { time: barTime, open: price, high: price, low: price, close: price, volume: 1 }
      lastBarRef.current = newBar
      candleSeriesRef.current.update(newBar)
      volumeSeriesRef.current.update({ time: barTime, value: 1, color: '#888' })
      // 새 봉 추가
      candlesRef.current = [...candlesRef.current, newBar]
    }

    if (redrawIndicatorsRef.current) {
      redrawIndicatorsRef.current(candlesRef.current)
    }
  }, [price, tf])

  const chg = prevPrice > 0 ? ((price - prevPrice) / prevPrice * 100) : 0
  const chgColor = chg >= 0 ? '#ef5350' : '#2962ff'
  const flagColor = { emergency:'#ff0000', crash:'#ff4444', near_limit:'#ffaa00', normal:'#00cc66' }[whipsaw?.flag] || '#333'
  const borderColor = focused ? '#ffcc00' : flagColor
  const isBuyDisabled = whipsaw?.flag === 'near_limit' || whipsaw?.flag === 'emergency'
  const statusPalette = {
    ready: { fg:'#86efac', bg:'#052e16', border:'#166534', label:'READY' },
    loading: { fg:'#fde68a', bg:'#3a2a05', border:'#a16207', label:'LOAD' },
    stale: { fg:'#fca5a5', bg:'#3f0d0d', border:'#b91c1c', label:'STALE' },
    error: { fg:'#fecaca', bg:'#450a0a', border:'#dc2626', label:'ERROR' },
    closed: { fg:'#cbd5e1', bg:'#0f172a', border:'#475569', label:'CLOSED' },
  }
  const statusStyle = statusPalette[codeStatus?.status] || { fg:'#94a3b8', bg:'#111827', border:'#334155', label:'UNK' }
  const handleToggle = (key, checked) => {
    if (onToggleIndicator) onToggleIndicator(key, checked)
  }

  return (
    <div onClick={onFocus} style={{
      display: 'flex', flexDirection: 'column',
      border: `${focused ? 3 : 1}px solid ${borderColor}`,
      borderRadius: 2, background: '#0a0a0a', overflow: 'hidden', height: '100%', cursor: 'pointer',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '2px 6px', background: focused ? '#332200' : '#111',
        borderBottom: `2px solid ${borderColor}`, height: 30, flexShrink: 0,
      }}>
        <span style={{ fontWeight: 'bold', fontSize: 11, color: focused ? '#ffcc00' : '#eee', minWidth: 55 }}>{title}</span>
        <span style={{ fontSize: 11, fontWeight: 'bold', color: chgColor }}>{price?.toLocaleString()}</span>
        <span style={{ fontSize: 9, color: chgColor }}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}%</span>
        <span title={codeStatus?.reason || ''} style={{ fontSize: 8, fontWeight: 'bold', padding: '1px 4px', borderRadius: 4, color: statusStyle.fg, background: statusStyle.bg, border: `1px solid ${statusStyle.border}` }}>{statusStyle.label}</span>
        {whipsaw?.drawdown_pct ? <span style={{ fontSize: 8, color: '#ff8888' }}>↓{whipsaw.drawdown_pct}%</span> : null}
        {indicators.supertrend.enabled && stTrend !== null && (
          <span style={{ fontSize: 10, color: stTrend === 1 ? '#00cc66' : '#ff8800' }}>{stTrend === 1 ? '▲' : '▼'}</span>
        )}
        {indicators.rsi.enabled && rsiValue !== null && (
          <span style={{ fontSize: 8, color: rsiValue >= 70 ? '#ff4444' : rsiValue <= 30 ? '#00cc66' : '#e0aa00' }}>RSI {rsiValue}</span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems:'center' }} onClick={e => e.stopPropagation()}>
          <label style={{ display:'flex', alignItems:'center', gap:2, fontSize:8, color: indicators.supertrend.enabled ? '#ccc' : '#555', cursor:'pointer' }}>
            <input type="checkbox" checked={indicators.supertrend.enabled} onChange={e => handleToggle('supertrend', e.target.checked)} />
            <span>ST</span>
          </label>
          <label style={{ display:'flex', alignItems:'center', gap:2, fontSize:8, color: indicators.jma.enabled ? '#ccc' : '#555', cursor:'pointer' }}>
            <input type="checkbox" checked={indicators.jma.enabled} onChange={e => handleToggle('jma', e.target.checked)} />
            <span>JMA</span>
          </label>
          <label style={{ display:'flex', alignItems:'center', gap:2, fontSize:8, color: indicators.rsi.enabled ? '#ccc' : '#555', cursor:'pointer' }}>
            <input type="checkbox" checked={indicators.rsi.enabled} onChange={e => handleToggle('rsi', e.target.checked)} />
            <span>RSI</span>
          </label>
          <div style={{ display: 'flex', gap: 3 }}>
          <button onClick={onBuy} disabled={isBuyDisabled} style={{
            background: '#003300', color: '#0f0', border: '1px solid #060',
            padding: '1px 5px', fontSize: 9, cursor: 'pointer', borderRadius: 2, opacity: isBuyDisabled ? 0.3 : 1,
          }}>매수</button>
          <button onClick={onSell} style={{
            background: '#330000', color: '#f44', border: '1px solid #600',
            padding: '1px 5px', fontSize: 9, cursor: 'pointer', borderRadius: 2,
          }}>매도</button>
          </div>
        </div>
      </div>
      <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// PnL 스파크라인
// ═══════════════════════════════════════════════════════════════

function PnlSparkline({ history }) {
  const ref = useRef(null)
  const chartRef = useRef(null)
  useEffect(() => {
    if (!ref.current) return
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: 'transparent' },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      timeScale: { visible: false }, rightPriceScale: { visible: false }, leftPriceScale: { visible: false },
      crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
      handleScroll: false, handleScale: false,
    })
    const series = chart.addSeries(LineSeries, { color: '#00cc66', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
    chartRef.current = { chart, series }
    return () => chart.remove()
  }, [])
  useEffect(() => {
    if (!chartRef.current || !history?.length) return
    chartRef.current.series.setData(history.map(h => ({ time: h.time, value: h.value })))
    chartRef.current.series.applyOptions({ color: (history[history.length-1]?.value ?? 0) >= 0 ? '#00cc66' : '#ff4444' })
  }, [history])
  return <div ref={ref} style={{ width: 100, height: 22, display: 'inline-block', verticalAlign: 'middle' }} />
}

// ═══════════════════════════════════════════════════════════════
// 매크로 바
// ═══════════════════════════════════════════════════════════════

function MacroBar({ state }) {
  if (!state) return null
  const { regime, beta, war_day, wti, usdkrw, daily_pnl, auto_trading, news_sentiment, pnl_history, account_no, orderable_cash, data_health, data_readiness } = state
  const pnlColor = daily_pnl >= 0 ? '#00cc66' : '#ff4444'
  const rc = { EXTREME_CRISIS:'#ff0000', CRISIS:'#ff2222', CAUTIOUS:'#ffaa00', RECOVERY:'#00cc66', AGGRESSIVE:'#00ff44' }
  const acctSuffix = account_no ? String(account_no).slice(-4) : '----'
  const healthColor = data_health?.status === 'critical'
    ? '#fda4af'
    : data_health?.status === 'warning'
      ? '#facc15'
      : data_health?.status === 'closed'
        ? '#cbd5e1'
        : '#86efac'
  const readinessColor = data_readiness?.ready ? '#86efac' : '#facc15'
  return (
    <div style={{ display:'flex', alignItems:'center', gap:14, padding:'3px 12px', background:'#0d0d1a', borderBottom:'1px solid #222', fontSize:11, flexWrap:'wrap', flexShrink:0 }}>
      <span style={{ color:'#7dd3fc', fontWeight:'bold', background:'#082f49', border:'1px solid #0ea5e9', padding:'1px 6px', borderRadius:999 }}>
        모의실전 ACC {acctSuffix} 주문가능 {Number(orderable_cash || 0).toLocaleString()}원
      </span>
      <span style={{ color: rc[regime] || '#888', fontWeight:'bold' }}>● {regime}</span>
      <span>β <b>{beta?.toFixed(2)}</b></span>
      <span>D+<b>{war_day}</b></span>
      <span>WTI <b>${wti?.toFixed(1)}</b></span>
      <span>환율 <b>{usdkrw?.toFixed(0)}₩</b></span>
      <span style={{ fontSize:10, color: news_sentiment?.startsWith('NEG') ? '#ff6666' : news_sentiment?.startsWith('POS') ? '#66ff99' : '#888' }}>뉴스:{news_sentiment}</span>
      <span style={{ color:healthColor, fontWeight:'bold' }}>DATA:{data_health?.status || 'unknown'} {data_health?.reason ? `(${data_health.reason})` : ''}</span>
      <span style={{ color:readinessColor, fontWeight:'bold' }}>CANDLES:{data_readiness?.status || 'unknown'} {data_readiness?.reason ? `(${data_readiness.reason})` : ''}</span>
      <span style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6 }}>
        <PnlSparkline history={pnl_history} />
        <span style={{ color: pnlColor, fontWeight:'bold', fontSize:14, background: daily_pnl >= 0 ? '#003310' : '#330008', padding:'1px 6px', borderRadius:3 }}>
          {daily_pnl >= 0 ? '+' : ''}{daily_pnl?.toLocaleString()}원
        </span>
      </span>
      <span style={{ color: auto_trading ? '#0c6' : '#f80', fontSize:10 }}>[{auto_trading ? '자동ON' : '자동OFF'}]</span>
    </div>
  )
}

function WhipsawBanner({ status, phase }) {
  const flags = { emergency:'🚨긴급', crash:'📉폭락', near_limit:'⚠️상한근접' }
  const items = Object.entries(status || {}).filter(([,v]) => v.flag !== 'normal')
  if (!items.length) return null
  return (
    <div style={{ display:'flex', gap:12, padding:'2px 12px', flexWrap:'wrap', flexShrink:0, background:'#1a0000', borderBottom:'1px solid #330000', fontSize:10 }}>
      <span style={{ color:'#ff8888' }}>요동장 [{phase}]</span>
      {items.map(([code,v]) => <span key={code} style={{ color:'#ffaaaa' }}>{v.name} {flags[v.flag]} {v.drawdown_pct}%{v.locked_until && ` (~${v.locked_until})`}</span>)}
    </div>
  )
}

function DataHealthBanner({ health, readiness }) {
  const showHealth = health && health.status !== 'ok' && health.status !== 'unknown'
  const showReadiness = readiness && readiness.ready === false
  if (!showHealth && !showReadiness) return null
  const bg = health?.status === 'critical' ? '#3f0a0a' : '#3a2a05'
  const border = health?.status === 'critical' ? '#7f1d1d' : '#a16207'
  const color = health?.status === 'critical' ? '#fecaca' : '#fde68a'
  return (
    <div style={{ display:'flex', gap:12, padding:'4px 12px', flexWrap:'wrap', flexShrink:0, background:bg, borderBottom:`1px solid ${border}`, fontSize:10 }}>
      <span style={{ color, fontWeight:'bold' }}>비상 데이터 경고</span>
      <span style={{ color }}>{health.reason}</span>
      {showReadiness ? <span style={{ color:'#fde68a' }}>캔들준비: {readiness.reason}</span> : null}
      {health.last_error ? <span style={{ color:'#fca5a5' }}>오류: {health.last_error}</span> : null}
      {health.last_tick_at ? <span style={{ color:'#ddd' }}>마지막 틱 {new Date(health.last_tick_at).toLocaleTimeString('ko-KR', { hour12:false })}</span> : null}
      {health.last_bar_at ? <span style={{ color:'#ddd' }}>마지막 신규봉 {new Date(health.last_bar_at).toLocaleTimeString('ko-KR', { hour12:false })}</span> : null}
      {health.stale_count ? <span style={{ color:'#fca5a5' }}>지연 종목 {health.stale_count}개</span> : null}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 긴급매도 확인 다이얼로그
// ═══════════════════════════════════════════════════════════════

function SellConfirmDialog({ code, name, onConfirm, onCancel }) {
  const [cd, setCd] = useState(2)
  useEffect(() => { if (cd > 0) { const t = setTimeout(() => setCd(cd-1), 1000); return () => clearTimeout(t) } }, [cd])
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999 }}>
      <div style={{ background:'#1a0000', border:'2px solid #ff0000', borderRadius:8, padding:'20px 30px', textAlign:'center', color:'#fff' }}>
        <div style={{ fontSize:16, fontWeight:'bold', color:'#ff4444', marginBottom:12 }}>⚠️ 긴급매도 확인</div>
        <div style={{ fontSize:13, marginBottom:16 }}><b>{name}</b> ({code}) 전량 시장가 매도</div>
        <div style={{ display:'flex', gap:12, justifyContent:'center' }}>
          <button onClick={onCancel} style={{ padding:'6px 20px', fontSize:12, cursor:'pointer', background:'#333', color:'#ccc', border:'1px solid #555', borderRadius:4 }}>취소</button>
          <button onClick={onConfirm} disabled={cd>0} style={{ padding:'6px 20px', fontSize:12, cursor:cd>0?'not-allowed':'pointer', background:cd>0?'#660000':'#cc0000', color:'#fff', border:'1px solid #ff0000', borderRadius:4, opacity:cd>0?0.6:1 }}>
            {cd > 0 ? `확인 (${cd}초)` : '매도 실행'}
          </button>
        </div>
      </div>
    </div>
  )
}

function BuyConfirmDialog({ order, onConfirm, onCancel }) {
  if (!order) return null
  const holdingText = order.holdingQty > 0
    ? `현재 보유 ${order.holdingQty.toLocaleString()}주 / 평균단가 ${order.holdingAvg.toLocaleString()}원`
    : '현재 보유 없음'
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999 }}>
      <div style={{ background:'#001018', border:'2px solid #0ea5e9', borderRadius:8, padding:'18px 24px', textAlign:'center', color:'#fff', minWidth:320 }}>
        <div style={{ fontSize:16, fontWeight:'bold', color:'#67e8f9', marginBottom:10 }}>수동 매수 확인</div>
        <div style={{ fontSize:13, marginBottom:8 }}><b>{order.name}</b> ({order.code})</div>
        <div style={{ fontSize:12, color:'#cbd5e1', lineHeight:1.8, marginBottom:14 }}>
          <div>주문가 {order.price.toLocaleString()}원</div>
          <div>수량 {order.qty.toLocaleString()}주</div>
          <div>예상 금액 {(order.price * order.qty).toLocaleString()}원</div>
          <div>{holdingText}</div>
        </div>
        <div style={{ display:'flex', gap:12, justifyContent:'center' }}>
          <button onClick={onCancel} style={{ padding:'6px 20px', fontSize:12, cursor:'pointer', background:'#333', color:'#ccc', border:'1px solid #555', borderRadius:4 }}>취소</button>
          <button onClick={onConfirm} style={{ padding:'6px 20px', fontSize:12, cursor:'pointer', background:'#082f49', color:'#7dd3fc', border:'1px solid #0ea5e9', borderRadius:4 }}>
            매수 실행
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 지표 설정 패널
// ═══════════════════════════════════════════════════════════════

function IndicatorSettings({ indicators, onChange }) {
  const [open, setOpen] = useState(false)
  const { supertrend, jma, rsi } = indicators

  const update = (key, field, val) => {
    onChange({ ...indicators, [key]: { ...indicators[key], [field]: val } })
  }

  return (
    <div style={{ padding:'4px 8px', borderBottom:'1px solid #222' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <span style={{ fontSize:10, color:'#888' }}>지표 설정</span>
        <button onClick={() => setOpen(!open)} style={{ fontSize:9, padding:'1px 6px', background:'#111', color:'#aaa', border:'1px solid #333', borderRadius:2, cursor:'pointer' }}>
          {open ? '접기' : '펼치기'}
        </button>
      </div>
      {open && (
        <div style={{ marginTop:4 }}>
          <div style={{ marginBottom:6 }}>
            <label style={{ fontSize:9, color:'#ccc', display:'flex', alignItems:'center', gap:4, cursor:'pointer' }}>
              <input type="checkbox" checked={supertrend.enabled} onChange={e => update('supertrend','enabled',e.target.checked)} />
              <span style={{ color: supertrend.enabled ? '#00cc66' : '#666' }}>SuperTrend</span>
            </label>
            {supertrend.enabled && (
              <div style={{ display:'flex', gap:6, marginTop:3, marginLeft:16 }}>
                <label style={{ fontSize:9, color:'#999' }}>
                  Period
                  <input type="number" value={supertrend.period} min={1} max={50}
                    onChange={e => update('supertrend','period',parseInt(e.target.value)||10)}
                    style={{ width:36, marginLeft:3, background:'#111', color:'#ccc', border:'1px solid #333', fontSize:9, textAlign:'center' }} />
                </label>
                <label style={{ fontSize:9, color:'#999' }}>
                  Multi
                  <input type="number" value={supertrend.multiplier} min={0.5} max={10} step={0.5}
                    onChange={e => update('supertrend','multiplier',parseFloat(e.target.value)||3)}
                    style={{ width:36, marginLeft:3, background:'#111', color:'#ccc', border:'1px solid #333', fontSize:9, textAlign:'center' }} />
                </label>
              </div>
            )}
          </div>
          <div style={{ marginBottom:6 }}>
            <label style={{ fontSize:9, color:'#ccc', display:'flex', alignItems:'center', gap:4, cursor:'pointer' }}>
              <input type="checkbox" checked={jma.enabled} onChange={e => update('jma','enabled',e.target.checked)} />
              <span style={{ color: jma.enabled ? '#00e5ff' : '#666' }}>JMA</span>
            </label>
            {jma.enabled && (
              <div style={{ display:'flex', gap:6, marginTop:3, marginLeft:16 }}>
                <label style={{ fontSize:9, color:'#999' }}>
                  Period
                  <input type="number" value={jma.period} min={1} max={50}
                    onChange={e => update('jma','period',parseInt(e.target.value)||7)}
                    style={{ width:36, marginLeft:3, background:'#111', color:'#ccc', border:'1px solid #333', fontSize:9, textAlign:'center' }} />
                </label>
                <label style={{ fontSize:9, color:'#999' }}>
                  Phase
                  <input type="number" value={jma.phase} min={-100} max={100}
                    onChange={e => update('jma','phase',parseInt(e.target.value)||50)}
                    style={{ width:36, marginLeft:3, background:'#111', color:'#ccc', border:'1px solid #333', fontSize:9, textAlign:'center' }} />
                </label>
                <label style={{ fontSize:9, color:'#999' }}>
                  Power
                  <input type="number" value={jma.power} min={1} max={10}
                    onChange={e => update('jma','power',parseInt(e.target.value)||2)}
                    style={{ width:36, marginLeft:3, background:'#111', color:'#ccc', border:'1px solid #333', fontSize:9, textAlign:'center' }} />
                </label>
              </div>
            )}
          </div>
          <div>
            <label style={{ fontSize:9, color:'#ccc', display:'flex', alignItems:'center', gap:4, cursor:'pointer' }}>
              <input type="checkbox" checked={rsi.enabled} onChange={e => update('rsi','enabled',e.target.checked)} />
              <span style={{ color: rsi.enabled ? '#e0aa00' : '#666' }}>RSI</span>
            </label>
            {rsi.enabled && (
              <div style={{ display:'flex', gap:6, marginTop:3, marginLeft:16 }}>
                <label style={{ fontSize:9, color:'#999' }}>
                  Period
                  <input type="number" value={rsi.period} min={2} max={50}
                    onChange={e => update('rsi','period',parseInt(e.target.value)||14)}
                    style={{ width:36, marginLeft:3, background:'#111', color:'#ccc', border:'1px solid #333', fontSize:9, textAlign:'center' }} />
                </label>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 우측 사이드 패널
// ═══════════════════════════════════════════════════════════════

const STRATEGIES = [
  { id: 'macro', label: 'Chart1: 매크로 국면', desc: 'Regime→beta' },
  { id: 'defense', label: 'Chart2: 방산 스캘핑', desc: 'VWAP+RSI+BB' },
  { id: 'energy', label: 'Chart3: 에너지 유가', desc: 'WTI+뉴스' },
  { id: 'semi', label: 'Chart4: 반도체 역발상', desc: '분할매수' },
]

const TRADE_PRESETS = {
  total: [1000000, 3000000, 5000000, 10000000],
  perStock: [100000, 300000, 500000, 1000000],
}

function formatBudget(v) {
  return `${Number(v || 0).toLocaleString()}원`
}

function formatBudgetCompact(v) {
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)}억`
  if (v >= 10000) return `${(v / 10000).toLocaleString()}만`
  return `${v.toLocaleString()}원`
}

function parseBudgetInput(value, fallback) {
  const digits = String(value ?? '').replace(/[^\d]/g, '')
  const parsed = parseInt(digits, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function AutoTradeConfigDialog({ config, autoOn, onClose, onToggleAuto, onApply }) {
  const [totalBudget, setTotalBudget] = useState(config?.total_budget ?? 5000000)
  const [perStock, setPerStock] = useState(config?.per_stock ?? 1000000)
  const [strategies, setStrategies] = useState(config?.strategies ?? { macro: true, defense: true, energy: true, semi: true })

  useEffect(() => {
    if (!config) return
    setTotalBudget(config.total_budget ?? 5000000)
    setPerStock(config.per_stock ?? 1000000)
    setStrategies({ macro: true, defense: true, energy: true, semi: true, ...(config.strategies || {}) })
  }, [config])

  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.72)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:10000 }}>
      <div onClick={e => e.stopPropagation()} style={{ width:420, maxWidth:'calc(100vw - 24px)', background:'#090c14', border:'1px solid #334155', boxShadow:'0 24px 80px rgba(0,0,0,0.45)', borderRadius:10, overflow:'hidden' }}>
        <div style={{ padding:'14px 16px', borderBottom:'1px solid #1e293b', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div>
            <div style={{ fontSize:14, color:'#e5e7eb', fontWeight:'bold' }}>자동매매 실전 설정</div>
            <div style={{ fontSize:11, color:'#94a3b8', marginTop:2 }}>소액 계좌도 바로 조정 가능한 입력형 설정</div>
          </div>
          <button onClick={onClose} style={{ background:'#111827', color:'#94a3b8', border:'1px solid #334155', borderRadius:6, padding:'4px 8px', cursor:'pointer' }}>닫기</button>
        </div>

        <div style={{ padding:'16px', display:'flex', flexDirection:'column', gap:14 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 12px', background:'#0f172a', border:'1px solid #1e293b', borderRadius:8 }}>
            <div>
              <div style={{ fontSize:11, color:'#94a3b8' }}>자동매매 상태</div>
              <div style={{ fontSize:13, color:autoOn ? '#22c55e' : '#f87171', fontWeight:'bold', marginTop:2 }}>{autoOn ? '실행 중' : '중지'}</div>
            </div>
            <button onClick={onToggleAuto} style={{ padding:'8px 12px', borderRadius:6, cursor:'pointer', fontSize:12, fontWeight:'bold', background:autoOn ? '#2a0b0b' : '#052e16', color:autoOn ? '#f87171' : '#4ade80', border:`1px solid ${autoOn ? '#7f1d1d' : '#166534'}` }}>
              {autoOn ? '자동매매 중지' : '자동매매 시작'}
            </button>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <label style={{ display:'block' }}>
              <div style={{ fontSize:11, color:'#94a3b8', marginBottom:5 }}>총 투자금</div>
              <input type="text" value={totalBudget.toLocaleString()} onChange={e => setTotalBudget(parseBudgetInput(e.target.value, totalBudget))} style={{ width:'100%', background:'#020617', color:'#e5e7eb', border:'1px solid #334155', borderRadius:6, padding:'8px 10px', fontSize:13 }} />
              <div style={{ fontSize:10, color:'#38bdf8', marginTop:4 }}>{formatBudget(totalBudget)} / {formatBudgetCompact(totalBudget)}</div>
            </label>
            <label style={{ display:'block' }}>
              <div style={{ fontSize:11, color:'#94a3b8', marginBottom:5 }}>종목당 최대 투자금</div>
              <input type="text" value={perStock.toLocaleString()} onChange={e => setPerStock(parseBudgetInput(e.target.value, perStock))} style={{ width:'100%', background:'#020617', color:'#e5e7eb', border:'1px solid #334155', borderRadius:6, padding:'8px 10px', fontSize:13 }} />
              <div style={{ fontSize:10, color:'#38bdf8', marginTop:4 }}>{formatBudget(perStock)} / {formatBudgetCompact(perStock)}</div>
            </label>
          </div>

          <div>
              <div style={{ fontSize:11, color:'#94a3b8', marginBottom:6 }}>빠른 총 투자금</div>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
              {TRADE_PRESETS.total.map(v => (
                <button key={v} onClick={() => setTotalBudget(v)} style={{ padding:'5px 8px', borderRadius:999, cursor:'pointer', background:totalBudget === v ? '#082f49' : '#111827', color:totalBudget === v ? '#7dd3fc' : '#94a3b8', border:`1px solid ${totalBudget === v ? '#0ea5e9' : '#334155'}`, fontSize:11 }}>
                  {formatBudgetCompact(v)}
                </button>
              ))}
            </div>
          </div>

          <div>
              <div style={{ fontSize:11, color:'#94a3b8', marginBottom:6 }}>빠른 종목당 투자금</div>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
              {TRADE_PRESETS.perStock.map(v => (
                <button key={v} onClick={() => setPerStock(v)} style={{ padding:'5px 8px', borderRadius:999, cursor:'pointer', background:perStock === v ? '#1e293b' : '#111827', color:perStock === v ? '#facc15' : '#94a3b8', border:`1px solid ${perStock === v ? '#ca8a04' : '#334155'}`, fontSize:11 }}>
                  {formatBudgetCompact(v)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div style={{ fontSize:11, color:'#94a3b8', marginBottom:6 }}>전략 사용 여부</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              {STRATEGIES.map(s => (
                <label key={s.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', cursor:'pointer', background:'#0f172a', border:'1px solid #1e293b', borderRadius:8, color:strategies[s.id] ? '#e5e7eb' : '#64748b' }}>
                  <input type="checkbox" checked={!!strategies[s.id]} onChange={e => setStrategies(prev => ({ ...prev, [s.id]: e.target.checked }))} />
                  <span style={{ fontSize:12 }}>{s.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div style={{ padding:'12px 16px', borderTop:'1px solid #1e293b', display:'flex', justifyContent:'space-between', alignItems:'center', gap:10 }}>
          <div style={{ fontSize:11, color:'#94a3b8' }}>적용값: 총 {formatBudget(totalBudget)} / 종목당 {formatBudget(perStock)}</div>
          <button onClick={() => onApply({ total_budget: totalBudget, per_stock: perStock, strategies })} style={{ padding:'9px 14px', borderRadius:6, cursor:'pointer', fontSize:12, fontWeight:'bold', background:'#082f49', color:'#7dd3fc', border:'1px solid #0ea5e9' }}>
            설정 저장
          </button>
        </div>
      </div>
    </div>
  )
}

function AutoTradeSettings({ state, onSend, onApplyConfig }) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const autoOn = state?.auto_trading ?? false
  const tradeConfig = state?.trade_config
  const blockedReason = state?.data_health?.status !== 'ok'
    ? state?.data_health?.reason
    : (state?.data_readiness?.ready === false ? state?.data_readiness?.reason : '')
  const toggleAuto = () => {
    if (!autoOn && blockedReason) return
    onSend({ cmd: 'toggle_auto', enabled: !autoOn })
  }
  const totalBudget = tradeConfig?.total_budget ?? 5000000
  const perStock = tradeConfig?.per_stock ?? 1000000
  const enabledStrategies = Object.entries(tradeConfig?.strategies || { macro: true, defense: true, energy: true, semi: true }).filter(([, enabled]) => enabled).length

  return (
    <>
      <div style={{ borderBottom:'1px solid #222', padding:'8px' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
          <span style={{ fontSize:10, color:'#f59e0b' }}>자동매매 설정</span>
          <span style={{ fontSize:9, color:autoOn ? '#22c55e' : blockedReason ? '#facc15' : '#f87171' }}>{autoOn ? 'ON' : (blockedReason ? 'BLOCKED' : 'OFF')}</span>
        </div>
        <div style={{ fontSize:9, color:'#94a3b8', lineHeight:1.6 }}>
          <div>총 투자금 {formatBudget(totalBudget)}</div>
          <div>종목당 {formatBudget(perStock)}</div>
          <div>사용 전략 {enabledStrategies}개</div>
        </div>
        <button onClick={() => setDialogOpen(true)} style={{ width:'100%', marginTop:8, padding:'6px 0', cursor:'pointer', borderRadius:4, fontSize:10, background:'#111827', color:'#cbd5e1', border:'1px solid #334155' }}>
          실전 설정 열기
        </button>
      </div>
      {dialogOpen && (
        <AutoTradeConfigDialog
          config={tradeConfig}
          autoOn={autoOn}
          onClose={() => setDialogOpen(false)}
          onToggleAuto={toggleAuto}
          onApply={(payload) => {
            if (onApplyConfig) onApplyConfig(payload)
            else onSend({ cmd:'set_config', ...payload })
            setDialogOpen(false)
          }}
        />
      )}
    </>
  )
}

function AutoTradeQuickToggle({ autoOn, onToggle }) {
  return (
    <button
      onClick={onToggle}
      style={{
        marginLeft: 10,
        padding: '4px 10px',
        borderRadius: 999,
        cursor: 'pointer',
        fontSize: 11,
        fontWeight: 'bold',
        background: autoOn ? '#2a0b0b' : '#052e16',
        color: autoOn ? '#fda4af' : '#86efac',
        border: `1px solid ${autoOn ? '#be123c' : '#15803d'}`,
        boxShadow: autoOn ? '0 0 12px rgba(190,24,93,0.25)' : '0 0 12px rgba(21,128,61,0.25)',
      }}
      title="자동매매 즉시 ON/OFF"
    >
      {autoOn ? '자동매매 중지' : '자동매매 시작'}
    </button>
  )
}

function AutoTradeGateButton({ autoOn, onToggle, blockedReason }) {
  const blocked = Boolean(blockedReason)
  return (
    <button
      onClick={onToggle}
      disabled={blocked && !autoOn}
      style={{
        marginLeft: 10,
        padding: '4px 10px',
        borderRadius: 999,
        cursor: blocked && !autoOn ? 'not-allowed' : 'pointer',
        fontSize: 11,
        fontWeight: 'bold',
        background: blocked && !autoOn ? '#3a2a05' : (autoOn ? '#2a0b0b' : '#052e16'),
        color: blocked && !autoOn ? '#fde68a' : (autoOn ? '#fda4af' : '#86efac'),
        border: `1px solid ${blocked && !autoOn ? '#a16207' : (autoOn ? '#be123c' : '#15803d')}`,
        boxShadow: blocked && !autoOn ? 'none' : (autoOn ? '0 0 12px rgba(190,24,93,0.25)' : '0 0 12px rgba(21,128,61,0.25)'),
        opacity: blocked && !autoOn ? 0.75 : 1,
      }}
      title={blocked && !autoOn ? blockedReason : '자동매매 즉시 ON/OFF'}
    >
      {autoOn ? '자동매매 중지' : (blocked ? '자동매매 차단' : '자동매매 시작')}
    </button>
  )
}

function ThemeManagerDialog({ themes, onClose, onSave, onDelete }) {
  const [selectedName, setSelectedName] = useState(themes[0]?.name || 'IranWar')
  const selectedTheme = themes.find(theme => theme.name === selectedName) || themes[0] || DEFAULT_THEMES[0]
  const [draftName, setDraftName] = useState(selectedTheme?.name || 'IranWar')
  const [draftItems, setDraftItems] = useState(selectedTheme?.items || DEFAULT_THEME_ITEMS)
  const [focusedCode, setFocusedCode] = useState((selectedTheme?.items || DEFAULT_THEME_ITEMS)[0]?.code || 'KOSPI')

  useEffect(() => {
    const next = themes.find(theme => theme.name === selectedName) || themes[0] || DEFAULT_THEMES[0]
    setDraftName(next?.name || '')
    setDraftItems(next?.items || DEFAULT_THEME_ITEMS)
    setFocusedCode((next?.items || DEFAULT_THEME_ITEMS)[0]?.code || 'KOSPI')
  }, [selectedName, themes])

  const updateItem = (code, patch) => {
    setDraftItems(prev => prev.map(item => item.code === code ? { ...item, ...patch } : item))
  }

  const addItem = () => {
    const nextCode = ['KOSPI', ...Object.keys(STOCK_NAMES)].find(code => !draftItems.some(item => item.code === code))
    if (!nextCode) return
    setDraftItems(prev => [...prev, { code: nextCode, enabled: true, description: '', trade_focus: '', risk_note: '' }])
    setFocusedCode(nextCode)
  }

  const removeItem = (code) => {
    const nextItems = draftItems.filter(item => item.code !== code)
    if (nextItems.length === 0) return
    setDraftItems(nextItems)
    if (focusedCode === code) setFocusedCode(nextItems[0].code)
  }

  const changeCode = (oldCode, newCode) => {
    if (draftItems.some(item => item.code === newCode && item.code !== oldCode)) return
    setDraftItems(prev => prev.map(item => item.code === oldCode ? { ...item, code: newCode } : item))
    if (focusedCode === oldCode) setFocusedCode(newCode)
  }

  const handleNew = () => {
    setSelectedName('__new__')
    setDraftName('')
    setDraftItems([{ code: 'KOSPI', enabled: true, description: '', trade_focus: '', risk_note: '' }])
    setFocusedCode('KOSPI')
  }

  const handleSave = () => {
    const payload = {
      name: draftName.trim(),
      items: draftItems.filter(item => item.code).map(item => ({
        code: item.code,
        enabled: item.enabled !== false,
        description: item.description || '',
        trade_focus: item.trade_focus || '',
        risk_note: item.risk_note || '',
      })),
    }
    if (!payload.name || payload.items.length === 0) return
    onSave(selectedName === '__new__' ? null : selectedTheme?.name, payload)
  }

  const handleDelete = () => {
    if (selectedName === '__new__' || !selectedTheme?.name) return
    onDelete(selectedTheme.name)
  }

  const focusedItem = draftItems.find(item => item.code === focusedCode) || draftItems[0]

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.72)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999 }}>
      <div style={{ width:980, maxWidth:'95vw', maxHeight:'90vh', overflow:'hidden', display:'grid', gridTemplateColumns:'220px 320px 1fr', background:'#0b1020', border:'1px solid #334155', borderRadius:10 }}>
        <div style={{ borderRight:'1px solid #1e293b', padding:14, overflow:'auto' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
            <div style={{ color:'#fbbf24', fontSize:12, fontWeight:'bold' }}>테마</div>
            <button onClick={handleNew} style={{ fontSize:10, padding:'4px 8px', background:'#082f49', color:'#7dd3fc', border:'1px solid #0ea5e9', borderRadius:6, cursor:'pointer' }}>새 테마</button>
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {themes.map(theme => (
              <button key={theme.name} onClick={() => setSelectedName(theme.name)} style={{
                textAlign:'left', padding:'8px 10px', borderRadius:6, cursor:'pointer',
                background: selectedName === theme.name ? '#1e293b' : '#111827',
                color: selectedName === theme.name ? '#f8fafc' : '#94a3b8',
                border: `1px solid ${selectedName === theme.name ? '#38bdf8' : '#1f2937'}`,
              }}>
                <div style={{ fontSize:11, fontWeight:'bold' }}>{theme.name}</div>
                <div style={{ fontSize:9 }}>{theme.items?.length || theme.codes?.length || 0}종목</div>
              </button>
            ))}
          </div>
        </div>
        <div style={{ borderRight:'1px solid #1e293b', padding:14, overflow:'auto' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
            <div style={{ color:'#e2e8f0', fontSize:12, fontWeight:'bold' }}>테마 편집</div>
            <button onClick={onClose} style={{ fontSize:10, padding:'4px 8px', background:'#111827', color:'#cbd5e1', border:'1px solid #334155', borderRadius:6, cursor:'pointer' }}>닫기</button>
          </div>
          <div style={{ marginBottom:12 }}>
            <div style={{ fontSize:10, color:'#94a3b8', marginBottom:4 }}>테마명</div>
            <input value={draftName} onChange={e => setDraftName(e.target.value)} style={{ width:'100%', background:'#020617', color:'#e2e8f0', border:'1px solid #334155', borderRadius:6, padding:'8px 10px', fontSize:12 }} />
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
            <div style={{ fontSize:10, color:'#94a3b8' }}>종목</div>
            <button onClick={addItem} style={{ fontSize:10, padding:'4px 8px', background:'#052e16', color:'#bbf7d0', border:'1px solid #15803d', borderRadius:6, cursor:'pointer' }}>종목 추가</button>
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {draftItems.map(item => (
              <div key={item.code} style={{ display:'grid', gridTemplateColumns:'1fr auto', gap:6, padding:'8px', background: focusedCode === item.code ? '#132238' : '#111827', border:`1px solid ${focusedCode === item.code ? '#38bdf8' : '#1f2937'}`, borderRadius:8 }}>
                <button onClick={() => setFocusedCode(item.code)} style={{ textAlign:'left', background:'transparent', border:'none', color:'#e5e7eb', cursor:'pointer', padding:0 }}>
                  <div style={{ fontSize:11, fontWeight:'bold' }}>{STOCK_NAMES[item.code] || item.code}</div>
                  <div style={{ fontSize:9, color:'#94a3b8' }}>{item.code}</div>
                  <div style={{ fontSize:9, color:item.enabled ? '#86efac' : '#fca5a5' }}>{item.enabled ? '활성' : '비활성'}</div>
                </button>
                <button onClick={() => removeItem(item.code)} disabled={draftItems.length <= 1} style={{ fontSize:10, padding:'4px 8px', background:'#2a0b0b', color:'#fecaca', border:'1px solid #7f1d1d', borderRadius:6, cursor:draftItems.length <= 1 ? 'not-allowed' : 'pointer', opacity:draftItems.length <= 1 ? 0.5 : 1 }}>삭제</button>
              </div>
            ))}
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', marginTop:16 }}>
            <button onClick={handleDelete} disabled={selectedName === '__new__'} style={{ padding:'8px 12px', borderRadius:6, cursor:selectedName === '__new__' ? 'not-allowed' : 'pointer', background:'#2a0b0b', color:'#fecaca', border:'1px solid #7f1d1d', opacity:selectedName === '__new__' ? 0.5 : 1 }}>테마 삭제</button>
            <button onClick={handleSave} style={{ padding:'8px 14px', borderRadius:6, cursor:'pointer', background:'#052e16', color:'#bbf7d0', border:'1px solid #15803d', fontWeight:'bold' }}>저장</button>
          </div>
        </div>
        <div style={{ padding:14, overflow:'auto' }}>
          {!focusedItem ? null : (
            <>
              <div style={{ color:'#e2e8f0', fontSize:12, fontWeight:'bold', marginBottom:12 }}>종목 편집</div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 110px', gap:10, marginBottom:12 }}>
                <div>
                  <div style={{ fontSize:10, color:'#94a3b8', marginBottom:4 }}>종목</div>
                  <select value={focusedItem.code} onChange={e => changeCode(focusedItem.code, e.target.value)} style={{ width:'100%', background:'#020617', color:'#e2e8f0', border:'1px solid #334155', borderRadius:6, padding:'8px 10px', fontSize:12 }}>
                    <option value="KOSPI">KOSPI</option>
                    {Object.entries(STOCK_NAMES).map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
                  </select>
                </div>
                <div>
                  <div style={{ fontSize:10, color:'#94a3b8', marginBottom:4 }}>활성화</div>
                  <label style={{ display:'flex', alignItems:'center', gap:8, height:40, padding:'0 10px', background:'#111827', border:'1px solid #334155', borderRadius:6, color:'#e2e8f0', fontSize:11 }}>
                    <input type="checkbox" checked={focusedItem.enabled !== false} onChange={e => updateItem(focusedItem.code, { enabled: e.target.checked })} />
                    <span>{focusedItem.enabled !== false ? '자동매매 대상' : '관찰 전용'}</span>
                  </label>
                </div>
              </div>
              <div style={{ marginBottom:12 }}>
                <div style={{ fontSize:10, color:'#94a3b8', marginBottom:4 }}>종목 설명</div>
                <textarea value={focusedItem.description || ''} onChange={e => updateItem(focusedItem.code, { description: e.target.value })} rows={3} style={{ width:'100%', resize:'vertical', background:'#020617', color:'#e2e8f0', border:'1px solid #334155', borderRadius:6, padding:'8px 10px', fontSize:12 }} />
              </div>
              <div style={{ marginBottom:12 }}>
                <div style={{ fontSize:10, color:'#94a3b8', marginBottom:4 }}>매매 주안점</div>
                <textarea value={focusedItem.trade_focus || ''} onChange={e => updateItem(focusedItem.code, { trade_focus: e.target.value })} rows={4} style={{ width:'100%', resize:'vertical', background:'#020617', color:'#e2e8f0', border:'1px solid #334155', borderRadius:6, padding:'8px 10px', fontSize:12 }} />
              </div>
              <div>
                <div style={{ fontSize:10, color:'#94a3b8', marginBottom:4 }}>리스크 / 비고</div>
                <textarea value={focusedItem.risk_note || ''} onChange={e => updateItem(focusedItem.code, { risk_note: e.target.value })} rows={4} style={{ width:'100%', resize:'vertical', background:'#020617', color:'#e2e8f0', border:'1px solid #334155', borderRadius:6, padding:'8px 10px', fontSize:12 }} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function SidePanel({ state, panels, focusedIdx, onChangeFocused, onChangePanel, tf, onChangeTF, indicators, onChangeIndicators, onSend, onApplyConfig, themes, selectedThemeName, onSelectTheme, onOpenThemeManager }) {
  const [activityTab, setActivityTab] = useState('trades')
  const [sigFilter, setSigFilter] = useState('ALL')
  const signals = state?.signals || []
  const tradeLogs = state?.trade_logs || []
  const holdings = state?.holdings || []
  const focusCode = panels[focusedIdx]?.code
  const focusOverlay = focusCode ? state?.position_overlays?.[focusCode] : null
  const focusHoga = focusOverlay?.hoga ?? (focusCode ? state?.hoga_analysis?.[focusCode] : null)
  const codeDataStatus = state?.code_data_status || {}
  const actionColor = { BUY:'#0c6', SELL:'#f44', HOLD:'#888' }
  const statusPalette = {
    ready: { fg:'#86efac', bg:'#052e16', border:'#166534', label:'READY' },
    loading: { fg:'#fde68a', bg:'#3a2a05', border:'#a16207', label:'LOAD' },
    stale: { fg:'#fca5a5', bg:'#3f0d0d', border:'#b91c1c', label:'STALE' },
    error: { fg:'#fecaca', bg:'#450a0a', border:'#dc2626', label:'ERROR' },
    closed: { fg:'#cbd5e1', bg:'#0f172a', border:'#475569', label:'CLOSED' },
  }
  const filteredSignals = sigFilter === 'ALL' ? signals : signals.filter(s => s.action === sigFilter)

  return (
    <div style={{ width:260, display:'flex', flexDirection:'column', borderLeft:'1px solid #222', background:'#0a0a0a', overflow:'hidden', flexShrink:0 }}>

      <div style={{ padding:'5px 8px', borderBottom:'1px solid #222' }}>
        <div style={{ fontSize:10, color:'#888', marginBottom:3 }}>타임프레임</div>
        <div style={{ display:'flex', gap:2, flexWrap:'wrap' }}>
          {TIMEFRAMES.map(t => (
            <button key={t} onClick={() => onChangeTF(t)}
              style={{
                fontSize:9, padding:'2px 6px', cursor:'pointer', borderRadius:2,
                background: t === tf ? '#003366' : '#111',
                color: t === tf ? '#66aaff' : '#888',
                border: `1px solid ${t === tf ? '#336699' : '#333'}`,
                fontWeight: t === tf ? 'bold' : 'normal',
              }}>{TF_LABELS[t]}</button>
          ))}
        </div>
      </div>

      <AutoTradeSettings state={state} onSend={onSend} onApplyConfig={onApplyConfig} />

      <IndicatorSettings indicators={indicators} onChange={onChangeIndicators} />

      <div style={{ padding:'5px 8px', borderBottom:'1px solid #222' }}>
        <div style={{ fontSize:10, color:'#ffcc00', marginBottom:3 }}>테마</div>
        <div style={{ display:'flex', gap:6 }}>
          <select value={selectedThemeName}
            onChange={e => onSelectTheme(e.target.value)}
            style={{ flex:1, background:'#1a1500', color:'#ffcc00', border:'1px solid #665500', fontSize:10, padding:'2px 4px' }}>
            {themes.map(theme => <option key={theme.name} value={theme.name}>{theme.name}</option>)}
          </select>
          <button onClick={onOpenThemeManager} style={{ fontSize:9, padding:'2px 8px', cursor:'pointer', borderRadius:4, background:'#111827', color:'#cbd5e1', border:'1px solid #334155' }}>관리</button>
        </div>
      </div>

      <div style={{ padding:'5px 8px', borderBottom:'1px solid #222' }}>
        <div style={{ fontSize:10, color:'#ffcc00', marginBottom:3 }}>포커스 [{focusedIdx+1}번] 종목</div>
        <select value={panels[focusedIdx]?.code || 'KOSPI'}
          onChange={e => onChangePanel(focusedIdx, e.target.value)}
          style={{ width:'100%', background:'#1a1500', color:'#ffcc00', border:'1px solid #665500', fontSize:10, padding:'2px 4px' }}>
          <option value="KOSPI">KOSPI 지수</option>
          {Object.entries(STOCK_NAMES).map(([c,n]) => <option key={c} value={c}>{n} ({c})</option>)}
        </select>
      </div>

      <div style={{ padding:'3px 8px', borderBottom:'1px solid #222' }}>
        <div style={{ display:'flex', flexWrap:'wrap', gap:2 }}>
          {panels.map((p,i) => (
            (() => {
              const itemStatus = codeDataStatus[p.code] || {}
              const style = statusPalette[itemStatus.status] || { fg:'#94a3b8', bg:'#111827', border:'#334155', label:'UNK' }
              return (
            <button key={i} onClick={() => onChangeFocused(i)} style={{
              fontSize:8, padding:'1px 4px', cursor:'pointer', borderRadius:2,
              background: i === focusedIdx ? '#1a1500' : '#111',
              color: i === focusedIdx ? '#ffcc00' : '#888',
              border: `1px solid ${i === focusedIdx ? '#665500' : '#333'}`,
            }} title={itemStatus.reason || ''}>{i+1}.{p.title} <span style={{ color: style.fg }}>{style.label}</span></button>
              )
            })()
          ))}
        </div>
      </div>

      <div style={{ padding:'4px 8px', borderBottom:'1px solid #222' }}>
        <div style={{ fontSize:10, color:'#666', marginBottom:2 }}>데이터 상태</div>
        {(() => {
          const itemStatus = codeDataStatus[focusCode] || {}
          const style = statusPalette[itemStatus.status] || { fg:'#94a3b8', bg:'#111827', border:'#334155', label:'UNK' }
          return (
            <div style={{ fontSize:9, lineHeight:1.7, color:'#ccc' }}>
              <div>
                <span style={{
                  display:'inline-block', fontSize:8, fontWeight:'bold', padding:'1px 4px', borderRadius:4,
                  color: style.fg, background: style.bg, border:`1px solid ${style.border}`, marginRight:6,
                }}>{style.label}</span>
                <span>{itemStatus.reason || '상태 없음'}</span>
              </div>
              <div>캔들 {itemStatus.bars ?? 0}/{itemStatus.required_bars ?? 0}</div>
              {itemStatus.stale_seconds != null ? <div>틱 지연 {itemStatus.stale_seconds}s</div> : null}
            </div>
          )
        })()}
      </div>

      <div style={{ padding:'4px 8px', borderBottom:'1px solid #222' }}>
        <div style={{ fontSize:10, color:'#666', marginBottom:2 }}>보유종목</div>
        {holdings.length === 0 ? <div style={{ fontSize:9, color:'#444' }}>없음</div>
          : holdings.map(h => (
            <div key={h.code} style={{ fontSize:9, lineHeight:1.7, color:'#ccc', borderBottom:'1px solid #1a1a1a', paddingBottom:2, marginBottom:2 }}>
              <div style={{ display:'flex', justifyContent:'space-between' }}>
                <span style={{ fontWeight:'bold' }}>{h.name}</span><span>{h.qty}주</span>
              </div>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:8, color:'#999' }}>
                <span>매수 {h.avg_price?.toLocaleString()}</span>
                <span>현재 <b style={{ color:'#eee' }}>{h.current?.toLocaleString()}</b></span>
              </div>
              <div style={{ textAlign:'right' }}>
                <span style={{ color: h.pnl >= 0 ? '#f66' : '#69f', fontWeight:'bold' }}>
                  {h.pnl >= 0 ? '+' : ''}{h.pnl?.toLocaleString()}원
                </span>
                <span style={{ color: h.pnl >= 0 ? '#f66' : '#69f', marginLeft:4, fontSize:8 }}>
                  ({h.pnl_pct >= 0 ? '+' : ''}{h.pnl_pct?.toFixed(2)}%)
                </span>
              </div>
            </div>
          ))
        }
      </div>

      <div style={{ padding:'4px 8px', borderBottom:'1px solid #222' }}>
        <div style={{ fontSize:10, color:'#666', marginBottom:2 }}>포커스 포지션</div>
        {!focusOverlay ? <div style={{ fontSize:9, color:'#444' }}>보유 없음</div> : (
          <div style={{ fontSize:9, lineHeight:1.7, color:'#ccc' }}>
            <div>평균단가 {focusOverlay.avg_price?.toLocaleString()} / 현재가 {focusOverlay.current_price?.toLocaleString()}</div>
            <div>목표가 <span style={{ color:'#0c6' }}>{focusOverlay.target?.toLocaleString() || '-'}</span> / ATR목표 <span style={{ color:'#5eead4' }}>{focusOverlay.atr_target?.toLocaleString() || '-'}</span></div>
            <div>손절가 <span style={{ color:'#f66' }}>{focusOverlay.stop?.toLocaleString() || '-'}</span> / ATR손절 <span style={{ color:'#facc15' }}>{focusOverlay.atr_stop?.toLocaleString() || '-'}</span></div>
            <div>ATR {focusOverlay.atr ?? '-'} {focusOverlay.is_stale ? <span style={{ color:'#f66' }}>/ 실시간 지연 {focusOverlay.stale_seconds}s</span> : null}</div>
            <div>평가손익 <span style={{ color: focusOverlay.pnl >= 0 ? '#f66' : '#69f' }}>{focusOverlay.pnl >= 0 ? '+' : ''}{focusOverlay.pnl?.toLocaleString()}원 ({focusOverlay.pnl_pct >= 0 ? '+' : ''}{focusOverlay.pnl_pct?.toFixed(2)}%)</span></div>
          </div>
        )}
      </div>

      <div style={{ padding:'4px 8px', borderBottom:'1px solid #222' }}>
        <div style={{ fontSize:10, color:'#666', marginBottom:2 }}>호가분석</div>
        {!focusHoga ? <div style={{ fontSize:9, color:'#444' }}>수신 없음</div> : (
          <div style={{ fontSize:9, lineHeight:1.7, color:'#ccc' }}>
            <div>압력 <span style={{ color: focusHoga.pressure === '매수우위' ? '#0c6' : focusHoga.pressure === '매도우위' ? '#f66' : '#aaa' }}>{focusHoga.pressure}</span> / 비율 {focusHoga.imbalance ?? '-'}</div>
            <div>매수잔량 {focusHoga.bid_total?.toLocaleString?.() ?? focusHoga.bid_total} / 매도잔량 {focusHoga.ask_total?.toLocaleString?.() ?? focusHoga.ask_total}</div>
            <div>최우선 매수 {focusHoga.best_bid?.toLocaleString?.() ?? focusHoga.best_bid} / 매도 {focusHoga.best_ask?.toLocaleString?.() ?? focusHoga.best_ask} / 스프레드 {focusHoga.spread?.toLocaleString?.() ?? focusHoga.spread}</div>
          </div>
        )}
      </div>

      <div style={{ flex:1, overflow:'auto', padding:'4px 8px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:6, padding:'6px 8px', background:'#111827', border:'1px solid #1f2937', borderRadius:8 }}>
          {[
            { id:'trades', label:'주문/체결' },
            { id:'signals', label:'시그널' },
          ].map(tab => (
            <button key={tab.id} onClick={() => setActivityTab(tab.id)} style={{
              flex:1, fontSize:10, padding:'6px 0', cursor:'pointer', borderRadius:6,
              background: activityTab === tab.id ? '#082f49' : '#0b1220',
              color: activityTab === tab.id ? '#7dd3fc' : '#64748b',
              border: `1px solid ${activityTab === tab.id ? '#0ea5e9' : '#1f2937'}`,
              fontWeight: activityTab === tab.id ? 'bold' : 'normal',
            }}>{tab.label}</button>
          ))}
        </div>
        {activityTab === 'signals' && (
          <>
            <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:4 }}>
              {['ALL','BUY','SELL','HOLD'].map(f => (
                <button key={f} onClick={() => setSigFilter(f)} style={{
                  fontSize:8, padding:'1px 4px', cursor:'pointer', borderRadius:2,
                  background: f === sigFilter ? (f==='BUY'?'#003300':f==='SELL'?'#330000':f==='HOLD'?'#222':'#002244') : '#111',
                  color: f === sigFilter ? (f==='BUY'?'#0c6':f==='SELL'?'#f44':f==='HOLD'?'#888':'#66aaff') : '#555',
                  border: `1px solid ${f === sigFilter ? '#444' : '#333'}`,
                }}>{f}</button>
              ))}
            </div>
            {filteredSignals.slice(0,100).map((s,i) => (
              <div key={i} style={{ fontSize:8, color:'#aaa', lineHeight:1.5 }}>
                <span style={{ color:'#666' }}>{s.ts || '--:--:--'}</span>{' '}
                <span style={{ color: actionColor[s.action] || '#888' }}>[{s.action}]</span>{' '}
                {s.name} {s.price?.toLocaleString()} × {s.qty} — {s.reason}
              </div>
            ))}
          </>
        )}
        {activityTab === 'trades' && (
          <>
            <div style={{ fontSize:8, color:'#666', marginBottom:4 }}>파일 저장: `trade_logs/trades_YYYYMMDD.jsonl`</div>
            {tradeLogs.slice(0,150).map((t, i) => (
              <div key={i} style={{ fontSize:8, color:'#aaa', lineHeight:1.55, borderBottom:'1px solid #151515', paddingBottom:3, marginBottom:3 }}>
                <div>
                  <span style={{ color:'#666' }}>{t.ts || '--:--:--'}</span>{' '}
                  <span style={{ color: t.action === 'BUY' ? '#0c6' : t.action === 'SELL' ? '#f44' : '#66aaff' }}>[{t.action || t.kind}]</span>{' '}
                  <span style={{ color:'#e5e7eb' }}>{t.name || t.code}</span>{' '}
                  {t.qty ? `${Number(t.qty).toLocaleString()}주` : ''} {t.price ? `@ ${Number(t.price).toLocaleString()}` : ''}
                </div>
                <div style={{ color:'#888' }}>{t.source} / {t.kind} / {t.status || '-'}</div>
                {t.reason ? <div>{t.reason}</div> : null}
                {t.message ? <div style={{ color:'#777' }}>{t.message}</div> : null}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// 메인 대시보드
// ═══════════════════════════════════════════════════════════════

export default function TradingDashboard() {
  const [state, setState] = useState(null)
  const [connected, setConnected] = useState(false)
  const [lastError, setLastError] = useState('')
  const [layoutIdx, setLayoutIdx] = useState(2)
  const [panels, setPanels] = useState(makePanels(DEFAULT_CODES))
  const [themes, setThemes] = useState(DEFAULT_THEMES)
  const [selectedThemeName, setSelectedThemeName] = useState('IranWar')
  const [themeDialogOpen, setThemeDialogOpen] = useState(false)
  const [focusedIdx, setFocusedIdx] = useState(0)
  const [buyConfirm, setBuyConfirm] = useState(null)
  const [sellConfirm, setSellConfirm] = useState(null)
  const [tf, setTF] = useState('m1')
  const [indicators, setIndicators] = useState({
    supertrend: { enabled: true, period: 10, multiplier: 3 },
    jma: { enabled: true, period: 7, phase: 50, power: 2 },
    rsi: { enabled: true, period: 14 },
  })
  const ws = useRef(null)
  const prevSignalCountRef = useRef(0)
  const [crosshairSync, setCrosshairSync] = useState(true)
  const crosshairSyncRef = useRef(true)
  const chartRegistryRef = useRef({})  // { [chartKey]: { chart, series } }
  const crosshairSyncingRef = useRef(false)

  const registerChart = useCallback((key, chart, series) => {
    chartRegistryRef.current[key] = { chart, series }
    chart.subscribeCrosshairMove(param => {
      if (!crosshairSyncRef.current) return
      if (crosshairSyncingRef.current) return
      crosshairSyncingRef.current = true
      Object.entries(chartRegistryRef.current).forEach(([k, entry]) => {
        if (k === key || !entry) return
        try {
          if (param.time !== undefined) {
            const raw = param.seriesData?.get(series)
            const priceVal = raw?.close ?? raw?.value ?? 0
            entry.chart.setCrosshairPosition(priceVal, param.time, entry.series)
          } else {
            entry.chart.clearCrosshairPosition()
          }
        } catch(_) {}
      })
      crosshairSyncingRef.current = false
    })
  }, [])

  const unregisterChart = useCallback((key) => {
    delete chartRegistryRef.current[key]
  }, [])

  useEffect(() => { crosshairSyncRef.current = crosshairSync }, [crosshairSync])

  const layout = LAYOUTS[layoutIdx]
  const visibleCount = layout.cols * layout.rows

  const applyTheme = useCallback((themeName, themeList = themes) => {
    const nextThemes = normalizeThemes(themeList)
    const theme = nextThemes.find(item => item.name === themeName) || nextThemes[0]
    setThemes(nextThemes)
    setSelectedThemeName(theme.name)
    setPanels(makePanels(theme.codes))
    setFocusedIdx(0)
  }, [themes])

  const loadThemes = useCallback(async () => {
    try {
      const resp = await fetch('/api/themes')
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const json = await resp.json()
      const nextThemes = normalizeThemes(json.themes)
      setThemes(nextThemes)
      setSelectedThemeName(prev => nextThemes.some(theme => theme.name === prev) ? prev : nextThemes[0].name)
      return nextThemes
    } catch (err) {
      console.error('theme load failed:', err)
      return DEFAULT_THEMES
    }
  }, [])

  useEffect(() => {
    loadThemes().then(nextThemes => {
      const normalized = normalizeThemes(nextThemes)
      const active = normalized.find(theme => theme.name === selectedThemeName) || normalized[0]
      setPanels(makePanels(active.codes))
    })
  }, [loadThemes])

  const handleChangeTF = useCallback((newTF) => {
    if (newTF === tf) return
    setTF(newTF)
  }, [tf])

  // WebSocket
  useEffect(() => {
    let reconnectTimer = null
    function connect() {
      const WS_URL = `ws://${window.location.hostname}:5000/ws/dashboard`
      ws.current = new WebSocket(WS_URL)
      ws.current.onopen = () => setConnected(true)
      ws.current.onclose = () => { setConnected(false); reconnectTimer = setTimeout(connect, 2000) }
      ws.current.onmessage = (e) => {
        const msg = JSON.parse(e.data)
        if (msg.type === 'snapshot') {
          if (msg.data.buy_levels) window.__BUY_LEVELS = msg.data.buy_levels
          if (msg.data.kospi_prev_close) window.__KOSPI_PREV = msg.data.kospi_prev_close
          prevSignalCountRef.current = msg.data.signals?.length || 0
          setState(msg.data)
        }
        if (msg.type === 'update') {
          setState(prev => {
            if (!prev) return null
            const next = {
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
              trade_logs: msg.trade_logs ?? prev.trade_logs,
              buy_levels: msg.buy_levels ?? prev.buy_levels,
              prev_closes: msg.prev_closes ?? prev.prev_closes,
              position_overlays: msg.position_overlays ?? prev.position_overlays,
              hoga_analysis: msg.hoga_analysis ?? prev.hoga_analysis,
              data_health: msg.data_health ?? prev.data_health,
              data_readiness: msg.data_readiness ?? prev.data_readiness,
              code_data_status: msg.code_data_status ?? prev.code_data_status,
              kospi: msg.kospi ?? prev.kospi,
              auto_trading: msg.auto_trading ?? prev.auto_trading,
              trade_config: msg.trade_config ?? prev.trade_config,
              candle_store: msg.candle_store ?? prev.candle_store,
              pnl_history: msg.pnl_history ?? prev.pnl_history,
            }
            const nc = next.signals?.length || 0
            if (nc > prevSignalCountRef.current && nc > 0) {
              const latest = next.signals[0]
              playBeep(latest?.action === 'BUY' ? 'buy' : latest?.action === 'SELL' ? 'sell' : 'alert')
            }
            prevSignalCountRef.current = nc
            return next
          })
        }
        if (msg.type === 'config_changed') {
          setState(prev => {
            if (!prev) return prev
            return {
              ...prev,
              auto_trading: msg.auto_trading ?? prev.auto_trading,
              regime: msg.regime ?? msg.regime_override ?? prev.regime,
                trade_config: msg.trade_config ?? prev.trade_config,
                data_health: msg.data_health ?? prev.data_health,
                data_readiness: msg.data_readiness ?? prev.data_readiness,
                code_data_status: msg.code_data_status ?? prev.code_data_status,
              }
            })
        }
        if (msg.type === 'view_changed') {
          setState(prev => {
            if (!prev) return prev
            return {
              ...prev,
              candle_store: msg.candle_store ?? prev.candle_store,
            }
          })
        }
        if (msg.type === 'heartbeat') {
          setState(prev => {
            if (!prev) return prev
            return {
              ...prev,
              data_health: msg.data_health ?? prev.data_health,
              data_readiness: msg.data_readiness ?? prev.data_readiness,
              code_data_status: msg.code_data_status ?? prev.code_data_status,
            }
          })
        }
        if (msg.type === 'error') {
          setLastError(msg.msg || '알 수 없는 오류')
          setState(prev => {
            if (!prev) return prev
            return {
              ...prev,
              trade_logs: [{
                ts: new Date().toISOString(),
                kind: 'error',
                source: 'server',
                action: '',
                code: '',
                name: '주문오류',
                qty: 0,
                price: 0,
                status: 'error',
                message: msg.msg || '알 수 없는 오류',
                reason: '오류 차단',
              }, ...(prev.trade_logs || [])].slice(0, 200),
            }
          })
        }
        if (msg.type === 'order_result') {
          const resultOk = msg.result?.Success ?? msg.result?.success ?? false
          const action = msg.cmd?.includes('sell') ? 'SELL' : 'BUY'
          const name = STOCK_NAMES[msg.code] || msg.code || '주문'
          setState(prev => {
            if (!prev) return prev
            const manualLog = {
              code: msg.code,
              ts: msg.ts ? new Date(msg.ts).toLocaleTimeString('ko-KR', { hour12: false }) : '--:--:--',
              action,
              name,
              price: msg.price,
              qty: msg.qty,
              marker_time: Math.floor(Date.now() / 1000 / 60) * 60,
              reason: resultOk ? `수동 ${action === 'BUY' ? '매수' : '매도'} 주문 접수` : `주문 실패: ${msg.result?.Msg || msg.result?.message || '응답 확인 필요'}`,
            }
            return {
              ...prev,
              signals: [manualLog, ...(prev.signals || [])].slice(0, 200),
              trade_logs: [{
                ts: msg.ts || new Date().toISOString(),
                kind: 'order_submit',
                source: 'manual',
                action,
                code: msg.code,
                name,
                qty: msg.qty,
                price: msg.price,
                status: resultOk ? 'accepted' : 'failed',
                message: resultOk ? '수동 주문 접수' : (msg.result?.Msg || msg.result?.message || '응답 확인 필요'),
                reason: `수동 ${action === 'BUY' ? '매수' : '매도'} 주문`,
              }, ...(prev.trade_logs || [])].slice(0, 200),
            }
          })
        }
      }
    }
    connect()
    return () => { clearTimeout(reconnectTimer); ws.current?.close() }
  }, [])

  // 키보드 단축키
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return
      const n = parseInt(e.key)
      if (!isNaN(n) && n >= 1 && n <= 9) {
        setFocusedIdx(Math.min(n - 1, visibleCount - 1))
      } else if (e.key === 'Escape') {
        setSellConfirm(null)
      } else if (e.key === ']') {
        const i = TIMEFRAMES.indexOf(tf); if (i < TIMEFRAMES.length - 1) handleChangeTF(TIMEFRAMES[i + 1])
      } else if (e.key === '[') {
        const i = TIMEFRAMES.indexOf(tf); if (i > 0) handleChangeTF(TIMEFRAMES[i - 1])
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [visibleCount, tf, handleChangeTF])

  const send = useCallback((payload) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(payload))
  }, [])
  useEffect(() => {
    if (!connected) return
    const visibleCodes = panels.slice(0, visibleCount).map(p => p.code).filter(Boolean)
    if (!visibleCodes.length) return
    send({ cmd: 'set_view', tf, codes: visibleCodes })
  }, [connected, panels, visibleCount, tf, send])

  const autoTradeBlockedReason = state?.data_health?.status !== 'ok'
    ? state?.data_health?.reason
    : (state?.data_readiness?.ready === false ? state?.data_readiness?.reason : '')
  const toggleAutoQuick = useCallback(() => {
    if (!(state?.auto_trading ?? false) && autoTradeBlockedReason) {
      setLastError(`자동매매 차단: ${autoTradeBlockedReason}`)
      return
    }
    const enabled = !(state?.auto_trading ?? false)
    send({ cmd: 'toggle_auto', enabled })
  }, [autoTradeBlockedReason, send, state])

  const applyTradeConfig = useCallback((payload) => {
    setState(prev => {
      if (!prev) return prev
      return {
        ...prev,
        trade_config: {
          total_budget: payload.total_budget,
          per_stock: payload.per_stock,
          strategies: payload.strategies,
        },
      }
    })
    send({ cmd: 'set_config', ...payload })
  }, [send])

  const handleToggleIndicator = useCallback((key, enabled) => {
    setIndicators(prev => ({ ...prev, [key]: { ...prev[key], enabled } }))
  }, [])

  const handleBuy = useCallback((code, price) => {
    if (!price || price <= 0) return
    const budget = state?.trade_config?.per_stock ?? 5000000
    const qty = calcQty(code, price, budget)
    const holding = (state?.holdings || []).find(h => h.code === code)
    setBuyConfirm({
      code,
      name: STOCK_NAMES[code] || code,
      price,
      qty,
      holdingQty: holding?.qty ?? 0,
      holdingAvg: holding?.avg_price ?? 0,
    })
  }, [state])

  const confirmBuy = useCallback(() => {
    if (!buyConfirm) return
    send({ cmd: 'buy', code: buyConfirm.code, qty: buyConfirm.qty, price: buyConfirm.price })
    playBeep('buy')
    setBuyConfirm(null)
  }, [buyConfirm, send])

  const handleSell = useCallback((code, name) => {
    setSellConfirm({ code, name })
  }, [])

  const confirmSell = useCallback(() => {
    if (!sellConfirm) return
    send({ cmd: 'emergency_sell', code: sellConfirm.code })
    playBeep('sell')
    setSellConfirm(null)
  }, [send, sellConfirm])

  const handleChangePanel = useCallback((idx, newCode) => {
    setPanels(prev => prev.map((p, i) =>
      i === idx ? { code: newCode, title: newCode === 'KOSPI' ? 'KOSPI 지수' : (STOCK_NAMES[newCode] || newCode) } : p
    ))
  }, [])

  const handleSelectTheme = useCallback((themeName) => {
    applyTheme(themeName)
  }, [applyTheme])

  const handleSaveTheme = useCallback(async (originalName, payload) => {
    const method = originalName ? 'PUT' : 'POST'
    const url = originalName ? `/api/themes/${encodeURIComponent(originalName)}` : '/api/themes'
    const resp = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const json = await resp.json()
    if (!resp.ok || json.success === false) {
      throw new Error(json.error || `HTTP ${resp.status}`)
    }
    const nextThemes = normalizeThemes(json.themes)
    applyTheme(payload.name, nextThemes)
    setThemeDialogOpen(false)
  }, [applyTheme])

  const handleDeleteTheme = useCallback(async (themeName) => {
    const resp = await fetch(`/api/themes/${encodeURIComponent(themeName)}`, { method: 'DELETE' })
    const json = await resp.json()
    if (!resp.ok || json.success === false) {
      throw new Error(json.error || `HTTP ${resp.status}`)
    }
    const nextThemes = normalizeThemes(json.themes)
    applyTheme(nextThemes[0]?.name || 'IranWar', nextThemes)
    setThemeDialogOpen(false)
  }, [applyTheme])

  const currentPanels = panels.slice(0, visibleCount)

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:'#050508', color:'#ccc', fontFamily:'monospace' }}>
      {/* 컨트롤 바 */}
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'3px 10px', background:'#0d0d1a', borderBottom:'1px solid #222', flexShrink:0 }}>
        <span style={{ fontWeight:'bold', fontSize:12, color:'#ff4444' }}>WAR-ADAPTIVE</span>
        <span style={{ fontSize:10, color: connected ? '#0c6' : '#f44' }}>● {connected ? 'LIVE' : '연결중...'}</span>
        <div style={{ display:'flex', gap:3, marginLeft:8 }}>
          {LAYOUTS.map((l, i) => (
            <button key={l.id} onClick={() => setLayoutIdx(i)} style={{
              fontSize:9, padding:'1px 6px', cursor:'pointer', borderRadius:2,
              background: i === layoutIdx ? '#002244' : '#111',
              color: i === layoutIdx ? '#66aaff' : '#888',
              border: `1px solid ${i === layoutIdx ? '#224488' : '#333'}`,
              fontWeight: i === layoutIdx ? 'bold' : 'normal',
            }}>{l.id}</button>
          ))}
        </div>
        <AutoTradeGateButton autoOn={state?.auto_trading ?? false} onToggle={toggleAutoQuick} blockedReason={autoTradeBlockedReason} />
        <button onClick={() => setCrosshairSync(v => !v)} title="크로스헤어 동기화 ON/OFF" style={{
          marginLeft:8, fontSize:9, padding:'1px 6px', cursor:'pointer', borderRadius:2,
          background: crosshairSync ? '#002244' : '#111',
          color: crosshairSync ? '#66aaff' : '#555',
          border: `1px solid ${crosshairSync ? '#224488' : '#333'}`,
        }}>⊕{crosshairSync ? 'SYNC' : 'FREE'}</button>
        {lastError ? <span style={{ marginLeft:8, fontSize:10, color:'#f87171' }}>{lastError}</span> : null}
      </div>

      <MacroBar state={state} />
      <DataHealthBanner health={state?.data_health} readiness={state?.data_readiness} />
      <WhipsawBanner status={state?.whipsaw_status} phase={state?.phase} />

      <div style={{ display:'flex', flex:1, overflow:'hidden', minHeight:0 }}>
        {/* 차트 그리드 */}
        <div style={{
          display:'grid',
          gridTemplateColumns:`repeat(${layout.cols}, 1fr)`,
          gridTemplateRows:`repeat(${layout.rows}, 1fr)`,
          gap:2, padding:2, overflow:'hidden', minHeight:0, flex:1,
        }}>
          {currentPanels.map((p, idx) => {
            const candleData = state?.candle_store?.[tf]?.[p.code]
              ?? (tf === 'm1' ? (state?.candle_history?.[p.code] ?? null) : null)
            const positionOverlay = state?.position_overlays?.[p.code] ?? null
            const codeStatus = state?.code_data_status?.[p.code] ?? null
            const signalMarkers = (state?.signals || [])
              .filter(s => s.code === p.code && (s.action === 'BUY' || s.action === 'SELL'))
              .slice(0, 20)
              .map(s => ({
                time: s.marker_time || positionOverlay?.marker_time || Math.floor(Date.now() / 1000 / 60) * 60,
                position: s.action === 'BUY' ? 'belowBar' : 'aboveBar',
                color: s.action === 'BUY' ? '#00cc66' : '#ff4444',
                shape: s.action === 'BUY' ? 'arrowUp' : 'arrowDown',
                text: `${s.action} ${s.qty || ''}`.trim(),
              }))
            return (
              <RealtimeChart
                key={`${p.code}-${idx}`}
                chartKey={`${p.code}-${idx}`}
                code={p.code}
                title={p.title}
                price={p.code === 'KOSPI'
                  ? state?.kospi
                  : ((positionOverlay?.current_price && positionOverlay.current_price > 0)
                      ? positionOverlay.current_price
                      : ((state?.prices?.[p.code] && state.prices[p.code] > 0)
                          ? state.prices[p.code]
                          : positionOverlay?.current_price))}
                prevPrice={(state?.prev_closes?.[p.code] && state.prev_closes[p.code] > 0)
                  ? state.prev_closes[p.code]
                  : (PREV_CLOSE[p.code] || (p.code === 'KOSPI' ? (window.__KOSPI_PREV || 5380) : 0))}
                whipsaw={state?.whipsaw_status?.[p.code]}
                buyLevels={state?.buy_levels?.[p.code] ?? window.__BUY_LEVELS?.[p.code]}
                positionOverlay={positionOverlay}
                codeStatus={codeStatus}
                signalMarkers={signalMarkers}
                focused={idx === focusedIdx}
                onFocus={() => setFocusedIdx(idx)}
                onBuy={() => handleBuy(p.code, p.code === 'KOSPI' ? state?.kospi : state?.prices?.[p.code])}
                onSell={() => handleSell(p.code, p.title)}
                tf={tf}
                indicators={indicators}
                onToggleIndicator={handleToggleIndicator}
                candleData={candleData}
                onChartReady={registerChart}
                onChartDestroy={unregisterChart}
              />
            )
          })}
        </div>

        <SidePanel
          state={state}
          panels={currentPanels}
          focusedIdx={focusedIdx}
          onChangeFocused={setFocusedIdx}
          onChangePanel={handleChangePanel}
          themes={themes}
          selectedThemeName={selectedThemeName}
          onSelectTheme={handleSelectTheme}
          onOpenThemeManager={() => setThemeDialogOpen(true)}
          tf={tf}
          onChangeTF={handleChangeTF}
          indicators={indicators}
          onChangeIndicators={setIndicators}
          onSend={send}
          onApplyConfig={applyTradeConfig}
        />
      </div>

      {themeDialogOpen && (
        <ThemeManagerDialog
          themes={themes}
          onClose={() => setThemeDialogOpen(false)}
          onSave={async (originalName, payload) => {
            try {
              await handleSaveTheme(originalName, payload)
            } catch (err) {
              setLastError(err.message || '테마 저장 실패')
            }
          }}
          onDelete={async (themeName) => {
            try {
              await handleDeleteTheme(themeName)
            } catch (err) {
              setLastError(err.message || '테마 삭제 실패')
            }
          }}
        />
      )}

      {sellConfirm && (
        <SellConfirmDialog
          code={sellConfirm.code}
          name={sellConfirm.name}
          onConfirm={confirmSell}
          onCancel={() => setSellConfirm(null)}
        />
      )}
      {buyConfirm && (
        <BuyConfirmDialog
          order={buyConfirm}
          onConfirm={confirmBuy}
          onCancel={() => setBuyConfirm(null)}
        />
      )}
    </div>
  )
}
