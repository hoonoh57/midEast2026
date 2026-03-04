#!/usr/bin/env python3
"""
web_server.py — FastAPI 기반 WYSIWYT 웹 트레이딩 서버
war_engine.py의 메인 루프와 동일 프로세스에서 구동
"""

import asyncio
import json
from datetime import datetime
from typing import Dict, Set
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import os

app = FastAPI(title="WAR-ADAPTIVE DASHBOARD", version="2.0")

# ═══════════════════════════════════════════════════════════════
# 1. 연결된 클라이언트 관리 (멀티 디바이스 지원)
# ═══════════════════════════════════════════════════════════════

class ConnectionManager:
    """모든 브라우저 탭/디바이스 동시 수신"""

    def __init__(self):
        self.active: Set[WebSocket] = set()

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.add(ws)

    def disconnect(self, ws: WebSocket):
        self.active.discard(ws)

    async def broadcast(self, data: dict):
        """모든 클라이언트에 실시간 데이터 푸시"""
        msg = json.dumps(data, ensure_ascii=False, default=str)
        dead = []
        for ws in self.active:
            try:
                await ws.send_text(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.active.discard(ws)

manager = ConnectionManager()


# ═══════════════════════════════════════════════════════════════
# 2. 엔진 상태 참조 (war_engine.py와 메모리 공유)
# ═══════════════════════════════════════════════════════════════

# 이 변수들은 war_engine.py의 main()에서 직접 주입
engine_state: Dict = {
    "regime": "CRISIS",
    "beta": 0.5,
    "war_day": 4,
    "wti": 80.0,
    "usdkrw": 1466.0,
    "news_sentiment": "NEUTRAL",
    "prices": {},           # {code: price}
    "holdings": [],         # [{code, name, qty, avg_price, current, pnl, pnl_pct}]
    "signals": [],          # 최근 200건
    "whipsaw_status": {},   # {code: {flag, session_high, current, drawdown_pct}}
    "daily_pnl": 0,
    "phase": "stabilization",
}


# ═══════════════════════════════════════════════════════════════
# 3. WebSocket — 실시간 양방향 통신
# ═══════════════════════════════════════════════════════════════

@app.websocket("/ws/dashboard")
async def ws_dashboard(ws: WebSocket):
    """
    클라이언트 연결 시:
      1) 현재 전체 상태 즉시 전송 (initial snapshot)
      2) 이후 100ms마다 push_loop가 변경분 push
      3) 클라이언트에서 매매 명령 수신
    """
    await manager.connect(ws)

    # 초기 스냅샷
    await ws.send_text(json.dumps({
        "type": "snapshot",
        "data": engine_state,
        "ts": datetime.now().isoformat()
    }, ensure_ascii=False, default=str))

    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            await handle_client_command(msg, ws)
    except WebSocketDisconnect:
        manager.disconnect(ws)


async def handle_client_command(msg: dict, ws: WebSocket):
    """
    브라우저에서 온 명령 처리 — WYSIWYT의 핵심

    지원 명령:
      {"cmd": "buy",  "code": "012450", "price": 1380000, "qty": 5}
      {"cmd": "sell", "code": "012450", "price": 1400000, "qty": 5}
      {"cmd": "market_buy", "code": "012450", "qty": 3}
      {"cmd": "cancel_all"}
      {"cmd": "emergency_sell", "code": "012450"}
      {"cmd": "set_regime", "regime": "CAUTIOUS"}
      {"cmd": "toggle_auto", "enabled": false}
    """
    if engine_ref is None:
        await ws.send_text(json.dumps({"type": "error", "msg": "엔진 미연결"}))
        return

    cmd = msg.get("cmd")

    if cmd == "buy":
        result = engine_ref.api.send_order(
            code=msg["code"],
            order_type=1,
            quantity=msg["qty"],
            price=msg["price"],
            quote_type="00"
        )
        await ws.send_text(json.dumps({
            "type": "order_result", "cmd": "buy",
            "result": result, "ts": datetime.now().isoformat()
        }, ensure_ascii=False, default=str))

    elif cmd == "sell":
        result = engine_ref.api.send_order(
            code=msg["code"],
            order_type=2,
            quantity=msg["qty"],
            price=msg["price"],
            quote_type="00"
        )
        await ws.send_text(json.dumps({
            "type": "order_result", "cmd": "sell",
            "result": result, "ts": datetime.now().isoformat()
        }, ensure_ascii=False, default=str))

    elif cmd == "market_buy":
        result = engine_ref.api.send_order(
            code=msg["code"],
            order_type=1,
            quantity=msg["qty"],
            price=0,
            quote_type="03"
        )
        await ws.send_text(json.dumps({
            "type": "order_result", "cmd": "market_buy", "result": result
        }, ensure_ascii=False, default=str))

    elif cmd == "emergency_sell":
        code = msg["code"]
        holding = next((h for h in engine_state["holdings"]
                        if h.get("code") == code), None)
        if holding:
            result = engine_ref.api.send_order(
                code=code,
                order_type=2,
                quantity=holding["qty"],
                price=0,
                quote_type="03"
            )
            await ws.send_text(json.dumps({
                "type": "order_result", "cmd": "emergency_sell", "result": result
            }, ensure_ascii=False, default=str))

    elif cmd == "cancel_all":
        orders = engine_ref.api.get_outstanding_orders()
        for o in orders:
            engine_ref.api.send_order(
                code=o.get("종목코드", "").strip(),
                order_type=3,
                quantity=0,
                price=0
            )
        await ws.send_text(json.dumps({
            "type": "order_result", "cmd": "cancel_all", "cancelled": len(orders)
        }, ensure_ascii=False, default=str))

    elif cmd == "toggle_auto":
        engine_ref.auto_trading_enabled = msg.get("enabled", True)
        await ws.send_text(json.dumps({
            "type": "config_changed",
            "auto_trading": engine_ref.auto_trading_enabled
        }, ensure_ascii=False, default=str))

    elif cmd == "set_regime":
        engine_ref.chart1.regime = msg["regime"]
        await ws.send_text(json.dumps({
            "type": "config_changed", "regime_override": msg["regime"]
        }, ensure_ascii=False, default=str))


# ═══════════════════════════════════════════════════════════════
# 4. REST API — 초기 로딩, 이력 조회 등
# ═══════════════════════════════════════════════════════════════

@app.get("/api/state")
async def get_full_state():
    return engine_state

@app.get("/api/signals")
async def get_signals(limit: int = 100):
    return engine_state.get("signals", [])[:limit]

@app.get("/api/holdings")
async def get_holdings():
    return engine_state.get("holdings", [])

class ManualOrder(BaseModel):
    code: str
    action: str      # "buy" | "sell"
    qty: int
    price: int
    quote_type: str = "00"

@app.post("/api/order")
async def place_manual_order(order: ManualOrder):
    if engine_ref is None:
        return {"success": False, "error": "엔진 미연결"}
    ot = 1 if order.action == "buy" else 2
    result = engine_ref.api.send_order(
        code=order.code,
        order_type=ot,
        quantity=order.qty,
        price=order.price,
        quote_type=order.quote_type
    )
    return {"success": result.get("Success"), "data": result}


# ═══════════════════════════════════════════════════════════════
# 5. 정적 파일 서빙 (프론트엔드 SPA)
# ═══════════════════════════════════════════════════════════════

_DIST = os.path.join(os.path.dirname(__file__), "frontend", "dist")

if os.path.isdir(_DIST):
    app.mount("/static", StaticFiles(directory=_DIST), name="static")

    @app.get("/")
    async def serve_dashboard():
        return FileResponse(os.path.join(_DIST, "index.html"))
else:
    @app.get("/")
    async def serve_placeholder():
        return {"status": "ok", "msg": "frontend/dist 없음 — npm run build 실행 후 재시작"}


# ═══════════════════════════════════════════════════════════════
# 6. 엔진 → 브라우저 실시간 푸시 (백그라운드 태스크)
# ═══════════════════════════════════════════════════════════════

async def push_loop():
    """100ms 간격으로 변경된 데이터를 모든 브라우저에 push"""
    prev_snapshot = ""

    while True:
        snapshot = json.dumps({
            "type": "update",
            "prices": engine_state["prices"],
            "regime": engine_state["regime"],
            "beta": engine_state["beta"],
            "wti": engine_state["wti"],
            "usdkrw": engine_state["usdkrw"],
            "phase": engine_state["phase"],
            "whipsaw": engine_state["whipsaw_status"],
            "daily_pnl": engine_state["daily_pnl"],
            "ts": datetime.now().isoformat(),
        }, ensure_ascii=False, default=str)

        if snapshot != prev_snapshot:
            await manager.broadcast(json.loads(snapshot))
            prev_snapshot = snapshot

        await asyncio.sleep(0.1)


@app.on_event("startup")
async def startup():
    asyncio.create_task(push_loop())


# ═══════════════════════════════════════════════════════════════
# 7. 엔진 참조 주입 (war_engine.py에서 호출)
# ═══════════════════════════════════════════════════════════════

engine_ref = None

def set_engine_ref(engine):
    global engine_ref
    engine_ref = engine
