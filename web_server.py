#!/usr/bin/env python3
"""
web_server.py — FastAPI 기반 WYSIWYT 웹 트레이딩 서버 v3.1
타임프레임 캔들 API, 지표 데이터 지원
"""

import asyncio
import json
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Dict, Set
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import os
import requests
from pathlib import Path


@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(push_loop())
    yield

app = FastAPI(title="WAR-ADAPTIVE DASHBOARD", version="3.1", lifespan=lifespan)

_DEFAULT_THEME_CODES = ["KOSPI", "005930", "000660", "012450", "079550", "010950", "096770", "272210", "064350"]
_THEMES_PATH = Path(__file__).resolve().parent / "themes.json"
_DEFAULT_THEME_NOTES = {
    "KOSPI": {"description": "한국 증시 대표 지수", "trade_focus": "시장 방향 확인", "risk_note": "지수 급락시 개별주 추격 금지"},
    "005930": {"description": "반도체 대형주 대표", "trade_focus": "지수 대비 역행 강세 확인", "risk_note": "대형주라 탄력 둔화 빠름"},
    "000660": {"description": "반도체 고베타 대형주", "trade_focus": "강한 추세 전환만 대응", "risk_note": "장 막판 변동성 확대 주의"},
    "012450": {"description": "방산 대장", "trade_focus": "지수 약세 속 상대강도 추종", "risk_note": "급등 후 눌림 없는 추격 금지"},
    "079550": {"description": "방산 핵심주", "trade_focus": "VWAP 회복과 동시 진입", "risk_note": "뉴스 민감도 높음"},
    "010950": {"description": "정유 대표주", "trade_focus": "유가 급등시 단기 탄력 확인", "risk_note": "서킷브레이크/급변동 주의"},
    "096770": {"description": "정유/에너지 민감주", "trade_focus": "강한 거래대금 동반 구간만", "risk_note": "반락 속도 빠름"},
    "272210": {"description": "방산/시스템", "trade_focus": "후발 반등 확인", "risk_note": "대장주 대비 탄력 약할 수 있음"},
    "064350": {"description": "방산/철도 수급주", "trade_focus": "상대강도 상위일 때만", "risk_note": "시세 끊김 주의"},
}


class ConnectionManager:
    def __init__(self):
        self.active: Set[WebSocket] = set()

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.add(ws)

    def disconnect(self, ws: WebSocket):
        self.active.discard(ws)

    async def broadcast(self, data: dict):
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

DEFAULT_TRADE_CONFIG = {
    "total_budget": 5000000,
    "per_stock": 1000000,
    "strategies": {
        "macro": True,
        "defense": True,
        "energy": True,
        "semi": True,
    },
}


def _copy_trade_config(config: dict | None = None) -> dict:
    source = config or DEFAULT_TRADE_CONFIG
    return {
        "total_budget": int(source.get("total_budget", DEFAULT_TRADE_CONFIG["total_budget"])),
        "per_stock": int(source.get("per_stock", DEFAULT_TRADE_CONFIG["per_stock"])),
        "strategies": dict(source.get("strategies", DEFAULT_TRADE_CONFIG["strategies"])),
    }


engine_state: Dict = {
    "regime": "CRISIS",
    "beta": 0.5,
    "war_day": 4,
    "wti": 80.0,
    "usdkrw": 1466.0,
    "news_sentiment": "NEUTRAL",
    "prices": {},
    "holdings": [],
    "signals": [],
    "trade_logs": [],
    "whipsaw_status": {},
    "daily_pnl": 0,
    "phase": "stabilization",
    "kospi": 0,
    "auto_trading": False,
    "trade_config": _copy_trade_config(),
    "candle_history": {},
    "buy_levels": {},
    "prev_closes": {},
    "position_overlays": {},
    "hoga_analysis": {},
    "manual_signals": [],
    "data_health": {"status": "unknown", "reason": "초기화중"},
    "data_readiness": {"ready": False, "status": "unknown", "reason": "캔들 준비 대기중"},
    "kospi_prev_close": 0,
    "pnl_history": [],
    "account_no": "",
    "orderable_cash": 0,
}


