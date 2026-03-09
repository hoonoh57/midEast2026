#!/usr/bin/env python3
"""
preflight.py — server32 실전 연결 검증 (Dry-Run)
주문은 보내지 않으며, 모든 API 엔드포인트 + WebSocket 연결을 순차 테스트합니다.

실행: python preflight.py
"""

import sys
import io
import json
import time
import threading
import requests
import websocket
from datetime import datetime, timedelta
from dotenv import load_dotenv
import os

# Windows cp949 인코딩 문제 방지
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

load_dotenv()

BASE = os.getenv('SERVER_BASE', 'http://localhost:8082')
WS_RT = os.getenv('WS_REALTIME', 'ws://localhost:8082/ws/realtime')
WS_EX = os.getenv('WS_EXECUTION', 'ws://localhost:8082/ws/execution')

# 검증 대상 종목 (전체 포트폴리오)
TEST_CODES = ['005930', '000660', '012450', '079550']
RESULTS = []

def log(ok: bool, name: str, detail: str = ""):
    status = "✅ PASS" if ok else "❌ FAIL"
    msg = f"  {status}  {name}"
    if detail:
        msg += f"  — {detail}"
    print(msg)
    RESULTS.append((ok, name, detail))


def test_connectivity():
    """[0] 기본 연결 테스트"""
    print("\n[0] 서버 연결 확인")
    try:
        r = requests.get(f"{BASE}/api/status", timeout=5)
        data = r.json()
        log(data.get('Success', False), "GET /api/status",
            f"IsLoggedIn={data.get('Data', {}).get('IsLoggedIn')}")
        return data.get('Success', False)
    except Exception as e:
        log(False, "GET /api/status", str(e))
        return False


def test_login():
    """[1] 로그인"""
    print("\n[1] 로그인")
    try:
        r = requests.get(f"{BASE}/api/auth/login", timeout=10)
        data = r.json()
        account = data.get('Data', {}).get('account', '')
        ok = data.get('Success', False) and bool(account)
        log(ok, "GET /api/auth/login", f"account={account}")
        return account if ok else None
    except Exception as e:
        log(False, "GET /api/auth/login", str(e))
        return None


def test_account(account: str):
    """[2] 계좌 조회"""
    print("\n[2] 계좌 정보")

    # 대시보드
    try:
        r = requests.get(f"{BASE}/api/dashboard/refresh", timeout=10)
        data = r.json()
        log(data.get('Success', False), "GET /api/dashboard/refresh",
            f"keys={list(data.get('Data', {}).keys())[:5]}" if data.get('Data') else "")
    except Exception as e:
        log(False, "GET /api/dashboard/refresh", str(e))

    # 잔고
    try:
        r = requests.get(f"{BASE}/api/accounts/balance", params={'accountNo': account}, timeout=10)
        data = r.json()
        holdings = data.get('Data', [])
        ok = data.get('Success', False)
        log(ok, "GET /api/accounts/balance",
            f"{len(holdings)}종목 보유" if ok else data.get('Message', ''))
        if holdings:
            for h in holdings[:3]:
                code = h.get('종목코드', '').strip()
                qty = h.get('보유수량', '0')
                print(f"        → {code} {qty}주")
    except Exception as e:
        log(False, "GET /api/accounts/balance", str(e))

    # 예수금
    try:
        r = requests.get(f"{BASE}/api/accounts/deposit", params={'accountNo': account}, timeout=10)
        data = r.json()
        ok = data.get('Success', False)
        deposit_data = data.get('Data', [{}])
        avail = deposit_data[0].get('주문가능금액', '?') if deposit_data else '?'
        log(ok, "GET /api/accounts/deposit", f"주문가능금액={avail}")
    except Exception as e:
        log(False, "GET /api/accounts/deposit", str(e))

    # 미체결
    try:
        r = requests.get(f"{BASE}/api/accounts/orders", params={'accountNo': account}, timeout=10)
        data = r.json()
        orders = data.get('Data', [])
        log(data.get('Success', False), "GET /api/accounts/orders",
            f"미체결 {len(orders)}건")
    except Exception as e:
        log(False, "GET /api/accounts/orders", str(e))


