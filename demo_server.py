#!/usr/bin/env python3
"""
demo_server.py — server32/키움 없이 웹 대시보드 단독 테스트
더미 시세를 주입하여 UI 동작을 확인합니다.

실행: python demo_server.py
접속: http://localhost:5000
"""

import asyncio
import random
import time
import threading
import uvicorn
from datetime import datetime

# web_server.py에서 app과 engine_state를 가져옴
from web_server import app, engine_state

# ═══════════════════════════════════════════════════════════════
# 더미 종목 데이터 (war_engine.py의 TARGETS와 동일)
# ═══════════════════════════════════════════════════════════════

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


def tick_price(prev: int) -> int:
    """전일가 기준 ±15% 범위 내 랜덤 등락"""
    change = random.uniform(-0.08, 0.15)
    unit = 100 if prev > 100000 else 50 if prev > 10000 else 5
    price = int(prev * (1 + change))
    return max(unit, (price // unit) * unit)


def generate_whipsaw_status() -> dict:
    """방산주에 대한 요동장 상태 더미 생성"""
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
            "name": info['name'],
            "flag": flag,
            "session_high": high,
            "current": price,
            "drawdown_pct": drawdown,
            "locked_until": "10:30" if flag in ("crash", "emergency") else None,
        }
    return status


def demo_loop():
    """1초마다 더미 시세 + 상태 업데이트"""
    import math

    # 초기 가격 설정
    for code, info in DEMO_STOCKS.items():
        engine_state["prices"][code] = info['prev']

    # ── 과거 1분봉 시드 데이터 생성 (최근 60분) ──
    engine_state["candle_history"] = {}
    now_ts = int(time.time())
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
    kp = 5432
    for i in range(60, 0, -1):
        bar_time = now_ts - (i * 60)
        bar_time = bar_time - (bar_time % 60)
        change = random.uniform(-0.002, 0.002)
        o = kp
        c = int(kp * (1 + change))
        h = max(o, c) + random.randint(0, 10)
        l = min(o, c) - random.randint(0, 10)
        kospi_candles.append({"time": bar_time, "open": o, "high": h, "low": l, "close": c, "volume": random.randint(1000, 5000)})
        kp = c
    engine_state["candle_history"]["KOSPI"] = kospi_candles

    cycle = 0
    while True:
        time.sleep(1)
        cycle += 1

        # ── 가격 업데이트 ──
        for code, info in DEMO_STOCKS.items():
            current = engine_state["prices"].get(code, info['prev'])
            jitter = random.uniform(-0.005, 0.005)
            unit = 100 if current > 100000 else 50 if current > 10000 else 5
            new_price = max(unit, int(current * (1 + jitter)))
            new_price = (new_price // unit) * unit
            engine_state["prices"][code] = new_price

        # ── 매크로 상태 ──
        engine_state["regime"] = "CRISIS"
        engine_state["beta"] = 0.5
        engine_state["war_day"] = 4
        engine_state["wti"] = round(80.0 + random.uniform(-0.5, 0.5), 1)
        engine_state["usdkrw"] = round(1466.0 + random.uniform(-2, 2), 0)
        engine_state["news_sentiment"] = random.choice(["NEG", "NEUTRAL", "NEG", "EXTREME_NEG"])
        engine_state["phase"] = "stabilization"
        engine_state["auto_trading"] = True
        engine_state["kospi"] = int(5432 + random.uniform(-50, 50))

        # ── 요동장 상태 ──
        engine_state["whipsaw_status"] = generate_whipsaw_status()

        # ── PnL ──
        engine_state["daily_pnl"] = random.randint(-500000, 300000)

        # ── 더미 시그널 (10초마다 1개) ──
        if cycle % 10 == 0:
            stock = random.choice(list(DEMO_STOCKS.items()))
            code, info = stock
            price = engine_state["prices"].get(code, info['prev'])
            signal = {
                "action": random.choice(["BUY", "SELL", "HOLD"]),
                "name": info['name'],
                "price": price,
                "qty": random.randint(1, 5),
                "chart": random.choice(["DEFENSE", "ENERGY", "SEMI", "MACRO"]),
                "confidence": round(random.uniform(0.4, 0.95), 2),
                "reason": random.choice([
                    "VWAP 상향돌파 + RSI 반등",
                    "요동장 안정화 진입",
                    "볼린저 하단 터치",
                    "긴급매도 트리거",
                    "분할매수 L2 도달",
                    "MACD 골든크로스",
                    "갭업 추격 금지 → HOLD",
                ]),
            }
            engine_state["signals"].insert(0, signal)
            if len(engine_state["signals"]) > 200:
                engine_state["signals"] = engine_state["signals"][:200]

        # ── 더미 보유종목 ──
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
    print("  server32/키움 연결 없이 더미 데이터로 실행")
    print("  http://localhost:5000 에서 대시보드 확인")
    print("=" * 60)

    # 더미 데이터 생성 스레드
    t = threading.Thread(target=demo_loop, daemon=True)
    t.start()

    # FastAPI 서버 기동
    uvicorn.run(app, host="0.0.0.0", port=5000, log_level="info")