def _normalize_trade_config(msg: dict) -> dict:
    strategies = dict(DEFAULT_TRADE_CONFIG["strategies"])
    strategies.update(msg.get("strategies", {}))
    return {
        "total_budget": int(msg.get("total_budget", DEFAULT_TRADE_CONFIG["total_budget"])),
        "per_stock": int(msg.get("per_stock", DEFAULT_TRADE_CONFIG["per_stock"])),
        "strategies": {key: bool(value) for key, value in strategies.items()},
    }


def _set_engine_regime(regime_name: str) -> str:
    if engine_ref is None:
        return regime_name

    current_regime = getattr(engine_ref.chart1, "regime", None)
    enum_cls = current_regime.__class__ if current_regime is not None else None
    if enum_cls is None:
        return regime_name

    normalized = str(regime_name).upper()
    try:
        new_regime = enum_cls[normalized]
    except Exception:
        try:
            new_regime = enum_cls(normalized)
        except Exception as exc:
            raise ValueError(f"invalid regime: {regime_name}") from exc

    engine_ref.chart1.regime = new_regime
    return getattr(new_regime, "value", normalized)


def _default_theme_item(code: str) -> dict:
    meta = _DEFAULT_THEME_NOTES.get(code, {})
    return {
        "code": code,
        "enabled": True,
        "description": meta.get("description", ""),
        "trade_focus": meta.get("trade_focus", ""),
        "risk_note": meta.get("risk_note", ""),
    }


def _default_themes() -> list[dict]:
    return [{"name": "IranWar", "items": [_default_theme_item(code) for code in _DEFAULT_THEME_CODES]}]


def _normalize_theme_payload(payload: dict) -> dict:
    name = str(payload.get("name", "")).strip()
    seen_codes = set()
    items = []
    raw_items = payload.get("items")
    if not isinstance(raw_items, list):
        raw_items = [{"code": code} for code in payload.get("codes", [])]
    for raw in raw_items:
        code = str((raw or {}).get("code", "")).strip()
        if not code or code in seen_codes:
            continue
        seen_codes.add(code)
        base = _default_theme_item(code)
        items.append({
            "code": code,
            "enabled": bool((raw or {}).get("enabled", True)),
            "description": str((raw or {}).get("description", base["description"])).strip(),
            "trade_focus": str((raw or {}).get("trade_focus", base["trade_focus"])).strip(),
            "risk_note": str((raw or {}).get("risk_note", base["risk_note"])).strip(),
        })
    if not name:
        raise ValueError("테마명은 필수입니다")
    if not items:
        raise ValueError("테마 종목은 1개 이상이어야 합니다")
    return {"name": name, "codes": [item["code"] for item in items], "items": items}


def _load_themes() -> list[dict]:
    if not _THEMES_PATH.exists():
        themes = _default_themes()
        _THEMES_PATH.write_text(json.dumps(themes, ensure_ascii=False, indent=2), encoding="utf-8")
        return themes
    try:
        raw = json.loads(_THEMES_PATH.read_text(encoding="utf-8"))
        themes = []
        for item in raw if isinstance(raw, list) else []:
            try:
                themes.append(_normalize_theme_payload(item))
            except Exception:
                continue
        return themes or _default_themes()
    except Exception:
        return _default_themes()


def _save_themes(themes: list[dict]):
    normalized = [_normalize_theme_payload(item) for item in themes]
    _THEMES_PATH.write_text(json.dumps(normalized, ensure_ascii=False, indent=2), encoding="utf-8")


def _auto_trade_gate() -> tuple[bool, str, dict, dict]:
    health = engine_state.get("data_health", {}) or {}
    readiness = engine_state.get("data_readiness", {}) or {}
    if engine_ref is not None:
        if hasattr(engine_ref, "assess_data_health"):
            health = engine_ref.assess_data_health() or health
        if hasattr(engine_ref, "assess_data_readiness"):
            readiness = engine_ref.assess_data_readiness() or readiness
    engine_state["data_health"] = health
    engine_state["data_readiness"] = readiness

    if health.get("status") != "ok":
        return False, f"자동매매 차단: {health.get('reason', '데이터 이상')}", health, readiness
    if not readiness.get("ready", False):
        return False, f"자동매매 차단: {readiness.get('reason', '캔들 준비 미완료')}", health, readiness
    return True, "", health, readiness


