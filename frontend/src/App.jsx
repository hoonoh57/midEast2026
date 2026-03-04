import { useState, useEffect, useRef, useCallback } from 'react'
import { createChart, ColorType, CandlestickSeries, HistogramSeries, LineSeries } from 'lightweight-charts'

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
const TIMEFRAMES = ['m1','m3','m5','m10','m15','m60','D']
const TF_LABELS = { m1:'1분', m3:'3분', m5:'5분', m10:'10분', m15:'15분', m60:'1시간', D:'일봉' }

function makePanels(codes) {
  return codes.map(code => ({ code, title: code === 'KOSPI' ? 'KOSPI 지수' : (STOCK_NAMES[code] || code) }))
}
function calcQty(code, price) {
  if (!price || price <= 0) return 1
  return Math.max(1, Math.floor(5_000_000 / price))
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
  if (candles.length < 2) return { data: [], state: null }

  const phaseRatio = phase < -100 ? 0.5 : phase > 100 ? 2.5 : phase / 100 + 1.5
  const beta = 0.45 * (period - 1) / (0.45 * (period - 1) + 2)
  const alpha = Math.pow(beta, power)

  let e0 = NaN, e1 = NaN, e2 = NaN, prevJMA = NaN
  const result = []

  for (let i = 0; i < candles.length; i++) {
    const src = candles[i].close

    if (isNaN(e0)) { e0 = src; e1 = 0; e2 = 0; prevJMA = src }

    e0 = (1 - alpha) * src + alpha * e0
    e1 = (src - e0) * (1 - beta) + beta * e1
    e2 = (e0 + phaseRatio * e1 - prevJMA) * Math.pow(1 - alpha, 2) + Math.pow(alpha, 2) * e2

    let jma
    if (i < period) {
      let sum = 0
      for (let j = 0; j <= i; j++) sum += candles[j].close
      jma = Math.round((sum / (i + 1)) * 10) / 10
    } else {
      jma = Math.round((e2 + prevJMA) * 10) / 10
    }

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

function RealtimeChart({ code, title, price, prevPrice, whipsaw, buyLevels, focused, onFocus, onBuy, onSell, tf, indicators, candleData, chartKey, onChartReady, onChartDestroy }) {
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
    })
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' }, priceScaleId: 'volume',
    })
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })

    if (prevPrice > 0) {
      candleSeries.createPriceLine({ price: prevPrice, color: '#ffffff44', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '전일' })
    }
    if (buyLevels) {
      if (buyLevels.L1) candleSeries.createPriceLine({ price: buyLevels.L1, color: '#00cc6688', lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: 'L1' })
      if (buyLevels.L2) candleSeries.createPriceLine({ price: buyLevels.L2, color: '#00aaff88', lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: 'L2' })
      if (buyLevels.L3) candleSeries.createPriceLine({ price: buyLevels.L3, color: '#aa88ff88', lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: 'L3' })
      if (buyLevels.stop) candleSeries.createPriceLine({ price: buyLevels.stop, color: '#ff000088', lineWidth: 2, lineStyle: 0, axisLabelVisible: false, title: '손절' })
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
      try { chart.panes()[1]?.setHeight(80) } catch(_) {}
    }
    rsiSeriesRef.current = rsiSeries

    // m1: __CANDLE_HISTORY 시드 사용 / 그 외: 서버에서 받은 candleData만 사용
    const candles = candleData != null
      ? candleData
      : (tf === 'm1' ? (window.__CANDLE_HISTORY?.[code] || []) : [])
    candlesRef.current = [...candles]
    if (candles.length > 0) {
      candleSeries.setData(candles)
      const avgVol = candles.reduce((s, c) => s + (c.volume || 0), 0) / (candles.length || 1)
      volumeSeries.setData(candles.map(c => ({
        time: c.time, value: c.volume || 0,
        color: (c.volume || 0) > avgVol * 2 ? '#ffcc0099'
             : c.close >= c.open ? '#ef535066' : '#2962ff66',
      })))
      lastBarRef.current = { ...candles[candles.length - 1] }

      if (indicators.supertrend.enabled && candles.length >= indicators.supertrend.period) {
        const { data: stData, state: stState } = calcSuperTrend(
          candles, indicators.supertrend.period, indicators.supertrend.multiplier
        )
        stStateRef.current = stState
        const segments = segmentByTrend(stData)
        stSeriesListRef.current = segments.map(seg => {
          const s = chart.addSeries(LineSeries, {
            color: seg.isUptrend ? '#00e676' : '#ff5252',
            lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
          })
          s.setData(seg.points)
          return { series: s, isUptrend: seg.isUptrend }
        })
        if (stData.length > 0) setStTrend(stData[stData.length - 1].isUptrend ? 1 : -1)
      }

      if (indicators.jma.enabled && candles.length >= indicators.jma.period) {
        const { data: jmaData, state: jmaState } = calcJMA(
          candles, indicators.jma.period, indicators.jma.phase, indicators.jma.power
        )
        jmaStateRef.current = jmaState
        jmaSeriesListRef.current = segmentByTrend(jmaData).map(seg => {
          const s = chart.addSeries(LineSeries, {
            color: seg.isUptrend ? '#00e5ff' : '#ff6e40',
            lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
          })
          s.setData(seg.points)
          return { series: s, isUptrend: seg.isUptrend }
        })
      }

      if (rsiSeries && indicators.rsi.enabled) {
        const rsi = calcRSI(candles, indicators.rsi.period)
        rsiSeries.setData(rsi)
        const lastRsi = rsi[rsi.length - 1]
        if (lastRsi) setRsiValue(lastRsi.value)
      }
    }

    if (onChartReady && chartKey) onChartReady(chartKey, chart, candleSeries)

    return () => {
      if (onChartDestroy && chartKey) onChartDestroy(chartKey)
      chart.remove()
    }
  }, [code, prevPrice, JSON.stringify(buyLevels), tf, JSON.stringify(indicators), candleData])

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

    // RSI 마지막 값만 증분 업데이트
    const rsiCfg = indicatorsRef.current?.rsi
    if (rsiSeriesRef.current && rsiCfg?.enabled && candlesRef.current.length > rsiCfg.period) {
      const rsiData = calcRSI(candlesRef.current, rsiCfg.period)
      const lastRsi = rsiData[rsiData.length - 1]
      if (lastRsi) {
        rsiSeriesRef.current.update(lastRsi)
        setRsiValue(lastRsi.value)
      }
    }

    // SuperTrend 증분 업데이트 — O(1)
    const stCfg = indicatorsRef.current?.supertrend
    if (stSeriesListRef.current.length > 0 && stStateRef.current && stCfg?.enabled) {
      const candles = candlesRef.current
      const st = stStateRef.current
      const last = candles[candles.length - 1]
      const prev = candles.length >= 2 ? candles[candles.length - 2] : last

      const tr = Math.max(
        last.high - last.low,
        Math.abs(last.high - prev.close),
        Math.abs(last.low - prev.close)
      )
      const newAtr = (st.lastAtr * (stCfg.period - 1) + tr) / stCfg.period
      const hl2 = (last.high + last.low) / 2
      const basicUpper = hl2 + stCfg.multiplier * newAtr
      const basicLower = hl2 - stCfg.multiplier * newAtr

      let { upperBand, lowerBand, isUptrend } = st
      upperBand = basicUpper < upperBand || prev.close > upperBand ? basicUpper : upperBand
      lowerBand = basicLower > lowerBand || prev.close < lowerBand ? basicLower : lowerBand

      const wasUp = isUptrend
      isUptrend = wasUp ? last.close >= lowerBand : last.close > upperBand
      const supertrend = isUptrend ? lowerBand : upperBand
      const point = { time: last.time, value: supertrend }
      const lastEntry = stSeriesListRef.current[stSeriesListRef.current.length - 1]

      if (wasUp === isUptrend) {
        lastEntry.series.update(point)
      } else {
        lastEntry.series.update(point)  // 이전 추세선 끝점 연결
        const newSeries = chartRef.current.addSeries(LineSeries, {
          color: isUptrend ? '#00e676' : '#ff5252',
          lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        })
        newSeries.setData([point])
        stSeriesListRef.current.push({ series: newSeries, isUptrend })
      }
      stStateRef.current = { upperBand, lowerBand, isUptrend, supertrend, lastAtr: newAtr, prevClose: last.close }
      setStTrend(isUptrend ? 1 : -1)
    }

    // JMA 증분 업데이트 — O(1)
    const jmaCfg = indicatorsRef.current?.jma
    if (jmaSeriesListRef.current.length > 0 && jmaStateRef.current && jmaCfg?.enabled) {
      const jst = jmaStateRef.current
      const src = candlesRef.current[candlesRef.current.length - 1].close
      const time = candlesRef.current[candlesRef.current.length - 1].time

      const phaseRatio = jmaCfg.phase < -100 ? 0.5 : jmaCfg.phase > 100 ? 2.5 : jmaCfg.phase / 100 + 1.5
      const beta = 0.45 * (jmaCfg.period - 1) / (0.45 * (jmaCfg.period - 1) + 2)
      const alpha = Math.pow(beta, jmaCfg.power)

      jst.e0 = (1 - alpha) * src + alpha * jst.e0
      jst.e1 = (src - jst.e0) * (1 - beta) + beta * jst.e1
      jst.e2 = (jst.e0 + phaseRatio * jst.e1 - jst.prevJMA) * Math.pow(1 - alpha, 2) + Math.pow(alpha, 2) * jst.e2

      const jma = Math.round((jst.e2 + jst.prevJMA) * 10) / 10
      const isUptrend = jma > jst.prevJMA ? true : jma < jst.prevJMA ? false : jst.lastIsUptrend
      const point = { time, value: jma }
      const lastEntry = jmaSeriesListRef.current[jmaSeriesListRef.current.length - 1]

      if (lastEntry.isUptrend === isUptrend) {
        lastEntry.series.update(point)
      } else {
        lastEntry.series.update(point)
        const newSeries = chartRef.current.addSeries(LineSeries, {
          color: isUptrend ? '#00e5ff' : '#ff6e40',
          lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        })
        newSeries.setData([point])
        jmaSeriesListRef.current.push({ series: newSeries, isUptrend })
      }
      jst.prevJMA = jma
      jst.lastIsUptrend = isUptrend
    }
  }, [price, tf])

  const chg = prevPrice > 0 ? ((price - prevPrice) / prevPrice * 100) : 0
  const chgColor = chg >= 0 ? '#ef5350' : '#2962ff'
  const flagColor = { emergency:'#ff0000', crash:'#ff4444', near_limit:'#ffaa00', normal:'#00cc66' }[whipsaw?.flag] || '#333'
  const borderColor = focused ? '#ffcc00' : flagColor
  const isBuyDisabled = whipsaw?.flag === 'near_limit' || whipsaw?.flag === 'emergency'

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
        {whipsaw?.drawdown_pct ? <span style={{ fontSize: 8, color: '#ff8888' }}>↓{whipsaw.drawdown_pct}%</span> : null}
        {indicators.supertrend.enabled && stTrend !== null && (
          <span style={{ fontSize: 10, color: stTrend === 1 ? '#00cc66' : '#ff8800' }}>{stTrend === 1 ? '▲' : '▼'}</span>
        )}
        {indicators.rsi.enabled && rsiValue !== null && (
          <span style={{ fontSize: 8, color: rsiValue >= 70 ? '#ff4444' : rsiValue <= 30 ? '#00cc66' : '#e0aa00' }}>RSI {rsiValue}</span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 3 }} onClick={e => e.stopPropagation()}>
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
  const { regime, beta, war_day, wti, usdkrw, daily_pnl, auto_trading, news_sentiment, pnl_history } = state
  const pnlColor = daily_pnl >= 0 ? '#00cc66' : '#ff4444'
  const rc = { EXTREME_CRISIS:'#ff0000', CRISIS:'#ff2222', CAUTIOUS:'#ffaa00', RECOVERY:'#00cc66', AGGRESSIVE:'#00ff44' }
  return (
    <div style={{ display:'flex', alignItems:'center', gap:14, padding:'3px 12px', background:'#0d0d1a', borderBottom:'1px solid #222', fontSize:11, flexWrap:'wrap', flexShrink:0 }}>
      <span style={{ color: rc[regime] || '#888', fontWeight:'bold' }}>● {regime}</span>
      <span>β <b>{beta?.toFixed(2)}</b></span>
      <span>D+<b>{war_day}</b></span>
      <span>WTI <b>${wti?.toFixed(1)}</b></span>
      <span>환율 <b>{usdkrw?.toFixed(0)}₩</b></span>
      <span style={{ fontSize:10, color: news_sentiment?.startsWith('NEG') ? '#ff6666' : news_sentiment?.startsWith('POS') ? '#66ff99' : '#888' }}>뉴스:{news_sentiment}</span>
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

function SidePanel({ state, panels, focusedIdx, onChangeFocused, onChangePanel, tf, onChangeTF, indicators, onChangeIndicators }) {
  const [sigFilter, setSigFilter] = useState('ALL')
  const signals = state?.signals || []
  const holdings = state?.holdings || []
  const actionColor = { BUY:'#0c6', SELL:'#f44', HOLD:'#888' }
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

      <IndicatorSettings indicators={indicators} onChange={onChangeIndicators} />

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
            <button key={i} onClick={() => onChangeFocused(i)} style={{
              fontSize:8, padding:'1px 4px', cursor:'pointer', borderRadius:2,
              background: i === focusedIdx ? '#1a1500' : '#111',
              color: i === focusedIdx ? '#ffcc00' : '#888',
              border: `1px solid ${i === focusedIdx ? '#665500' : '#333'}`,
            }}>{i+1}.{p.title}</button>
          ))}
        </div>
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

      <div style={{ flex:1, overflow:'auto', padding:'4px 8px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:4 }}>
          <span style={{ fontSize:10, color:'#666' }}>시그널</span>
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
  const [layoutIdx, setLayoutIdx] = useState(2)
  const [panels, setPanels] = useState(makePanels(DEFAULT_CODES))
  const [focusedIdx, setFocusedIdx] = useState(0)
  const [sellConfirm, setSellConfirm] = useState(null)
  const [tf, setTF] = useState('m1')
  const [candleCache, setCandleCache] = useState({})
  const [indicators, setIndicators] = useState({
    supertrend: { enabled: true, period: 10, multiplier: 3 },
    jma: { enabled: false, period: 7, phase: 50, power: 2 },
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

  // fetch 완료 후 setTF → 차트 렌더 시 candleData 항상 존재 (빈 차트 방지)
  const handleChangeTF = useCallback(async (newTF) => {
    if (newTF === tf) return
    if (newTF === 'm1') { setCandleCache({}); setTF('m1'); return }
    const codes = panels.slice(0, visibleCount).map(p => p.code).join(',')
    try {
      const resp = await fetch(`/api/candles_batch?codes=${codes}&tf=${newTF}`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const json = await resp.json()
      if (json.candles && typeof json.candles === 'object') {
        setCandleCache({ [newTF]: json.candles })
        setTF(newTF)
      }
    } catch(e) {
      console.error('TF 전환 실패:', e)
    }
  }, [tf, panels, visibleCount])

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
          if (msg.data.candle_history) window.__CANDLE_HISTORY = msg.data.candle_history
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
              kospi: msg.kospi ?? prev.kospi,
              auto_trading: msg.auto_trading ?? prev.auto_trading,
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

  const handleBuy = useCallback((code, price) => {
    if (!price || price <= 0) return
    const qty = calcQty(code, price)
    send({ cmd: 'buy', code, qty, price })
    playBeep('buy')
  }, [send])

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
        <button onClick={() => setCrosshairSync(v => !v)} title="크로스헤어 동기화 ON/OFF" style={{
          marginLeft:8, fontSize:9, padding:'1px 6px', cursor:'pointer', borderRadius:2,
          background: crosshairSync ? '#002244' : '#111',
          color: crosshairSync ? '#66aaff' : '#555',
          border: `1px solid ${crosshairSync ? '#224488' : '#333'}`,
        }}>⊕{crosshairSync ? 'SYNC' : 'FREE'}</button>
      </div>

      <MacroBar state={state} />
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
            const candleData = tf !== 'm1' ? (candleCache[tf]?.[p.code] ?? null) : null
            return (
              <RealtimeChart
                key={`${p.code}-${idx}`}
                chartKey={`${p.code}-${idx}`}
                code={p.code}
                title={p.title}
                price={p.code === 'KOSPI' ? state?.kospi : state?.prices?.[p.code]}
                prevPrice={PREV_CLOSE[p.code] || (p.code === 'KOSPI' ? (window.__KOSPI_PREV || 5380) : 0)}
                whipsaw={state?.whipsaw_status?.[p.code]}
                buyLevels={state?.buy_levels?.[p.code] ?? window.__BUY_LEVELS?.[p.code]}
                focused={idx === focusedIdx}
                onFocus={() => setFocusedIdx(idx)}
                onBuy={() => handleBuy(p.code, p.code === 'KOSPI' ? state?.kospi : state?.prices?.[p.code])}
                onSell={() => handleSell(p.code, p.title)}
                tf={tf}
                indicators={indicators}
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
          tf={tf}
          onChangeTF={handleChangeTF}
          indicators={indicators}
          onChangeIndicators={setIndicators}
        />
      </div>

      {sellConfirm && (
        <SellConfirmDialog
          code={sellConfirm.code}
          name={sellConfirm.name}
          onConfirm={confirmSell}
          onCancel={() => setSellConfirm(null)}
        />
      )}
    </div>
  )
}
