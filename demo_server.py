#!/usr/bin/env python3
"""
demo_server.py — server32/키움 없이 웹 대시보드 단독 테스트
더미 시세를 주입하여 UI 동작을 확인합니다.
타임프레임별 캔들 생성 API 포함.

실행: python demo_server.py
접속: http://localhost:5000
"""

import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

import asyncio
import random
import time
import threading
import uvicorn
import math
from datetime import datetime, timezone, timedelta

from web_server import app, engine_state

KST = timezone(timedelta(hours=9))

DEMO_STOCKS = {
    '012450': {'name': '한화에어로스페이스', 'prev': 1432000, 'sector': 'defense'},
    '079550': {'name': 'LIG넥스원',         'prev': 661000,  'sector': 'defense'},
    '272210': {'name': '한화시스템',         'prev': 146700,  'sector': 'defense'},
    '064350': {'name': '현대로템',           'prev': 249000,  'sector': 'defense'},
    '010950': {'name': '에쓰오일',           'prev': 141300,  'sector': 'energy'},
    '096770': {'name': 'SK이노베이션',       'prev': 130000,  'sector': 'energy'},
    '011200': {'name': 'HMM',               'prev': 25750,   'sector': 'energy'},
    '028670': {'name': '팬오션',             'prev': 4800,    'sector': 'energy'},
    '005930': {'name': '삼성전자',           'prev': 195100,  'sector': 'semi'},
    '000660': {'name': 'SK하이닉스',         'prev': 939000,  'sector': 'semi'},
}

BUY_LEVELS = {
    '012450': {'L1': 1380000, 'L2': 1320000, 'L3': 1260000, 'stop': 1200000},
    '079550': {'L1': 640000,  'L2': 610000,  'L3': 580000,  'stop': 550000},
    '272210': {'L1': 141000,  'L2': 135000,  'L3': 129000,  'stop': 123000},
    '064350': {'L1': 240000,  'L2': 230000,  'L3': 220000,  'stop': 210000},
    '010950': {'L1': 136000,  'L2': 130000,  'L3': 124000,  'stop': 118000},
    '096770': {'L1': 125000,  'L2': 120000,  'L3': 115000,  'stop': 110000},
    '011200': {'L1': 24800,   'L2': 23800,   'L3': 22800,   'stop': 21800},
    '028670': {'L1': 4600,    'L2': 4400,    'L3': 4200,    'stop': 4000},
    '005930': {'L1': 190000,  'L2': 185000,  'L3': 180000,  'stop': 175000},
    '000660': {'L1': 910000,  'L2': 880000,  'L3': 850000,  'stop': 820000},
}

KOSPI_PREV_CLOSE = 5380

# 타임프레임 → 초 변환
TF_SECONDS = {
    'm1': 60, 'm3': 180, 'm5': 300, 'm10': 600,
    'm15': 900, 'm60': 3600, 'D': 86400,
}

# 타임프레임별 생성할 캔들 수
TF_BAR_COUNT = {
    'm1': 120, 'm3': 100, 'm5': 80, 'm10': 60,
    'm15': 50, 'm60': 40, 'D': 60,
}