@app.websocket("/ws/dashboard")
async def ws_dashboard(ws: WebSocket):
    await manager.connect(ws)
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


async def _refresh_after_manual_order(code: str, action: str, qty: int, price: int, result: dict):
    if engine_ref is None:
        return
    ok = result.get("Success") or result.get("success")
    if not ok:
        return

    target = engine_ref.targets.get(code) if hasattr(engine_ref, "targets") else None
    engine_ref.record_trade_event({
        "kind": "order_submit",
        "source": "manual",
        "action": action,
        "code": code,
        "name": getattr(target, "name", code),
        "qty": qty,
        "price": price,
        "chart": "MANUAL",
        "reason": f"수동 {action} 주문",
        "status": "accepted" if ok else "failed",
        "message": result.get("Message", ""),
        "stop_loss": int(price * (1 + getattr(target, "stop_loss_pct", -0.08))) if price else 0,
        "take_profit": int(getattr(target, "target_price", 0) or 0),
    })
    manual_signal = {
        "code": code,
        "name": getattr(target, "name", code),
        "action": action,
        "price": price,
        "qty": qty,
        "reason": f"수동 {action} 주문 체결 대기",
        "ts": datetime.now().isoformat(),
        "stop_loss": int(price * (1 + getattr(target, "stop_loss_pct", -0.08))) if price else 0,
        "take_profit": int(getattr(target, "target_price", 0) or 0),
        "marker_time": int(datetime.now().timestamp()) // 60 * 60,
        "manual": True,
    }

    for attempt in range(5):
        holdings = engine_ref.refresh_web_state(manual_signal=manual_signal if attempt == 0 else None)
        if action == "SELL":
            holding = next((h for h in holdings if h.get("종목코드", "").strip() == code), None)
            if holding is None or int(holding.get("보유수량", "0") or 0) <= 0:
                break
        else:
            holding = next((h for h in holdings if h.get("종목코드", "").strip() == code), None)
            if holding and int(holding.get("보유수량", "0") or 0) > 0:
                break
        await asyncio.sleep(0.4)