def test_market_data():
    """[3] 시세 데이터"""
    print("\n[3] 시세 데이터")

    for code in TEST_CODES[:2]:
        # 종목 정보
        try:
            r = requests.get(f"{BASE}/api/market/symbol", params={'code': code}, timeout=10)
            data = r.json()
            ok = data.get('Success', False)
            info = data.get('Data', {})
            log(ok, f"GET /api/market/symbol ({code})",
                f"name={info.get('name', '?')} last={info.get('last_price', '?')}")
        except Exception as e:
            log(False, f"GET /api/market/symbol ({code})", str(e))

    # 일봉
    code = '005930'
    today = datetime.now().strftime('%Y%m%d')
    stop = (datetime.now() - timedelta(days=120)).strftime('%Y%m%d')
    try:
        r = requests.get(f"{BASE}/api/market/candles/daily",
                         params={'code': code, 'date': today, 'stopDate': stop}, timeout=15)
        data = r.json()
        candles = data.get('Data', [])
        ok = data.get('Success', False) and len(candles) > 0
        log(ok, f"GET /api/market/candles/daily ({code})",
            f"{len(candles)}봉" + (f" | 최근={candles[0].get('일자', '?')}" if candles else ""))
    except Exception as e:
        log(False, f"GET /api/market/candles/daily ({code})", str(e))

    # 분봉
    try:
        r = requests.get(f"{BASE}/api/market/candles/minute",
                         params={'code': code, 'tick': '5',
                                 'stopTime': (datetime.now() - timedelta(days=3)).strftime('%Y%m%d090000')},
                         timeout=30)
        data = r.json()
        candles = data.get('Data', [])
        ok = data.get('Success', False) and len(candles) > 0
        log(ok, f"GET /api/market/candles/minute ({code}, 5분)",
            f"{len(candles)}봉" + (f" | 최근={candles[0].get('체결시간', '?')}" if candles else ""))
    except Exception as e:
        log(False, f"GET /api/market/candles/minute ({code})", str(e))


def test_websocket_realtime():
    """[4] WebSocket 실시간 연결"""
    print("\n[4] WebSocket 연결")

    received = []
    connected = threading.Event()
    done = threading.Event()

    def on_open(ws):
        connected.set()

    def on_message(ws, msg):
        try:
            data = json.loads(msg)
            received.append(data)
            if len(received) >= 3:
                done.set()
        except:
            received.append(msg)

    def on_error(ws, err):
        log(False, "WS /ws/realtime connect", str(err))
        done.set()

    def on_close(ws, code, reason):
        pass

    # Realtime WS
    ws = websocket.WebSocketApp(WS_RT,
                                 on_open=on_open,
                                 on_message=on_message,
                                 on_error=on_error,
                                 on_close=on_close)

    t = threading.Thread(target=ws.run_forever, daemon=True)
    t.start()

    if connected.wait(timeout=5):
        log(True, "WS /ws/realtime connect", "연결 성공")

        # 실시간 구독 트리거
        codes = ';'.join(TEST_CODES)
        try:
            r = requests.get(f"{BASE}/api/realtime/subscribe",
                             params={'codes': codes, 'screen': '9999'}, timeout=5)
            data = r.json()
            log(data.get('Success', False), "실시간 구독",
                f"{len(TEST_CODES)}종목 → screen 9999")
        except Exception as e:
            log(False, "실시간 구독", str(e))

        # 최대 10초 대기하며 틱 수신 확인
        if done.wait(timeout=10):
            log(True, "실시간 틱 수신", f"{len(received)}건 수신")
            if received:
                sample = received[0]
                print(f"        → sample: type={sample.get('type', '?')} "
                      f"code={sample.get('code', '?')} "
                      f"keys={list(sample.get('data', {}).keys())[:6]}")
        else:
            # 장 외 시간이면 틱이 안 올 수 있음
            log(len(received) > 0, "실시간 틱 수신",
                f"{len(received)}건 (장외시간이면 0건 정상)")

        # 구독 해제
        try:
            requests.get(f"{BASE}/api/realtime/unsubscribe",
                         params={'screen': '9999', 'code': 'ALL'}, timeout=5)
        except:
            pass
    else:
        log(False, "WS /ws/realtime connect", "5초 내 연결 실패")

    ws.close()

    # Execution WS
    exec_connected = threading.Event()

    def on_exec_open(ws):
        exec_connected.set()

    ws2 = websocket.WebSocketApp(WS_EX, on_open=on_exec_open,
                                  on_error=lambda ws, e: None,
                                  on_close=lambda ws, c, r: None)
    t2 = threading.Thread(target=ws2.run_forever, daemon=True)
    t2.start()

    if exec_connected.wait(timeout=5):
        log(True, "WS /ws/execution connect", "연결 성공")
    else:
        log(False, "WS /ws/execution connect", "5초 내 연결 실패")
    ws2.close()