def generate_candles(code: str, tf: str) -> list:
    """특정 종목·타임프레임의 더미 캔들 데이터 생성"""
    info = DEMO_STOCKS.get(code)
    if not info and code != 'KOSPI':
        return []

    prev = info['prev'] if info else KOSPI_PREV_CLOSE
    bar_sec = TF_SECONDS.get(tf, 60)
    count = TF_BAR_COUNT.get(tf, 60)

    now_ts = int(time.time())
    candles = []
    price = prev

    # 변동성: 일봉은 크게, 분봉은 작게
    vol_factor = 0.002 if bar_sec <= 60 else 0.005 if bar_sec <= 600 else 0.01 if bar_sec <= 3600 else 0.025

    for i in range(count, 0, -1):
        bar_time = now_ts - (i * bar_sec)
        bar_time = bar_time - (bar_time % bar_sec)

        change = random.uniform(-vol_factor, vol_factor)
        o = price
        c = int(price * (1 + change))
        spread = max(1, int(price * vol_factor * 0.5))
        h = max(o, c) + random.randint(0, spread)
        l = min(o, c) - random.randint(0, spread)
        l = max(1, l)
        vol = random.randint(50, 500) * (bar_sec // 60 + 1)

        candles.append({
            "time": bar_time,
            "open": o, "high": h, "low": l, "close": c,
            "volume": vol
        })
        price = c

    return candles


# ── REST API: 타임프레임별 캔들 다운로드 ──
from fastapi import Query

@app.get("/api/candles/{code}")
async def get_candles(code: str, tf: str = Query(default="m1")):
    """타임프레임별 캔들 데이터 반환"""
    candles = generate_candles(code, tf)
    return {"code": code, "tf": tf, "candles": candles}

@app.get("/api/candles_batch")
async def get_candles_batch(codes: str = Query(default=""), tf: str = Query(default="m1")):
    """여러 종목 캔들 일괄 반환 (codes=005930,012450,KOSPI)"""
    code_list = [c.strip() for c in codes.split(",") if c.strip()]
    result = {}
    for code in code_list:
        result[code] = generate_candles(code, tf)
    return {"tf": tf, "candles": result}


def tick_price(prev: int) -> int:
    change = random.uniform(-0.08, 0.15)
    unit = 100 if prev > 100000 else 50 if prev > 10000 else 5
    price = int(prev * (1 + change))
    return max(unit, (price // unit) * unit)


def generate_whipsaw_status() -> dict:
    status = {}
    for code, info in DEMO_STOCKS.items():
        if info['sector'] != 'defense':
            continue
        price = engine_state["prices"].get(code, info['prev'])
        high = int(price * random.uniform(1.0, 1.25))
        drawdown = round((price - high) / high * 100, 1) if high > 0 else 0

        if drawdown < -15:
            flag = "emergency"
        elif drawdown < -8:
            flag = "crash"
        elif high > info['prev'] * 1.25:
            flag = "near_limit"
        else:
            flag = "normal"

        status[code] = {
            "name": info['name'], "flag": flag,
            "session_high": high, "current": price,
            "drawdown_pct": drawdown,
            "locked_until": "10:30" if flag in ("crash", "emergency") else None,
        }
    return status


def kst_ts() -> str:
    return datetime.now(KST).strftime("%H:%M:%S")


def demo_loop():
    for code, info in DEMO_STOCKS.items():
        engine_state["prices"][code] = info['prev']

    engine_state["buy_levels"] = BUY_LEVELS
    engine_state["kospi_prev_close"] = KOSPI_PREV_CLOSE

    # 1분봉 시드
    engine_state["candle_history"] = {}
    now_kst = datetime.now(KST)
    now_ts = int(now_kst.timestamp())

    for code, info in DEMO_STOCKS.items():
        candles = []
        price = info['prev']
        for i in range(60, 0, -1):
            bar_time = now_ts - (i * 60)
            bar_time = bar_time - (bar_time % 60)
            change = random.uniform(-0.008, 0.008)
            o = price
            c = int(price * (1 + change))
            h = max(o, c) + random.randint(0, int(price * 0.003))
            l = min(o, c) - random.randint(0, int(price * 0.003))
            vol = random.randint(50, 500)
            candles.append({"time": bar_time, "open": o, "high": h, "low": l, "close": c, "volume": vol})
            price = c
        engine_state["candle_history"][code] = candles
        engine_state["prices"][code] = price

    # KOSPI 시드
    kospi_candles = []
    kp = KOSPI_PREV_CLOSE
    for i in range(60, 0, -1):
        bar_time = now_ts - (i * 60)
        bar_time = bar_time - (bar_time % 60)
        change = random.uniform(-0.002, 0.002)
        o = kp; c = int(kp * (1 + change))
        h = max(o, c) + random.randint(0, 10)
        l = min(o, c) - random.randint(0, 10)
        kospi_candles.append({"time": bar_time, "open": o, "high": h, "low": l, "close": c, "volume": random.randint(1000, 5000)})
        kp = c
    engine_state["candle_history"]["KOSPI"] = kospi_candles

    # PnL 이력
    engine_state["pnl_history"] = []
    cumulative = 0
    for i in range(60, 0, -1):
        t = now_ts - (i * 60)
        t = t - (t % 60)
        cumulative += random.randint(-15000, 10000)
        engine_state["pnl_history"].append({"time": t, "value": cumulative})

    cycle = 0
    while True:
        time.sleep(1)
        cycle += 1

        for code, info in DEMO_STOCKS.items():
            current = engine_state["prices"].get(code, info['prev'])
            jitter = random.uniform(-0.005, 0.005)
            unit = 100 if current > 100000 else 50 if current > 10000 else 5
            new_price = max(unit, int(current * (1 + jitter)))
            new_price = (new_price // unit) * unit
            engine_state["prices"][code] = new_price

        engine_state["regime"] = "CRISIS"
        engine_state["beta"] = 0.5
        engine_state["war_day"] = 4
        engine_state["wti"] = round(80.0 + random.uniform(-0.5, 0.5), 1)
        engine_state["usdkrw"] = round(1466.0 + random.uniform(-2, 2), 0)
        engine_state["news_sentiment"] = random.choice(["NEG", "NEUTRAL", "NEG", "EXTREME_NEG"])
        engine_state["phase"] = "stabilization"
        engine_state["auto_trading"] = True
        engine_state["kospi"] = int(KOSPI_PREV_CLOSE + random.uniform(-50, 50))
        engine_state["whipsaw_status"] = generate_whipsaw_status()

        pnl = random.randint(-500000, 300000)
        engine_state["daily_pnl"] = pnl

        now_sec = int(time.time())
        bar_sec = now_sec - (now_sec % 60)
        hist = engine_state.get("pnl_history", [])
        if hist and hist[-1]["time"] == bar_sec:
            hist[-1]["value"] = pnl
        else:
            hist.append({"time": bar_sec, "value": pnl})
            if len(hist) > 300:
                engine_state["pnl_history"] = hist[-300:]

        if cycle % 10 == 0:
            stock = random.choice(list(DEMO_STOCKS.items()))
            code, info = stock
            price = engine_state["prices"].get(code, info['prev'])
            signal = {
                "ts": kst_ts(),
                "action": random.choice(["BUY", "SELL", "HOLD"]),
                "name": info['name'], "price": price,
                "qty": random.randint(1, 5),
                "chart": random.choice(["DEFENSE", "ENERGY", "SEMI", "MACRO"]),
                "confidence": round(random.uniform(0.4, 0.95), 2),
                "reason": random.choice([
                    "VWAP 상향돌파 + RSI 반등", "요동장 안정화 진입",
                    "볼린저 하단 터치", "긴급매도 트리거",
                    "분할매수 L2 도달", "MACD 골든크로스",
                    "SuperTrend 매수 전환", "RSI 과매도 반등",
                ]),
            }
            engine_state["signals"].insert(0, signal)
            if len(engine_state["signals"]) > 200:
                engine_state["signals"] = engine_state["signals"][:200]

        if cycle == 1:
            engine_state["holdings"] = [
                {"code": "005930", "name": "삼성전자", "qty": 10,
                 "avg_price": 190000, "current": engine_state["prices"].get("005930", 190000),
                 "pnl": 0, "pnl_pct": 0},
                {"code": "012450", "name": "한화에어로", "qty": 2,
                 "avg_price": 1380000, "current": engine_state["prices"].get("012450", 1380000),
                 "pnl": 0, "pnl_pct": 0},
            ]
        else:
            for h in engine_state["holdings"]:
                cur = engine_state["prices"].get(h["code"], h["avg_price"])
                h["current"] = cur
                h["pnl"] = (cur - h["avg_price"]) * h["qty"]
                h["pnl_pct"] = round((cur - h["avg_price"]) / h["avg_price"] * 100, 2)


if __name__ == "__main__":
    print("=" * 60)
    print("  WAR-ADAPTIVE DASHBOARD — DEMO MODE")
    print("  http://localhost:5000")
    print("=" * 60)

    t = threading.Thread(target=demo_loop, daemon=True)
    t.start()
    uvicorn.run(app, host="0.0.0.0", port=5000, log_level="info")