async def handle_client_command(msg: dict, ws: WebSocket):
    if engine_ref is None:
        await ws.send_text(json.dumps({"type": "error", "msg": "엔진 미연결"}))
        return

    cmd = msg.get("cmd")
    if cmd == "buy":
        ok, reason = _can_submit_order(msg["code"], "BUY", int(msg["qty"]), int(msg["price"]))
        if not ok:
            await ws.send_text(json.dumps({"type": "error", "msg": reason}, ensure_ascii=False, default=str))
            return
        result = engine_ref.api.send_order(code=msg["code"], order_type=1, quantity=msg["qty"], price=msg["price"], quote_type="00")
        if result.get("Success") or result.get("success"):
            _mark_order_submitted(msg["code"], "BUY")
        await _refresh_after_manual_order(msg["code"], "BUY", msg["qty"], msg["price"], result)
        await ws.send_text(json.dumps({
            "type": "order_result", "cmd": "buy", "code": msg["code"], "qty": msg["qty"], "price": msg["price"],
            "result": result, "ts": datetime.now().isoformat()
        }, ensure_ascii=False, default=str))
    elif cmd == "sell":
        ok, reason = _can_submit_order(msg["code"], "SELL", int(msg["qty"]), int(msg["price"]))
        if not ok:
            await ws.send_text(json.dumps({"type": "error", "msg": reason}, ensure_ascii=False, default=str))
            return
        result = engine_ref.api.send_order(code=msg["code"], order_type=2, quantity=msg["qty"], price=msg["price"], quote_type="00")
        if result.get("Success") or result.get("success"):
            _mark_order_submitted(msg["code"], "SELL")
        await _refresh_after_manual_order(msg["code"], "SELL", msg["qty"], msg["price"], result)
        await ws.send_text(json.dumps({
            "type": "order_result", "cmd": "sell", "code": msg["code"], "qty": msg["qty"], "price": msg["price"],
            "result": result, "ts": datetime.now().isoformat()
        }, ensure_ascii=False, default=str))
    elif cmd == "market_buy":
        ok, reason = _can_submit_order(msg["code"], "BUY", int(msg["qty"]), 0)
        if not ok:
            await ws.send_text(json.dumps({"type": "error", "msg": reason}, ensure_ascii=False, default=str))
            return
        result = engine_ref.api.send_order(code=msg["code"], order_type=1, quantity=msg["qty"], price=0, quote_type="03")
        if result.get("Success") or result.get("success"):
            _mark_order_submitted(msg["code"], "BUY")
        await _refresh_after_manual_order(msg["code"], "BUY", msg["qty"], msg.get("price", 0), result)
        await ws.send_text(json.dumps({
            "type": "order_result", "cmd": "market_buy", "code": msg["code"], "qty": msg["qty"], "price": 0,
            "result": result, "ts": datetime.now().isoformat()
        }, ensure_ascii=False, default=str))
    elif cmd == "emergency_sell":
        code = msg["code"]
        holding = next((h for h in engine_state["holdings"] if h.get("code") == code), None)
        if holding:
            ok, reason = _can_submit_order(code, "SELL", int(holding["qty"]), 0)
            if not ok:
                await ws.send_text(json.dumps({"type": "error", "msg": reason}, ensure_ascii=False, default=str))
                return
            result = engine_ref.api.send_order(code=code, order_type=2, quantity=holding["qty"], price=0, quote_type="03")
            if result.get("Success") or result.get("success"):
                _mark_order_submitted(code, "SELL")
            await _refresh_after_manual_order(code, "SELL", holding["qty"], 0, result)
            await ws.send_text(json.dumps({
                "type": "order_result", "cmd": "emergency_sell", "code": code, "qty": holding["qty"], "price": 0,
                "result": result, "ts": datetime.now().isoformat()
            }, ensure_ascii=False, default=str))
    elif cmd == "cancel_all":
        orders = engine_ref.api.get_outstanding_orders()
        for o in orders:
            engine_ref.api.send_order(code=o.get("종목코드", "").strip(), order_type=3, quantity=0, price=0)
        await ws.send_text(json.dumps({"type": "order_result", "cmd": "cancel_all", "cancelled": len(orders)}, ensure_ascii=False, default=str))
    elif cmd == "toggle_auto":
        enabled = bool(msg.get("enabled", True))
        if enabled:
            ok, reason, health, readiness = _auto_trade_gate()
            if not ok:
                if engine_ref is not None:
                    engine_ref.auto_trading_enabled = False
                engine_state["auto_trading"] = False
                await ws.send_text(json.dumps({"type": "error", "msg": reason}, ensure_ascii=False, default=str))
                await manager.broadcast({
                    "type": "config_changed",
                    "auto_trading": False,
                    "data_health": health,
                    "data_readiness": readiness,
                })
                return
        if engine_ref is not None:
            engine_ref.auto_trading_enabled = enabled
        engine_state["auto_trading"] = enabled
        await manager.broadcast({
            "type": "config_changed",
            "auto_trading": enabled,
            "data_health": engine_state.get("data_health", {}),
            "data_readiness": engine_state.get("data_readiness", {}),
        })
    elif cmd == "set_regime":
        try:
            regime_value = _set_engine_regime(msg["regime"])
        except ValueError:
            await ws.send_text(json.dumps({"type": "error", "msg": f"잘못된 regime: {msg.get('regime')}"}, ensure_ascii=False, default=str))
            return
        engine_state["regime"] = regime_value
        engine_state["regime_override"] = regime_value
        await manager.broadcast({"type": "config_changed", "regime": regime_value, "regime_override": regime_value})
    elif cmd == "set_config":
        config = _normalize_trade_config(msg)
        engine_state["trade_config"] = config
        if engine_ref is not None:
            engine_ref.trade_config = config
        await manager.broadcast({"type": "config_changed", "trade_config": config})


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
    action: str
    qty: int
    price: int
    quote_type: str = "00"


class ThemePayload(BaseModel):
    name: str
    codes: list[str] = []
    items: list[dict] = []


def _theme_payload_dict(payload: ThemePayload) -> dict:
    return payload.model_dump() if hasattr(payload, "model_dump") else payload.dict()