def test_mysql():
    """[5] MySQL 연결"""
    print("\n[5] MySQL 연결")
    try:
        import mysql.connector
        conn = mysql.connector.connect(
            host=os.getenv('MYSQL_HOST', 'localhost'),
            user=os.getenv('MYSQL_USER', 'root'),
            password=os.getenv('MYSQL_PASSWORD', ''),
            charset='utf8mb4',
        )
        cur = conn.cursor()

        # stock_information DB — 종목 기본정보
        db1 = os.getenv('DB_STOCK_INFO', 'stock_information')
        cur.execute(f"SELECT COUNT(*) FROM {db1}.stock_base_info")
        count1 = cur.fetchone()[0]
        log(count1 > 0, f"MySQL {db1}.stock_base_info", f"{count1}개 종목")

        # stock_info DB — 일봉
        db2 = os.getenv('DB_CANDLES', 'stock_info')
        cur.execute(f"SELECT COUNT(*) FROM {db2}.daily_candles WHERE code='005930'")
        cnt = cur.fetchone()[0]
        log(cnt > 0, f"MySQL {db2}.daily_candles (005930)", f"{cnt}행")

        if cnt > 0:
            cur.execute(f"SELECT MAX(date) FROM {db2}.daily_candles WHERE code='005930'")
            latest = cur.fetchone()[0]
            log(True, f"MySQL 일봉 최신일", f"{latest}")

        cur.close()
        conn.close()
    except ImportError:
        log(False, "MySQL", "mysql-connector-python 미설치")
    except Exception as e:
        log(False, "MySQL", str(e))


def summary():
    """결과 요약"""
    total = len(RESULTS)
    passed = sum(1 for ok, _, _ in RESULTS if ok)
    failed = total - passed

    print("\n" + "=" * 60)
    print(f"  PREFLIGHT 결과: {passed}/{total} PASS", end="")
    if failed:
        print(f"  ({failed} FAIL)")
        print("\n  실패 항목:")
        for ok, name, detail in RESULTS:
            if not ok:
                print(f"    ❌ {name}: {detail}")
    else:
        print("  — ALL CLEAR 🚀")

    print("=" * 60)

    if failed == 0:
        print("\n  → war_engine.py 실전 실행 가능")
        print("    python war_engine.py")
    else:
        print("\n  → 실패 항목 해결 후 재실행")

    return failed == 0


if __name__ == '__main__':
    print("=" * 60)
    print("  WAR-ADAPTIVE ENGINE — PREFLIGHT CHECK")
    print(f"  server32: {BASE}")
    print(f"  시간: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)

    if not test_connectivity():
        print("\n❌ server32 연결 불가 — 서버 실행 확인 필요")
        print(f"   server32가 {BASE} 에서 실행 중인지 확인하세요.")
        sys.exit(1)

    account = test_login()
    if not account:
        print("\n❌ 로그인 실패 — 키움 OpenAPI 연결 확인")
        sys.exit(1)

    test_account(account)
    test_market_data()
    test_websocket_realtime()
    test_mysql()

    all_ok = summary()
    sys.exit(0 if all_ok else 1)