@app.post("/api/order")
async def place_manual_order(order: ManualOrder):
    if engine_ref is None:
        return {"success": False, "error": "엔진 미연결"}
    ot = 1 if order.action == "buy" else 2
    result = engine_ref.api.send_order(code=order.code, order_type=ot, quantity=order.qty, price=order.price, quote_type=order.quote_type)
    return {"success": result.get("Success"), "data": result}


@app.get("/api/themes")
async def get_themes():
    return {"themes": _load_themes()}


@app.post("/api/themes")
async def create_theme(payload: ThemePayload):
    themes = _load_themes()
    normalized = _normalize_theme_payload(_theme_payload_dict(payload))
    if any(item["name"].lower() == normalized["name"].lower() for item in themes):
        return {"success": False, "error": "이미 존재하는 테마명입니다"}
    themes.append(normalized)
    _save_themes(themes)
    return {"success": True, "themes": themes}


@app.put("/api/themes/{theme_name}")
async def update_theme(theme_name: str, payload: ThemePayload):
    themes = _load_themes()
    normalized = _normalize_theme_payload(_theme_payload_dict(payload))
    updated = False
    for idx, item in enumerate(themes):
        if item["name"] == theme_name:
            themes[idx] = normalized
            updated = True
            break
    if not updated:
        return {"success": False, "error": "테마를 찾을 수 없습니다"}
    _save_themes(themes)
    return {"success": True, "themes": themes}


@app.delete("/api/themes/{theme_name}")
async def delete_theme(theme_name: str):
    themes = _load_themes()
    filtered = [item for item in themes if item["name"] != theme_name]
    if len(filtered) == len(themes):
        return {"success": False, "error": "테마를 찾을 수 없습니다"}
    if not filtered:
        filtered = _default_themes()
    _save_themes(filtered)
    return {"success": True, "themes": filtered}


# ── 캔들 API (server32 프록시 + 1분봉 메모리 캐시) ──

SERVER32_BASE = os.getenv('SERVER_BASE', 'http://localhost:8082')

# server32 분봉/일봉 → lightweight-charts unix timestamp 변환
def _kiwoom_candles_to_lw(raw_candles: list, tf: str) -> list:
    """키움 캔들(한국어 키) → {time, open, high, low, close, volume}"""
    result = []
    for c in raw_candles:
        if tf == 'D':
            date_str = str(c.get('일자', ''))
            if len(date_str) < 8: continue
            # 일봉: YYYY-MM-DD 형식 (lightweight-charts business day)
            t = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
        else:
            ts_str = str(c.get('체결시간', ''))
            if len(ts_str) < 14: continue
            dt = datetime(int(ts_str[:4]), int(ts_str[4:6]), int(ts_str[6:8]),
                          int(ts_str[8:10]), int(ts_str[10:12]), int(ts_str[12:14]))
            # 서버 시각 문자열을 그대로 epoch로 변환한다. 추가 오프셋 보정은 하지 않는다.
            t = int(dt.timestamp())
        def _price(v):
            f = abs(float(v or 0))
            return f if f != int(f) else int(f)  # 지수(소수점) vs 종목(정수)
        result.append({
            "time": t,
            "open": _price(c.get('시가', 0)),
            "high": _price(c.get('고가', 0)),
            "low": _price(c.get('저가', 0)),
            "close": _price(c.get('현재가', 0)),
            "volume": abs(int(float(c.get('거래량', 0)))),
        })
    # 오래된 순 정렬
    result.sort(key=lambda x: x['time'] if isinstance(x['time'], int) else x['time'])
    return result

# TF → server32 tick 매핑
_TF_TICK = {'m1': 1, 'm3': 3, 'm5': 5, 'm10': 10, 'm15': 15, 'm60': 60}

# TF별 충분한 캔들을 확보하기 위한 조회 기간 (일)
_TF_LOOKBACK_DAYS = {'m1': 5, 'm3': 10, 'm5': 15, 'm10': 30, 'm15': 45, 'm60': 120}
_MIN_M1_HISTORY = 30

def _aggregate_candles(m1_candles: list, tf: str) -> list:
    """1분봉 → 상위 TF 집계 (KOSPI 등 server32 미지원 종목용)"""
    bar_sec = {'m1': 60, 'm3': 180, 'm5': 300, 'm10': 600, 'm15': 900, 'm60': 3600, 'D': 86400}.get(tf, 60)
    if bar_sec <= 60:
        return m1_candles

    buckets = {}
    for c in m1_candles:
        t = c['time']
        bucket = t - (t % bar_sec)
        if bucket not in buckets:
            buckets[bucket] = {'time': bucket, 'open': c['open'], 'high': c['high'],
                               'low': c['low'], 'close': c['close'], 'volume': c['volume']}
        else:
            b = buckets[bucket]
            b['high'] = max(b['high'], c['high'])
            b['low'] = min(b['low'], c['low'])
            b['close'] = c['close']
            b['volume'] = b['volume'] + c['volume']
    result = list(buckets.values())
    result.sort(key=lambda x: x['time'])
    return result


def _merge_candles(history: list, live: list) -> list:
    """과거 히스토리와 실시간 누적봉을 time 기준으로 병합한다."""
    merged = {}
    for candle in history or []:
        merged[candle["time"]] = candle
    for candle in live or []:
        merged[candle["time"]] = candle
    result = list(merged.values())
    result.sort(key=lambda x: x["time"])
    return result

def _fetch_candles_from_server32(code: str, tf: str) -> list:
    """server32에서 캔들 데이터 조회"""
    try:
        if tf == 'D':
            today = datetime.now().strftime('%Y%m%d')
            stop = (datetime.now() - timedelta(days=365)).strftime('%Y%m%d')
            r = requests.get(f"{SERVER32_BASE}/api/market/candles/daily",
                             params={'code': code, 'date': today, 'stopDate': stop}, timeout=15)
        else:
            tick = _TF_TICK.get(tf, 1)
            lookback = _TF_LOOKBACK_DAYS.get(tf, 5)
            stop_time = (datetime.now() - timedelta(days=lookback)).strftime('%Y%m%d090000')
            r = requests.get(f"{SERVER32_BASE}/api/market/candles/minute",
                             params={'code': code, 'tick': str(tick), 'stopTime': stop_time}, timeout=15)
        data = r.json()
        if data.get('Success') and data.get('Data'):
            return _kiwoom_candles_to_lw(data['Data'], tf)
    except Exception as e:
        print(f"[web_server] candle fetch error: {code}/{tf}: {e}")
    return []


# 프론트엔드 코드 → server32 코드 매핑 (지수 등)
_CODE_MAP = {'KOSPI': 'U001'}

def _get_candles_for_code(code: str, tf: str) -> list:
    """종목별 캔들 조회 (KOSPI→U001 매핑 포함)"""
    candle_hist = engine_state.get("candle_history", {})
    live_m1 = candle_hist.get(code, [])

    # server32 조회 (KOSPI→U001 등 코드 매핑)
    server_code = _CODE_MAP.get(code, code)
    fetched = _fetch_candles_from_server32(server_code, tf)

    if tf == 'm1':
        # 실시간 누적분만 있으면 과거봉이 비어 보일 수 있어 server32 히스토리와 병합한다.
        if live_m1 and len(live_m1) < _MIN_M1_HISTORY:
            return _merge_candles(fetched, live_m1)
        return live_m1 or fetched

    if fetched:
        return fetched

    # server32 조회 실패 시 메모리 1분봉을 상위 TF로 집계해 fallback 한다.
    if live_m1:
        return _aggregate_candles(live_m1, tf)
    return []


@app.get("/api/candles/{code}")
async def get_candles(code: str, tf: str = Query(default="m1")):
    """타임프레임별 캔들 데이터 반환"""
    candles = _get_candles_for_code(code, tf)
    return {"code": code, "tf": tf, "candles": candles}


@app.get("/api/candles_batch")
async def get_candles_batch(codes: str = Query(default=""), tf: str = Query(default="m1")):
    """여러 종목 캔들 일괄 반환"""
    code_list = [c.strip() for c in codes.split(",") if c.strip()]
    result = {}
    for code in code_list:
        result[code] = _get_candles_for_code(code, tf)
    return {"tf": tf, "candles": result}


_DIST = os.path.join(os.path.dirname(__file__), "frontend", "dist")

if os.path.isdir(_DIST):
    @app.get("/")
    async def serve_dashboard():
        return FileResponse(os.path.join(_DIST, "index.html"))
    app.mount("/", StaticFiles(directory=_DIST), name="static")
else:
    @app.get("/")
    async def serve_placeholder():
        return {"status": "ok", "msg": "frontend/dist 없음 — npm run build 실행 후 재시작"}


async def push_loop():
    prev_snapshot = ""
    while True:
        snapshot = json.dumps({
            "type": "update",
            "prices": engine_state["prices"],
            "regime": engine_state["regime"],
            "beta": engine_state["beta"],
            "war_day": engine_state.get("war_day", 4),
            "wti": engine_state["wti"],
            "usdkrw": engine_state["usdkrw"],
            "news_sentiment": engine_state.get("news_sentiment", "NEUTRAL"),
            "phase": engine_state["phase"],
            "whipsaw_status": engine_state["whipsaw_status"],
            "daily_pnl": engine_state["daily_pnl"],
            "holdings": engine_state["holdings"],
            "signals": engine_state["signals"],
            "trade_logs": engine_state.get("trade_logs", []),
            "buy_levels": engine_state.get("buy_levels", {}),
            "prev_closes": engine_state.get("prev_closes", {}),
            "position_overlays": engine_state.get("position_overlays", {}),
            "hoga_analysis": engine_state.get("hoga_analysis", {}),
            "data_health": engine_state.get("data_health", {}),
            "data_readiness": engine_state.get("data_readiness", {}),
            "kospi": engine_state.get("kospi", 0),
            "auto_trading": engine_state.get("auto_trading", True),
            "account_no": engine_state.get("account_no", ""),
            "orderable_cash": engine_state.get("orderable_cash", 0),
            "trade_config": engine_state.get("trade_config", _copy_trade_config()),
            "pnl_history": engine_state.get("pnl_history", []),
            "ts": datetime.now().isoformat(),
        }, ensure_ascii=False, default=str)

        if snapshot != prev_snapshot:
            await manager.broadcast(json.loads(snapshot))
            prev_snapshot = snapshot

        await asyncio.sleep(0.1)


engine_ref = None
_ORDER_GUARD = {"recent": {}}


def _order_guard_key(code: str, action: str) -> str:
    return f"{code}:{action}"


def _can_submit_order(code: str, action: str, qty: int, price: int) -> tuple[bool, str]:
    if not code:
        return False, "종목코드가 없습니다"
    if qty <= 0:
        return False, "주문수량이 0 이하입니다"
    if action == "BUY" and price < 0:
        return False, "매수가격이 잘못되었습니다"

    key = _order_guard_key(code, action)
    now = time.time()
    recent = _ORDER_GUARD["recent"].get(key)
    if recent and now - recent < 3.0:
        return False, f"{code} {action} 주문 쿨다운 3초"
    return True, ""


def _mark_order_submitted(code: str, action: str):
    _ORDER_GUARD["recent"][_order_guard_key(code, action)] = time.time()

def set_engine_ref(engine, server32_client=None):
    global engine_ref
    engine_ref = engine
    engine_state["auto_trading"] = getattr(engine, "auto_trading_enabled", engine_state["auto_trading"])
    engine_state["trade_config"] = _copy_trade_config(getattr(engine, "trade_config", engine_state["trade_config"]))
    if hasattr(engine, "build_buy_levels_map"):
        engine_state["buy_levels"] = engine.build_buy_levels_map()
    if hasattr(engine, "build_prev_close_map"):
        engine_state["prev_closes"] = engine.build_prev_close_map()
    engine_state["regime"] = getattr(getattr(engine, "chart1", None), "regime", engine_state["regime"])
    if hasattr(engine_state["regime"], "value"):
        engine_state["regime"] = engine_state["regime"].value
    if hasattr(engine, "assess_data_health"):
        engine_state["data_health"] = engine.assess_data_health()
    if hasattr(engine, "assess_data_readiness"):
        engine_state["data_readiness"] = engine.assess_data_readiness()
    if server32_client:
        engine_ref.api = server32_client
