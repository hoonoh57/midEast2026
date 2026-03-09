#!/usr/bin/env python3
"""
=============================================================================
 WAR-ADAPTIVE MULTI-CHART TRADING ENGINE v1.0
 이란 공습 대응형 실전 자동매매 시스템

 연동: server32 (localhost:8082) + MySQL (stock_info) + 외부 크롤링
 대상: 방산 / 에너지 / 반도체 섹터
 날짜: 2026-03-04 즉시 실행용
=============================================================================
"""

import os
import requests
import json
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import websocket
import mysql.connector
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
from bs4 import BeautifulSoup
from enum import Enum
from dotenv import load_dotenv
import logging

try:
    import uvicorn
    from web_server import app as _web_app, engine_state, set_engine_ref, mark_engine_dirty
    WEB_ENABLED = True
except ImportError:
    WEB_ENABLED = False

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler('war_engine.log', encoding='utf-8'),
        logging.StreamHandler()
    ]
)
log = logging.getLogger('WAR_ENGINE')

# ═══════════════════════════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════════════════════════

SERVER_BASE = os.getenv('SERVER_BASE', 'http://localhost:8082')
WS_REALTIME = os.getenv('WS_REALTIME', 'ws://localhost:8082/ws/realtime')
WS_EXECUTION = os.getenv('WS_EXECUTION', 'ws://localhost:8082/ws/execution')

MYSQL_CONFIG = {
    'host': os.getenv('MYSQL_HOST', 'localhost'),
    'user': os.getenv('MYSQL_USER', 'root'),
    'password': os.getenv('MYSQL_PASSWORD', ''),
    'charset': 'utf8mb4',
}

DB_STOCK_INFO = os.getenv('DB_STOCK_INFO', 'stock_information')
DB_CANDLES    = os.getenv('DB_CANDLES', 'stock_info')


def _update_web_tick_state(code: str, price: int, volume: int = 0):
    """실시간 틱을 웹 대시보드 상태에 즉시 반영한다."""
    if not WEB_ENABLED or not code or price <= 0:
        return

    prices = engine_state.setdefault("prices", {})
    prices[code] = price
    if code == 'KOSPI':
        engine_state["kospi"] = price

    now_ts = int(time.time())
    bar_time = now_ts - (now_ts % 60)
    candle_hist = engine_state.setdefault("candle_history", {})
    bars = candle_hist.setdefault(code, [])
    tick_volume = max(1, int(volume or 0))

    if bars and bars[-1]["time"] == bar_time:
        bar = bars[-1]
        bar["high"] = max(bar["high"], price)
        bar["low"] = min(bar["low"], price)
        bar["close"] = price
        bar["volume"] = bar.get("volume", 0) + tick_volume
    else:
        bars.append({
            "time": bar_time,
            "open": price,
            "high": price,
            "low": price,
            "close": price,
            "volume": tick_volume,
        })
        if len(bars) > 600:
            candle_hist[code] = bars[-600:]
    mark_engine_dirty(f"tick:{code}")


def _merge_lw_candles(history: list, live: list) -> list:
    merged = {}
    for candle in history or []:
        merged[candle["time"]] = dict(candle)
    for candle in live or []:
        merged[candle["time"]] = dict(candle)
    result = list(merged.values())
    result.sort(key=lambda item: item["time"])
    return result


def _bar_time_from_timestamp(ts: str | None = None) -> int:
    try:
        dt = datetime.fromisoformat(str(ts)) if ts else datetime.now()
    except Exception:
        dt = datetime.now()
    value = int(dt.timestamp())
    return value - (value % 60)


def _parse_int(value, default: int = 0) -> int:
    try:
        text = str(value).replace(',', '').strip()
        if text == '':
            return default
        return int(float(text))
    except Exception:
        return default

# ═══════════════════════════════════════════════════════════════
# DATA CLASSES
# ═══════════════════════════════════════════════════════════════

class Regime(Enum):
    EXTREME_CRISIS = "EXTREME_CRISIS"
    CRISIS = "CRISIS"
    CAUTIOUS = "CAUTIOUS"
    RECOVERY = "RECOVERY"
    AGGRESSIVE = "AGGRESSIVE"

class WarPhase(Enum):
    SHOCK = "SHOCK"               # D+0~1
    PANIC_SELLING = "PANIC"       # D+2~3
    STABILIZATION = "STABLE"      # D+4~7  ★현재
    EARLY_RECOVERY = "E_RECOVERY" # D+8~14
    FULL_RECOVERY = "F_RECOVERY"  # D+15+

@dataclass
class TargetStock:
    code: str
    name: str
    sector: str                   # 'defense' | 'energy' | 'semiconductor'
    prev_close: int
    target_price: int             # 증권사 목표가
    stop_loss_pct: float
    sector_weight: float          # 섹터 내 비중
    buy_levels: List[dict] = field(default_factory=list)

@dataclass
class Signal:
    code: str
    name: str
    action: str                   # BUY | SELL | HOLD
    price: int
    quantity: int
    confidence: float
    chart: str                    # MACRO | DEFENSE | ENERGY | SEMI
    reason: str
    stop_loss: int = 0
    take_profit: int = 0
    timestamp: str = ""

# ═══════════════════════════════════════════════════════════════
# TARGET UNIVERSE — 오늘(3/4) 대응 종목
# ═══════════════════════════════════════════════════════════════

TARGETS: Dict[str, TargetStock] = {
    # ── 방산 (35%) ──
    '012450': TargetStock('012450', '한화에어로스페이스', 'defense',
                          1432000, 1800000, -0.08, 0.35),
    '079550': TargetStock('079550', 'LIG넥스원', 'defense',
                          661000, 710000, -0.08, 0.30),
    '272210': TargetStock('272210', '한화시스템', 'defense',
                          146700, 180000, -0.08, 0.20),
    '064350': TargetStock('064350', '현대로템', 'defense',
                          249000, 310000, -0.07, 0.15),
    # ── 에너지 (20%) ──
    '010950': TargetStock('010950', '에쓰오일', 'energy',
                          141300, 170000, -0.07, 0.35),
    '096770': TargetStock('096770', 'SK이노베이션', 'energy',
                          130000, 160000, -0.07, 0.30),
    '011200': TargetStock('011200', 'HMM', 'energy',
                          25750, 32000, -0.08, 0.20),   # 0,0→25750,32000 (3/3 종가+목표가)
    '028670': TargetStock('028670', '팬오션', 'energy',
                          4800, 6000, -0.08, 0.15),      # 0,0→4800,6000
    # ── 반도체 (30%) — 역발상 분할매수 ──
    '005930': TargetStock('005930', '삼성전자', 'semiconductor',
                          195100, 260000, -0.10, 0.55,
                          buy_levels=[
                              {'price': 195000, 'pct': 0.15, 'label': 'L1'},
                              {'price': 183000, 'pct': 0.20, 'label': 'L2'},   # 188000→183000 (3/4 장중 183,300 도달)
                              {'price': 175000, 'pct': 0.25, 'label': 'L3'},   # 180000→175000
                              {'price': 165000, 'pct': 0.25, 'label': 'L4'},
                              {'price': 155000, 'pct': 0.15, 'label': 'L5'},   # 165000→155000
                          ]),
    '000660': TargetStock('000660', 'SK하이닉스', 'semiconductor',
                          939000, 1350000, -0.10, 0.45,
                          buy_levels=[
                              {'price': 940000, 'pct': 0.15, 'label': 'L1'},
                              {'price': 891000, 'pct': 0.20, 'label': 'L2'},   # 900000→891000 (3/4 장중 891,000 도달)
                              {'price': 840000, 'pct': 0.25, 'label': 'L3'},   # 850000→840000
                              {'price': 790000, 'pct': 0.25, 'label': 'L4'},   # 800000→790000
                              {'price': 740000, 'pct': 0.15, 'label': 'L5'},   # 750000→740000
                          ]),
}

SECTOR_ALLOCATION = {
    'defense': 0.35,
    'energy': 0.20,
    'semiconductor': 0.30,
    'cash': 0.15,
}

# 3/4 전용 요동장 파라미터 (전일 상한가 방산주 갭업→급락 대응)
WHIPSAW_CONFIG_20260304 = {
    '012450': {'expected_high': 1_655_000, 'safe_zone': (1_350_000, 1_420_000),
               'emergency_sell': 1_290_000, 'afternoon_buy': 1_380_000},
    '079550': {'expected_high': 845_000, 'safe_zone': (700_000, 750_000),
               'emergency_sell': 650_000, 'afternoon_buy': 720_000},
    '064350': {'expected_high': 290_000, 'safe_zone': (220_000, 240_000),
               'emergency_sell': 210_000, 'afternoon_buy': 230_000},
    '272210': {'expected_high': 190_000, 'safe_zone': (130_000, 142_000),
               'emergency_sell': 120_000, 'afternoon_buy': 135_000},
}

# ═══════════════════════════════════════════════════════════════
# SERVER32 API CLIENT
# ═══════════════════════════════════════════════════════════════

class Server32Client:
    """server32 REST API 래퍼 — 키움증권 연동"""

    def __init__(self, base_url=SERVER_BASE):
        self.base = base_url
        self.account_no = None
        self.session = requests.Session()
        self.session.timeout = 10
        self._consecutive_failures = 0
        self._max_failures = 5
        self._backoff_until: Optional[datetime] = None
        self._last_balance: list = []
        self._last_balance_at: Optional[datetime] = None
        self._last_dashboard: dict = {}
        self._last_dashboard_at: Optional[datetime] = None

    def _check_backoff(self) -> bool:
        """backoff 기간 중이면 True 반환 (호출 차단)"""
        if self._backoff_until and datetime.now() < self._backoff_until:
            remaining = (self._backoff_until - datetime.now()).seconds
            log.warning(f"⏸ API backoff 중 — {remaining}초 대기 (키움 자동 중지 방지)")
            return True
        return False

    def _on_success(self):
        self._consecutive_failures = 0
        self._backoff_until = None

    def _on_failure(self):
        self._consecutive_failures += 1
        if self._consecutive_failures >= self._max_failures:
            wait = min(60 * self._consecutive_failures, 600)  # 최대 10분
            self._backoff_until = datetime.now() + timedelta(seconds=wait)
            log.error(f"🚨 API 연속 {self._consecutive_failures}회 실패 → {wait}초 backoff 설정")

    def _get(self, path, params=None) -> dict:
        if self._check_backoff():
            return {'Success': False, 'Message': 'backoff', 'Data': None}
        try:
            r = self.session.get(f"{self.base}{path}", params=params)
            data = r.json()
            if not data.get('Success'):
                log.warning(f"API 실패: {path} → {data.get('Message')}")
                self._on_failure()
            else:
                self._on_success()
            return data
        except Exception as e:
            log.error(f"API 오류: {path} → {e}")
            self._on_failure()
            return {'Success': False, 'Message': str(e), 'Data': None}

    def _post(self, path, body) -> dict:
        if self._check_backoff():
            return {'Success': False, 'Message': 'backoff', 'Data': None}
        try:
            r = self.session.post(f"{self.base}{path}", json=body)
            data = r.json()
            if not data.get('Success'):
                self._on_failure()
            else:
                self._on_success()
            return data
        except Exception as e:
            log.error(f"POST 오류: {path} → {e}")
            self._on_failure()
            return {'Success': False, 'Message': str(e), 'Data': None}

    # ── 인증/상태 ──
    def login(self) -> bool:
        res = self._get('/api/auth/login')
        if res['Success'] and res['Data']:
            self.account_no = res['Data'].get('account')
            log.info(f"✅ 로그인 성공: {self.account_no}")
            return True
        return False

    def check_status(self) -> dict:
        return self._get('/api/status')

    # ── 계좌 ──
    def get_dashboard(self, refresh=False) -> dict:
        path = '/api/dashboard/refresh' if refresh else '/api/dashboard'
        res = self._get(path)
        if res.get('Success') and res.get('Data') is not None:
            self._last_dashboard = res
            self._last_dashboard_at = datetime.now()
            return res
        return self._last_dashboard or res

    def get_balance(self) -> list:
        # 직접 잔고를 우선 조회하되 실패 시 dashboard 캐시와 마지막 정상 잔고를 사용한다.
        res = self._get('/api/accounts/balance', {'accountNo': self.account_no})
        if res['Success'] and isinstance(res.get('Data'), list):
            self._last_balance = res.get('Data', [])
            self._last_balance_at = datetime.now()
            return self._last_balance

        dash = self.get_dashboard(refresh=False)
        dash_data = dash.get('Data', {}) if isinstance(dash, dict) else {}
        dash_holdings = dash_data.get('Holdings') if isinstance(dash_data, dict) else None
        if isinstance(dash_holdings, list):
            self._last_balance = dash_holdings
            self._last_balance_at = datetime.now()
            return dash_holdings

        if self._last_balance:
            log.warning("⚠️ 잔고조회 실패 → 마지막 정상 잔고 캐시 사용")
            return self._last_balance
        return []

    def get_deposit(self) -> dict:
        res = self._get('/api/accounts/deposit', {'accountNo': self.account_no})
        return res.get('Data', [{}])[0] if res['Success'] and res.get('Data') else {}

    def get_outstanding_orders(self) -> list:
        res = self._get('/api/accounts/orders', {'accountNo': self.account_no})
        return res.get('Data', []) if res['Success'] else []

    # ── 시세 ──
    def get_symbol_info(self, code: str) -> dict:
        res = self._get('/api/market/symbol', {'code': code})
        return res.get('Data', {}) if res['Success'] else {}

    def get_daily_candles(self, code: str, date: str, stop_date: str) -> list:
        res = self._get('/api/market/candles/daily', {
            'code': code, 'date': date, 'stopDate': stop_date
        })
        return res.get('Data', []) if res['Success'] else []

    def get_minute_candles(self, code: str, tick: int = 1,
                           stop_time: str = None) -> list:
        if stop_time is None:
            stop_time = (datetime.now() - timedelta(days=3)).strftime('%Y%m%d090000')
        res = self._get('/api/market/candles/minute', {
            'code': code, 'tick': str(tick), 'stopTime': stop_time
        })
        return res.get('Data', []) if res['Success'] else []

    # ── 실시간 ──
    def subscribe_realtime(self, codes: List[str], screen='1000'):
        code_str = ';'.join(codes)
        return self._get('/api/realtime/subscribe', {
            'codes': code_str, 'screen': screen
        })

    def unsubscribe_realtime(self, screen='ALL', code='ALL'):
        return self._get('/api/realtime/unsubscribe', {
            'screen': screen, 'code': code
        })

    # ── 주문 ──
    def send_order(self, code: str, order_type: int, quantity: int,
                   price: int, quote_type: str = '00') -> dict:
        """
        order_type: 1=신규매수, 2=신규매도, 3=매수취소, 4=매도취소
        quote_type: "00"=지정가, "03"=시장가
        """
        body = {
            "AccountNo": self.account_no,
            "StockCode": code,
            "OrderType": order_type,
            "Quantity": quantity,
            "Price": price,
            "QuoteType": quote_type,
        }
        log.info(f"📤 주문: {code} {'매수' if order_type==1 else '매도'} "
                 f"{quantity}주 @ {price:,}원")
        return self._post('/api/orders', body)


# ═══════════════════════════════════════════════════════════════
# MYSQL CLIENT
# ═══════════════════════════════════════════════════════════════

class MySQLClient:
    """MySQL 종목정보 + 일봉 데이터 조회/저장"""

    def __init__(self):
        self.conn_info = None
        self.conn_candle = None
        self._connect()

    def _connect(self):
        try:
            self.conn_info = mysql.connector.connect(
                **MYSQL_CONFIG, database=DB_STOCK_INFO
            )
            self.conn_candle = mysql.connector.connect(
                **MYSQL_CONFIG, database=DB_CANDLES
            )
            log.info("✅ MySQL 연결 성공")
        except Exception as e:
            log.error(f"MySQL 연결 실패: {e}")

    def get_stock_info(self, code: str) -> dict:
        cur = self.conn_info.cursor(dictionary=True)
        cur.execute("""
            SELECT code, name, market, sector, sector_large, market_cap,
                   per, pbr, eps, bps, div_yield, foreign_ratio
            FROM stock_base_info
            WHERE code = %s
        """, (code,))
        row = cur.fetchone()
        cur.close()
        return row or {}

    def get_sector_stocks(self, sector_keyword: str) -> list:
        cur = self.conn_info.cursor(dictionary=True)
        cur.execute("""
            SELECT code, name, market_cap, per, foreign_ratio
            FROM stock_base_info
            WHERE (sector LIKE %s OR sector_large LIKE %s)
            ORDER BY market_cap DESC
        """, (f'%{sector_keyword}%', f'%{sector_keyword}%'))
        rows = cur.fetchall()
        cur.close()
        return rows

    def get_daily_candles_df(self, code: str, days: int = 120) -> pd.DataFrame:
        cur = self.conn_candle.cursor(dictionary=True)
        cur.execute("""
            SELECT date, open, high, low, close, volume, change_pct
            FROM daily_candles
            WHERE code = %s
            ORDER BY date DESC
            LIMIT %s
        """, (code, days))
        rows = cur.fetchall()
        cur.close()
        if not rows:
            return pd.DataFrame()
        df = pd.DataFrame(rows)
        df['date'] = pd.to_datetime(df['date'])
        df = df.sort_values('date').reset_index(drop=True)
        return df

    def save_candle(self, code: str, date: str, o: int, h: int,
                    l: int, c: int, vol: int, chg: float = None):
        cur = self.conn_candle.cursor()
        cur.execute("""
            INSERT INTO daily_candles (code, date, open, high, low, close, volume, change_pct)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
                open=%s, high=%s, low=%s, close=%s, volume=%s, change_pct=%s
        """, (code, date, o, h, l, c, vol, chg,
              o, h, l, c, vol, chg))
        self.conn_candle.commit()
        cur.close()


# ═══════════════════════════════════════════════════════════════
# EXTERNAL DATA CRAWLERS
# ═══════════════════════════════════════════════════════════════

class ExternalDataCollector:
    """외부 데이터 주기적 수집 (5분 간격)"""

    WAR_KEYWORDS_NEGATIVE = ['확전', '지상군', '핵', '호르무즈봉쇄', '추가공습',
                              '미사일', '사상자', 'NATO', '모즈타바', '보복선언', '미군사상']
    WAR_KEYWORDS_POSITIVE = ['휴전', '협상', '철수', '종전', '봉쇄해제', '평화',
                              '모즈타바_협상', '협상의지']

    def __init__(self):
        self.latest_wti = 80.0
        self.latest_brent = 83.0
        self.wti_change_pct = 0.0
        self.usdkrw = 1466.0
        self.news_sentiment = 'NEUTRAL'
        self.kospi_futures_change = 0.0
        self.nvidia_change = 0.0
        self.foreign_net_buy = 0
        self.vkospi = 30.0
        self.last_update = None

    def update_all(self):
        log.info("🌐 외부 데이터 수집 시작...")
        self._fetch_oil_price()
        self._fetch_exchange_rate()
        self._fetch_war_news_sentiment()
        self._fetch_us_market()
        self.last_update = datetime.now()
        log.info(f"🌐 수집 완료: WTI=${self.latest_wti:.1f} "
                 f"환율={self.usdkrw:.0f} 뉴스={self.news_sentiment}")

    def _fetch_oil_price(self):
        try:
            headers = {'User-Agent': 'Mozilla/5.0'}
            r = requests.get(
                'https://kr.investing.com/commodities/crude-oil',
                headers=headers, timeout=5
            )
            soup = BeautifulSoup(r.text, 'html.parser')
            price_el = soup.select_one('[data-test="instrument-price-last"]')
            if price_el:
                self.latest_wti = float(price_el.text.replace(',', ''))
            change_el = soup.select_one('[data-test="instrument-price-change-percent"]')
            if change_el:
                self.wti_change_pct = float(change_el.text.replace('%', '').replace('+', '')) / 100
        except Exception as e:
            log.warning(f"유가 크롤링 실패: {e}")

    def _fetch_exchange_rate(self):
        try:
            headers = {'User-Agent': 'Mozilla/5.0'}
            r = requests.get(
                'https://kr.investing.com/currencies/usd-krw',
                headers=headers, timeout=5
            )
            soup = BeautifulSoup(r.text, 'html.parser')
            price_el = soup.select_one('[data-test="instrument-price-last"]')
            if price_el:
                self.usdkrw = float(price_el.text.replace(',', ''))
        except Exception as e:
            log.warning(f"환율 크롤링 실패: {e}")

    def _fetch_war_news_sentiment(self):
        try:
            headers = {'User-Agent': 'Mozilla/5.0'}
            r = requests.get(
                'https://search.naver.com/search.naver?where=news&query=이란+전쟁+호르무즈',
                headers=headers, timeout=5
            )
            soup = BeautifulSoup(r.text, 'html.parser')
            titles = [el.text for el in soup.select('.news_tit')]
            all_text = ' '.join(titles[:20])

            neg_count = sum(1 for kw in self.WAR_KEYWORDS_NEGATIVE if kw in all_text)
            pos_count = sum(1 for kw in self.WAR_KEYWORDS_POSITIVE if kw in all_text)

            if pos_count >= 3:
                self.news_sentiment = 'EXTREME_POS'
            elif pos_count >= 1:
                self.news_sentiment = 'POS'
            elif neg_count >= 4:
                self.news_sentiment = 'EXTREME_NEG'
            elif neg_count >= 2:
                self.news_sentiment = 'NEG'
            else:
                self.news_sentiment = 'NEUTRAL'
        except Exception as e:
            log.warning(f"뉴스 크롤링 실패: {e}")

    def _fetch_us_market(self):
        try:
            headers = {'User-Agent': 'Mozilla/5.0'}
            r = requests.get(
                'https://kr.investing.com/equities/nvidia-corp',
                headers=headers, timeout=5
            )
            soup = BeautifulSoup(r.text, 'html.parser')
            change_el = soup.select_one('[data-test="instrument-price-change-percent"]')
            if change_el:
                self.nvidia_change = float(
                    change_el.text.replace('%', '').replace('+', '')
                ) / 100
        except Exception as e:
            log.warning(f"미국 시장 크롤링 실패: {e}")

    def get_fnguide_fundamentals(self, code: str) -> dict:
        try:
            url = (f"https://comp.fnguide.com/SVO2/ASP/SVD_Main.asp"
                   f"?pGB=1&gicode=A{code}&cID=&MenuYn=Y&ReportGB=&NewMenuID=101&stkGb=701")
            headers = {'User-Agent': 'Mozilla/5.0'}
            tables = pd.read_html(url, encoding='utf-8')
            if len(tables) > 4:
                snapshot = tables[4]
                return {
                    'source': 'fnguide',
                    'tables_count': len(tables),
                    'raw_snapshot': snapshot.to_dict() if not snapshot.empty else {}
                }
        except Exception as e:
            log.warning(f"FnGuide 크롤링 실패 ({code}): {e}")
        return {}


# ═══════════════════════════════════════════════════════════════
# TECHNICAL ANALYSIS MODULE
# ═══════════════════════════════════════════════════════════════

class TechnicalAnalysis:

    @staticmethod
    def rsi(series: pd.Series, period: int = 14) -> pd.Series:
        delta = series.diff()
        gain = delta.where(delta > 0, 0).rolling(period).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(period).mean()
        rs = gain / loss
        return 100 - (100 / (1 + rs))

    @staticmethod
    def bollinger(series: pd.Series, period=20, std_mult=2.0):
        mid = series.rolling(period).mean()
        std = series.rolling(period).std()
        return mid + std_mult * std, mid, mid - std_mult * std

    @staticmethod
    def macd(series: pd.Series, fast=12, slow=26, signal=9):
        ema_f = series.ewm(span=fast).mean()
        ema_s = series.ewm(span=slow).mean()
        macd_line = ema_f - ema_s
        sig_line = macd_line.ewm(span=signal).mean()
        hist = macd_line - sig_line
        return macd_line, sig_line, hist

    @staticmethod
    def vwap(df: pd.DataFrame) -> pd.Series:
        typical = (df['high'] + df['low'] + df['close']) / 3
        cum_tp_vol = (typical * df['volume']).cumsum()
        cum_vol = df['volume'].cumsum()
        return cum_tp_vol / cum_vol

    @staticmethod
    def adx(df: pd.DataFrame, period=14) -> pd.Series:
        high, low, close = df['high'], df['low'], df['close']
        tr = pd.concat([
            high - low,
            (high - close.shift()).abs(),
            (low - close.shift()).abs()
        ], axis=1).max(axis=1)
        atr = tr.rolling(period).mean()
        plus_dm = high.diff().clip(lower=0)
        minus_dm = (-low.diff()).clip(lower=0)
        pdi = 100 * plus_dm.rolling(period).mean() / atr
        mdi = 100 * minus_dm.rolling(period).mean() / atr
        dx = 100 * (pdi - mdi).abs() / (pdi + mdi)
        return dx.rolling(period).mean()

    @staticmethod
    def moving_averages(series: pd.Series):
        return {
            'ma5': series.rolling(5).mean(),
            'ma20': series.rolling(20).mean(),
            'ma60': series.rolling(60).mean(),
        }


# ═══════════════════════════════════════════════════════════════
# WHIPSAW DEFENSE ENGINE — 요동장 감지 & 대응
# ═══════════════════════════════════════════════════════════════

class WhipsawPhase(Enum):
    PRE_MARKET_SURGE    = "pre_market_surge"      # 프리마켓 갭업  08:30~09:00
    OPENING_SPIKE       = "opening_spike"         # 장초 스파이크  09:00~09:15
    PROFIT_TAKING_DUMP  = "profit_taking_dump"    # 차익실현 폭락  09:15~10:00
    DEAD_CAT_BOUNCE     = "dead_cat_bounce"       # 기술적 반등   10:00~10:30
    STABILIZATION       = "stabilization"         # 안정화       10:30~11:30
    AFTERNOON_TREND     = "afternoon_trend"       # 오후 추세 확정 11:30~15:30


@dataclass
class WhipsawTracker:
    code: str
    name: str
    prev_close: int
    session_high: int = 0
    session_low: int = 999_999_999
    high_timestamp: Optional[datetime] = None
    current_price: int = 0
    hit_near_limit_up: bool = False
    crash_from_high: bool = False
    bounce_detected: bool = False
    buy_locked_until: Optional[datetime] = None
    sell_triggered: bool = False

    @property
    def gap_up_pct(self) -> float:
        if self.prev_close <= 0: return 0.0
        return (self.current_price - self.prev_close) / self.prev_close

    @property
    def high_from_prev_close_pct(self) -> float:
        if self.prev_close <= 0: return 0.0
        return (self.session_high - self.prev_close) / self.prev_close

    @property
    def drawdown_from_high_pct(self) -> float:
        if self.session_high <= 0: return 0.0
        return (self.current_price - self.session_high) / self.session_high


class WhipsawDefenseEngine:
    """요동장(갭업→급락) 감지 & 매수 잠금/긴급매도 제어"""

    NEAR_LIMIT_UP_PCT      = 0.25    # 전일비 +25% → 상한가 근접
    SPIKE_DANGER_PCT       = 0.20    # +20% 갭업 → 장초 추격 금지
    CRASH_THRESHOLD_PCT    = -0.12   # 고점비 -12% → 급락 구간
    BOUNCE_MIN_PCT         = 0.03    # 저점비 +3% → 반등 감지
    SAFE_ENTRY_DRAWDOWN    = -0.08   # 고점비 -8%~-12% → 안전 진입대
    EMERGENCY_SELL_DRAWDOWN = -0.20  # 고점비 -20% → 긴급 매도

    TIME_ALLOCATION: Dict[WhipsawPhase, float] = {
        WhipsawPhase.PRE_MARKET_SURGE:   0.00,
        WhipsawPhase.OPENING_SPIKE:      0.00,
        WhipsawPhase.PROFIT_TAKING_DUMP: 0.00,
        WhipsawPhase.DEAD_CAT_BOUNCE:    0.15,
        WhipsawPhase.STABILIZATION:      0.35,
        WhipsawPhase.AFTERNOON_TREND:    0.50,
    }

    def __init__(self):
        self.trackers: Dict[str, WhipsawTracker] = {}

    def register(self, code: str, name: str, prev_close: int):
        self.trackers[code] = WhipsawTracker(code=code, name=name, prev_close=prev_close)

    def update_price(self, code: str, price: int, ts: datetime):
        if code not in self.trackers or price <= 0:
            return
        t = self.trackers[code]
        t.current_price = price
        if price > t.session_high:
            t.session_high = price
            t.high_timestamp = ts
        if price < t.session_low:
            t.session_low = price

        if t.high_from_prev_close_pct >= self.NEAR_LIMIT_UP_PCT and not t.hit_near_limit_up:
            t.hit_near_limit_up = True
            log.warning(f"⚠️ [{t.name}] 상한가 근접! 고가={t.session_high:,} "
                        f"(+{t.high_from_prev_close_pct:.1%})")

        if t.hit_near_limit_up and t.drawdown_from_high_pct <= self.CRASH_THRESHOLD_PCT \
                and not t.crash_from_high:
            t.crash_from_high = True
            t.buy_locked_until = ts + timedelta(minutes=30)
            log.warning(f"🔻 [{t.name}] 급락! {t.session_high:,}→{price:,} "
                        f"({t.drawdown_from_high_pct:.1%}), 잠금 ~{t.buy_locked_until.strftime('%H:%M')}")

        if t.drawdown_from_high_pct <= self.EMERGENCY_SELL_DRAWDOWN and not t.sell_triggered:
            t.sell_triggered = True
            log.critical(f"🚨 [{t.name}] 긴급매도 트리거! 고점비 {t.drawdown_from_high_pct:.1%}")

        if t.crash_from_high and not t.bounce_detected and t.session_low > 0:
            bounce = (price - t.session_low) / t.session_low
            if bounce >= self.BOUNCE_MIN_PCT:
                t.bounce_detected = True
                log.info(f"📈 [{t.name}] 반등 감지 (+{bounce:.1%})")

    def get_phase(self, now: datetime) -> WhipsawPhase:
        h, m = now.hour, now.minute
        if (h, m) < (9, 0):   return WhipsawPhase.PRE_MARKET_SURGE
        if (h, m) < (9, 15):  return WhipsawPhase.OPENING_SPIKE
        if (h, m) < (10, 0):  return WhipsawPhase.PROFIT_TAKING_DUMP
        if (h, m) < (10, 30): return WhipsawPhase.DEAD_CAT_BOUNCE
        if (h, m) < (11, 30): return WhipsawPhase.STABILIZATION
        return WhipsawPhase.AFTERNOON_TREND

    def can_buy(self, code: str, now: datetime) -> Tuple[bool, str]:
        if code not in self.trackers:
            return True, "미등록"
        t = self.trackers[code]
        phase = self.get_phase(now)

        if t.hit_near_limit_up and not t.crash_from_high:
            return False, f"상한가 근접 대기 (고가 {t.session_high:,})"
        if t.buy_locked_until and now < t.buy_locked_until:
            rem = (t.buy_locked_until - now).seconds // 60
            return False, f"급락 후 잠금 중 ({rem}분 남음)"
        if t.gap_up_pct >= self.SPIKE_DANGER_PCT and \
                phase in (WhipsawPhase.OPENING_SPIKE, WhipsawPhase.PROFIT_TAKING_DUMP):
            return False, f"갭업+{t.gap_up_pct:.0%} 장초 추격 금지"
        if t.sell_triggered and phase != WhipsawPhase.AFTERNOON_TREND:
            return False, "긴급매도 발동, 오후까지 대기"
        if self.TIME_ALLOCATION.get(phase, 0) <= 0:
            return False, f"구간({phase.value}) 매수 불허"
        if t.crash_from_high and not t.bounce_detected and \
                phase == WhipsawPhase.DEAD_CAT_BOUNCE:
            return False, "반등 미확인 관망"
        return True, f"허용 (구간={phase.value})"

    def size_multiplier(self, code: str, now: datetime) -> float:
        if code not in self.trackers: return 1.0
        t = self.trackers[code]
        phase = self.get_phase(now)
        if t.crash_from_high and t.bounce_detected and phase == WhipsawPhase.DEAD_CAT_BOUNCE:
            return 0.3
        if phase == WhipsawPhase.STABILIZATION:
            return 0.5 if abs(t.drawdown_from_high_pct) > 0.15 else 0.7
        if phase == WhipsawPhase.AFTERNOON_TREND:
            return 1.0 if t.current_price > t.session_low * 1.05 else 0.6
        return self.TIME_ALLOCATION.get(phase, 0.0)

    def optimal_entry(self, code: str) -> Optional[int]:
        if code not in self.trackers: return None
        t = self.trackers[code]
        if not t.hit_near_limit_up: return None
        lo = int(t.session_high * (1 + self.CRASH_THRESHOLD_PCT))
        hi = int(t.session_high * (1 + self.SAFE_ENTRY_DRAWDOWN))
        return (lo + hi) // 2

    def emergency_sell(self, code: str) -> Tuple[bool, str]:
        if code not in self.trackers: return False, ""
        t = self.trackers[code]
        if t.sell_triggered:
            return True, f"긴급매도: {t.name} 고점비 {t.drawdown_from_high_pct:.1%}"
        return False, ""

    def reset_daily(self):
        for t in self.trackers.values():
            t.session_high = 0
            t.session_low = 999_999_999
            t.high_timestamp = None
            t.current_price = 0
            t.hit_near_limit_up = False
            t.crash_from_high = False
            t.bounce_detected = False
            t.buy_locked_until = None
            t.sell_triggered = False
        log.info("🔄 요동장 엔진 일일 리셋")

    def status_report(self) -> str:
        lines = ["─── 요동장 상태 ───"]
        for code, t in self.trackers.items():
            flag = ("🚨긴급" if t.sell_triggered else
                    "🔻급락" if t.crash_from_high else
                    "⚠️근접" if t.hit_near_limit_up else "✅")
            lines.append(f"  {flag} {t.name} 고점{t.session_high:,} "
                         f"현재{t.current_price:,} ({t.drawdown_from_high_pct:+.1%})")
        return "\n".join(lines)


# ═══════════════════════════════════════════════════════════════
# CHART ENGINES
# ═══════════════════════════════════════════════════════════════

class Chart1_MacroRegime:
    """
    CHART 1: 시장 국면 판단 → 나머지 차트의 Beta 조절
    """
    HISTORY = {
        'avg_1day': -0.01, 'avg_1week': +0.031, 'avg_1month': +0.046,
        'all_1month_positive': True, 'recovery_days': 20,
    }

    def __init__(self):
        self.war_start_date = datetime(2026, 2, 28)
        self.regime = Regime.CRISIS
        self.beta = 0.5

    @property
    def war_day_count(self) -> int:
        return (datetime.now() - self.war_start_date).days

    def evaluate(self, kospi: float, usdkrw: float, wti: float,
                 vkospi: float, foreign_net: float, news_sent: str) -> Tuple[Regime, float]:
        score = 0

        drop = (kospi - 6244) / 6244
        if drop < -0.10:   score -= 3
        elif drop < -0.07: score -= 1
        elif drop > -0.03: score += 2

        if usdkrw > 1500:   score -= 2
        elif usdkrw < 1440: score += 1

        if wti > 90:   score -= 3
        elif wti > 80: score -= 1
        else:          score += 1

        if vkospi > 35:   score -= 2
        elif vkospi < 20: score += 2

        if foreign_net > 10000:    score += 2
        elif foreign_net > 0:      score += 1
        elif foreign_net < -30000: score -= 2

        d = self.war_day_count
        if d <= 2:    score -= 2
        elif d <= 5:  score -= 1
        elif d <= 10: score += 1
        else:         score += 2

        if news_sent == 'EXTREME_POS':  score += 3
        elif news_sent == 'POS':        score += 1
        elif news_sent == 'NEG':        score -= 1
        elif news_sent == 'EXTREME_NEG': score -= 3

        if score <= -6:
            self.regime, self.beta = Regime.EXTREME_CRISIS, 0.2
        elif score <= -3:
            self.regime, self.beta = Regime.CRISIS, 0.5
        elif score <= 0:
            self.regime, self.beta = Regime.CAUTIOUS, 0.7
        elif score <= 4:
            self.regime, self.beta = Regime.RECOVERY, 1.0
        else:
            self.regime, self.beta = Regime.AGGRESSIVE, 1.5

        log.info(f"📊 MACRO: score={score}, regime={self.regime.value}, "
                 f"beta={self.beta}, war_day={d}")
        return self.regime, self.beta

    def get_sector_weights(self) -> dict:
        d = self.war_day_count
        if d <= 3:
            return {'defense': 0.40, 'energy': 0.25, 'semiconductor': 0.15, 'cash': 0.20}
        elif d <= 7:
            return {'defense': 0.35, 'energy': 0.20, 'semiconductor': 0.30, 'cash': 0.15}
        elif d <= 14:
            return {'defense': 0.25, 'energy': 0.15, 'semiconductor': 0.40, 'cash': 0.20}
        else:
            return {'defense': 0.20, 'energy': 0.10, 'semiconductor': 0.50, 'cash': 0.20}


class Chart2_DefenseScalp:
    """CHART 2: 방산주 스캘핑/스윙 — 요동장(Whipsaw) 대응 통합 버전"""

    def __init__(self, ta: TechnicalAnalysis, whipsaw: WhipsawDefenseEngine):
        self.ta = ta
        self.whipsaw = whipsaw

    @staticmethod
    def _cap_buy_quantity(raw_qty: int, current_price: int, per_stock_budget: int) -> int:
        if current_price <= 0:
            return 0
        per_stock_qty = max(1, int(per_stock_budget / current_price))
        return max(1, min(raw_qty, per_stock_qty))

    def generate_signal(self, code: str, minute_df: pd.DataFrame,
                        daily_df: pd.DataFrame, beta: float,
                        current_price: int, now: datetime = None,
                        holding_qty: int = 0,
                        total_budget: int = 100_000_000,
                        per_stock_budget: int = 15_000_000) -> Optional[Signal]:
        target = TARGETS.get(code)
        if not target or target.sector != 'defense':
            return None
        if current_price <= 0:
            return None

        if now is None:
            now = datetime.now()

        # ── STEP 0: 요동장 가격 업데이트 ──
        self.whipsaw.update_price(code, current_price, now)

        # ── STEP 1: 긴급 매도 (최우선) ──
        if holding_qty > 0:
            should_sell, reason = self.whipsaw.emergency_sell(code)
            if should_sell:
                return Signal(
                    code=code, name=target.name, action='SELL',
                    price=current_price, quantity=holding_qty,
                    confidence=99, chart='DEFENSE',
                    reason=f'[요동장 긴급매도] {reason}',
                )

        # ── STEP 2: 분봉 데이터 부족 → HOLD ──
        if minute_df.empty or len(minute_df) < 20:
            return None

        rsi_val   = self.ta.rsi(minute_df['close'], 9).iloc[-1]
        bb_u, bb_m, bb_l = self.ta.bollinger(minute_df['close'], 20, 2.0)
        vwap_val  = self.ta.vwap(minute_df).iloc[-1]
        vol_mean  = minute_df['volume'].rolling(20).mean().iloc[-1]
        vol_ratio = (minute_df['volume'].iloc[-1] / vol_mean) if vol_mean > 0 else 1

        # ── STEP 3: 요동장 매수 허용 체크 ──
        can_buy_flag, deny_reason = self.whipsaw.can_buy(code, now)
        phase = self.whipsaw.get_phase(now)

        if can_buy_flag:
            # 요동장 최적 진입가 vs VWAP 기반 선택
            opt_entry = self.whipsaw.optimal_entry(code)
            if opt_entry is not None:
                price_ok = current_price <= opt_entry
                price_reason = f'요동장진입가({current_price:,}≤{opt_entry:,})'
            else:
                price_ok = vwap_val * 0.995 <= current_price <= vwap_val * 1.02
                price_reason = f'VWAP({vwap_val:,.0f})±2%'

            buy_score = sum([
                price_ok,
                rsi_val < 45,
                current_price > bb_l.iloc[-1],
                vol_ratio > 1.2,
            ])

            if buy_score >= 3:
                base_qty = max(1, int(total_budget * target.sector_weight *
                                      SECTOR_ALLOCATION['defense'] * beta / current_price))
                mult = self.whipsaw.size_multiplier(code, now)
                qty = self._cap_buy_quantity(max(1, int(base_qty * mult)), current_price, per_stock_budget)
                return Signal(
                    code=code, name=target.name, action='BUY',
                    price=current_price, quantity=qty,
                    confidence=min(buy_score / 4 * 100 * mult, 95),
                    chart='DEFENSE',
                    reason=(f'[{phase.value}] {price_reason} '
                            f'RSI={rsi_val:.0f} 배수={mult:.0%}'),
                    stop_loss=int(current_price * (1 + target.stop_loss_pct)),
                    take_profit=int(current_price * 1.05),
                )

        # ── STEP 4: 일반 매도 (보유 중 + 과매수) ──
        if rsi_val > 75 or current_price > bb_u.iloc[-1] * 0.98:
            tracker = self.whipsaw.trackers.get(code)
            # 요동장 종목은 절반만 매도, 나머지 추세 추종
            qty = (holding_qty // 2 if tracker and tracker.hit_near_limit_up
                   else 0)   # 0 = 전량 (OrderExecutor가 실제 보유수량 사용)
            return Signal(
                code=code, name=target.name, action='SELL',
                price=current_price, quantity=qty,
                confidence=80, chart='DEFENSE',
                reason=(f'RSI과매수({rsi_val:.0f}) BB상단근접'
                        + (' [요동장 절반매도]' if qty > 0 else '')),
            )

        return None


class Chart3_EnergyOil:
    """CHART 3: 에너지 섹터 — 유가 연동"""

    def __init__(self, ta: TechnicalAnalysis):
        self.ta = ta

    @staticmethod
    def _cap_buy_quantity(raw_qty: int, current_price: int, per_stock_budget: int) -> int:
        if current_price <= 0:
            return 0
        per_stock_qty = max(1, int(per_stock_budget / current_price))
        return max(1, min(raw_qty, per_stock_qty))

    def generate_signal(self, code: str, minute_df: pd.DataFrame,
                        wti: float, wti_change: float, beta: float,
                        current_price: int, news_sent: str,
                        total_budget: int = 100_000_000,
                        per_stock_budget: int = 15_000_000) -> Optional[Signal]:
        target = TARGETS.get(code)
        if not target or target.sector != 'energy':
            return None
        if minute_df.empty or len(minute_df) < 10:
            return None

        if target.prev_close <= 0 or current_price <= 0:
            log.warning(f"⚠️ {code} prev_close={target.prev_close}, current={current_price} → 스킵")
            return None

        rsi_val = self.ta.rsi(minute_df['close'], 9).iloc[-1]

        if news_sent in ('POS', 'EXTREME_POS'):
            return Signal(
                code=code, name=target.name, action='SELL',
                price=current_price, quantity=0, confidence=90,
                chart='ENERGY', reason=f'휴전뉴스감지→에너지즉시청산',
            )

        if wti_change > 0.02 and rsi_val < 70:
            raw_qty = max(1, int(total_budget * target.sector_weight *
                                 SECTOR_ALLOCATION['energy'] * beta / max(current_price, 1)))
            qty = self._cap_buy_quantity(raw_qty, current_price, per_stock_budget)
            return Signal(
                code=code, name=target.name, action='BUY',
                price=current_price, quantity=qty,
                confidence=min(70 + wti_change * 500, 95),
                chart='ENERGY', reason=f'WTI+{wti_change*100:.1f}% RSI={rsi_val:.0f}',
                stop_loss=int(current_price * 0.95),
                take_profit=int(current_price * (1 + wti_change * 2.5)),
            )

        if wti_change < -0.015 or rsi_val > 80:
            return Signal(
                code=code, name=target.name, action='SELL',
                price=current_price, quantity=0, confidence=75,
                chart='ENERGY', reason=f'유가반전({wti_change*100:.1f}%) or RSI({rsi_val:.0f})',
            )

        return None


class Chart4_SemiContrarian:
    """CHART 4: 반도체 역발상 분할매수"""

    def __init__(self, ta: TechnicalAnalysis):
        self.ta = ta
        self.filled_levels: Dict[str, set] = {
            '005930': set(), '000660': set()
        }

    @staticmethod
    def _cap_buy_quantity(raw_qty: int, current_price: int, per_stock_budget: int) -> int:
        if current_price <= 0:
            return 0
        per_stock_qty = max(1, int(per_stock_budget / current_price))
        return max(1, min(raw_qty, per_stock_qty))

    def generate_signals(self, code: str, daily_df: pd.DataFrame,
                         current_price: int, beta: float,
                         war_day: int, nvidia_chg: float,
                         total_budget: int = 100_000_000,
                         per_stock_budget: int = 15_000_000) -> List[Signal]:
        target = TARGETS.get(code)
        if not target or target.sector != 'semiconductor':
            return []
        if not target.buy_levels:
            return []

        if current_price <= 0:
            return []

        signals = []

        for level in target.buy_levels:
            lid = level['label']
            if lid in self.filled_levels.get(code, set()):
                continue

            if current_price <= level['price']:
                war_mult = 1.0
                if war_day >= 3: war_mult = 1.2
                if war_day >= 7: war_mult = 1.5
                nv_boost = 1.3 if nvidia_chg > 0.02 else 1.0

                size = (level['pct'] * target.sector_weight *
                        SECTOR_ALLOCATION['semiconductor'] * beta * war_mult * nv_boost)
                raw_qty = max(1, int(total_budget * size / max(current_price, 1)))
                qty = self._cap_buy_quantity(raw_qty, current_price, per_stock_budget)

                signals.append(Signal(
                    code=code, name=target.name, action='BUY',
                    price=current_price, quantity=qty,
                    confidence=70 + war_day * 2 + (10 if nvidia_chg > 0 else 0),
                    chart='SEMI',
                    reason=(f'{lid}도달({current_price:,}≤{level["price"]:,}) '
                            f'war_d{war_day} nv={nvidia_chg*100:+.1f}%'),
                    stop_loss=int(level['price'] * 0.92),
                    take_profit=target.target_price,
                ))
                self.filled_levels[code].add(lid)

        pre_war_high = {'005930': 216500, '000660': 1061000}.get(code, 0)
        if current_price >= pre_war_high * 0.98 and pre_war_high > 0:
            signals.append(Signal(
                code=code, name=target.name, action='SELL',
                price=current_price, quantity=0,
                confidence=85, chart='SEMI',
                reason=f'전고점({pre_war_high:,}) 근접→50%익절',
            ))

        return signals


# ═══════════════════════════════════════════════════════════════
# REALTIME WEBSOCKET HANDLER
# ═══════════════════════════════════════════════════════════════

class RealtimeHandler:

    def __init__(self, on_tick_callback):
        self.on_tick = on_tick_callback
        self.ws = None
        self.prices: Dict[str, int] = {}
        self.hoga: Dict[str, dict] = {}
        self.last_tick_at: Dict[str, datetime] = {}
        self.minute_buffers: Dict[str, List[dict]] = {}
        self.last_message_at: Optional[datetime] = None
        self.connection_status: str = "disconnected"
        self.last_error: str = ""
        self._running = False

    def start(self):
        self._running = True
        t = threading.Thread(target=self._connect, daemon=True)
        t.start()

    def stop(self):
        self._running = False
        if self.ws:
            self.ws.close()

    def _connect(self):
        def on_message(ws, msg):
            try:
                data = json.loads(msg)
                self.last_message_at = datetime.now()
                msg_type = data.get('type', '')
                code = data.get('code', '')

                if msg_type == 'tick' and code:
                    tick = data.get('data', {})
                    price = int(str(tick.get('current_price', '0')).lstrip('-+'))
                    volume = int(str(tick.get('volume', '0')))

                    self.prices[code] = price
                    self.last_tick_at[code] = datetime.now()
                    _update_web_tick_state(code, price, volume)
                    self._update_minute_buffer(code, price, volume, tick)
                    self.on_tick(code, price, volume, tick)
                elif msg_type == 'hoga' and code:
                    self.hoga[code] = data.get('data', {}) or {}

            except Exception as e:
                log.debug(f"WS parse error: {e}")

        def on_error(ws, error):
            self.connection_status = "error"
            self.last_error = str(error)
            log.warning(f"WS error: {error}")

        def on_close(ws, code, reason):
            self.connection_status = "closed"
            log.info(f"WS closed: {code} {reason}")
            if self._running:
                time.sleep(3)
                self._connect()

        def on_open(ws):
            self.connection_status = "connected"
            self.last_error = ""

        self.ws = websocket.WebSocketApp(
            WS_REALTIME,
            on_message=on_message,
            on_error=on_error,
            on_close=on_close,
            on_open=on_open,
        )
        self.ws.run_forever()

    def _update_minute_buffer(self, code, price, volume, tick):
        if code not in self.minute_buffers:
            self.minute_buffers[code] = []
        now = datetime.now()
        minute_key = now.strftime('%Y%m%d%H%M')

        buf = self.minute_buffers[code]
        if buf and buf[-1].get('_key') == minute_key:
            bar = buf[-1]
            bar['high'] = max(bar['high'], price)
            bar['low'] = min(bar['low'], price)
            bar['close'] = price
            bar['volume'] += volume
        else:
            buf.append({
                '_key': minute_key,
                'time': now,
                'open': price, 'high': price,
                'low': price, 'close': price,
                'volume': volume,
            })
            if len(buf) > 200:
                buf.pop(0)

    def get_minute_df(self, code: str) -> pd.DataFrame:
        buf = self.minute_buffers.get(code, [])
        if not buf:
            return pd.DataFrame()
        df = pd.DataFrame(buf)
        return df[['time', 'open', 'high', 'low', 'close', 'volume']]


# ═══════════════════════════════════════════════════════════════
# RISK MANAGER
# ═══════════════════════════════════════════════════════════════

class RiskManager:

    MAX_DAILY_LOSS = -0.06       # -0.05→-0.06 (전쟁 변동성 반영)
    MAX_DRAWDOWN = -0.15         # -0.12→-0.15
    MIN_CASH = 0.10

    def __init__(self, total_capital: int):
        self.total_capital = total_capital
        self.per_stock_budget = total_capital
        self.daily_pnl = 0
        self.max_equity = total_capital
        self.realized_pnl = 0    # 실현 손익 (매도 체결 누적)
        self.unrealized_pnl = 0  # 미실현 손익 (보유 평가)

    def on_sell_executed(self, sell_price: int, avg_buy_price: int, quantity: int):
        """매도 체결 시 실현 손익 반영"""
        pnl = (sell_price - avg_buy_price) * quantity
        self.realized_pnl += pnl
        self.daily_pnl = self.realized_pnl + self.unrealized_pnl
        log.info(f"💰 실현손익 갱신: 이번 {pnl:+,}원, "
                 f"누적실현 {self.realized_pnl:+,}원, "
                 f"일일합산 {self.daily_pnl:+,}원")

    def update_unrealized_pnl(self, holdings: list, current_prices: dict):
        """보유종목 미실현 손익 실시간 반영 + max_equity 갱신"""
        unrealized = 0
        for h in holdings:
            code = h.get('종목코드', '').strip()
            qty = int(h.get('보유수량', '0'))
            avg_price = int(h.get('매입단가', '0'))
            cur_price = current_prices.get(code, avg_price)
            unrealized += (cur_price - avg_price) * qty
        self.unrealized_pnl = unrealized
        self.daily_pnl = self.realized_pnl + self.unrealized_pnl

        current_equity = self.total_capital + self.daily_pnl
        if current_equity > self.max_equity:
            self.max_equity = current_equity

    def reset_daily(self):
        """매일 장 시작 시 일일 손익 초기화"""
        log.info(f"🔄 전일 최종 손익: {self.daily_pnl:+,}원 → 초기화")
        self.daily_pnl = 0
        self.realized_pnl = 0
        self.unrealized_pnl = 0

    def can_buy(self, signal: Signal, current_holdings: list) -> bool:
        if self.total_capital > 0 and \
           self.daily_pnl / self.total_capital < self.MAX_DAILY_LOSS:
            log.warning(f"⛔ 일일 손실 한도 초과 "
                        f"({self.daily_pnl/self.total_capital*100:.1f}% < "
                        f"{self.MAX_DAILY_LOSS*100:.0f}%) → 매수 차단")
            return False

        equity = self.total_capital + self.daily_pnl
        if self.max_equity > 0:
            dd = (equity - self.max_equity) / self.max_equity
            if dd < self.MAX_DRAWDOWN:
                log.warning(f"⛔ 총 낙폭 한도({dd*100:.1f}% < "
                            f"{self.MAX_DRAWDOWN*100:.0f}%) → 전면 매매 중단")
                return False

        return True

    def adjust_quantity(self, signal: Signal) -> int:
        if signal.price > 0:
            configured_qty = int(self.per_stock_budget / signal.price) if self.per_stock_budget > 0 else signal.quantity
            if configured_qty <= 0:
                return 0
            return min(signal.quantity, configured_qty)
        return signal.quantity


# ═══════════════════════════════════════════════════════════════
# ORDER EXECUTOR
# ═══════════════════════════════════════════════════════════════

class OrderExecutor:

    def __init__(self, api: Server32Client, risk: RiskManager, event_recorder=None):
        self.api = api
        self.risk = risk
        self.event_recorder = event_recorder
        self.pending_signals: List[Signal] = []
        self.executed_orders: List[dict] = []
        self.order_cooldowns: Dict[str, datetime] = {}

    def _cooldown_open(self, code: str, action: str, seconds: int = 10) -> bool:
        key = f"{code}:{action}"
        until = self.order_cooldowns.get(key)
        if until and datetime.now() < until:
            return True
        self.order_cooldowns[key] = datetime.now() + timedelta(seconds=seconds)
        return False

    def process_signal(self, signal: Signal, holdings: list):
        if signal.action == 'HOLD':
            return

        signal.timestamp = datetime.now().strftime('%Y%m%d%H%M%S')
        if self._cooldown_open(signal.code, signal.action):
            if self.event_recorder:
                self.event_recorder({
                    "kind": "order_blocked",
                    "source": "auto",
                    "action": signal.action,
                    "code": signal.code,
                    "name": signal.name,
                    "qty": signal.quantity,
                    "price": signal.price,
                    "chart": signal.chart,
                    "reason": f"중복주문 쿨다운 차단: {signal.reason}",
                    "status": "blocked",
                    "signal_ts": signal.timestamp,
                    "stop_loss": signal.stop_loss,
                    "take_profit": signal.take_profit,
                })
            return

        if signal.action == 'BUY':
            if not self.risk.can_buy(signal, holdings):
                return
            qty = self.risk.adjust_quantity(signal)
            if qty <= 0:
                return

            log.info(f"🟢 매수실행: {signal.name}({signal.code}) "
                     f"{qty}주 @ {signal.price:,}원 [{signal.chart}] "
                     f"이유: {signal.reason}")

            result = self.api.send_order(
                code=signal.code,
                order_type=1,
                quantity=qty,
                price=signal.price,
                quote_type='00',
            )
            if self.event_recorder:
                self.event_recorder({
                    "kind": "order_submit",
                    "source": "auto",
                    "action": "BUY",
                    "code": signal.code,
                    "name": signal.name,
                    "qty": qty,
                    "price": signal.price,
                    "chart": signal.chart,
                    "reason": signal.reason,
                    "status": "accepted" if result.get("Success") else "failed",
                    "message": result.get("Message", ""),
                    "signal_ts": signal.timestamp,
                    "stop_loss": signal.stop_loss,
                    "take_profit": signal.take_profit,
                })
            self.executed_orders.append({
                'signal': signal, 'result': result, 'time': signal.timestamp
            })

        elif signal.action == 'SELL':
            held_qty = 0
            avg_buy_price = 0
            for h in holdings:
                if h.get('종목코드', '').strip() == signal.code:
                    held_qty = int(h.get('보유수량', '0'))
                    avg_buy_price = int(h.get('매입단가', '0'))
                    break

            sell_qty = held_qty if signal.quantity == 0 else min(signal.quantity, held_qty)
            if sell_qty <= 0:
                return

            log.info(f"🔴 매도실행: {signal.name}({signal.code}) "
                     f"{sell_qty}주 @ 시장가 [{signal.chart}] "
                     f"이유: {signal.reason}")

            result = self.api.send_order(
                code=signal.code,
                order_type=2,
                quantity=sell_qty,
                price=0,
                quote_type='03',
            )
            if self.event_recorder:
                self.event_recorder({
                    "kind": "order_submit",
                    "source": "auto",
                    "action": "SELL",
                    "code": signal.code,
                    "name": signal.name,
                    "qty": sell_qty,
                    "price": signal.price,
                    "chart": signal.chart,
                    "reason": signal.reason,
                    "status": "accepted" if result.get("Success") else "failed",
                    "message": result.get("Message", ""),
                    "signal_ts": signal.timestamp,
                    "stop_loss": signal.stop_loss,
                    "take_profit": signal.take_profit,
                })

            if result.get('Success') and avg_buy_price > 0:
                self.risk.on_sell_executed(
                    sell_price=signal.price,
                    avg_buy_price=avg_buy_price,
                    quantity=sell_qty,
                )

            self.executed_orders.append({
                'signal': signal, 'result': result, 'time': signal.timestamp
            })


# ═══════════════════════════════════════════════════════════════
# EXECUTION WEBSOCKET
# ═══════════════════════════════════════════════════════════════

class ExecutionHandler:

    def __init__(self, on_execution_callback):
        self.on_exec = on_execution_callback
        self.ws = None

    def start(self):
        t = threading.Thread(target=self._connect, daemon=True)
        t.start()

    def _connect(self):
        def on_message(ws, msg):
            try:
                data = json.loads(msg)
                self.on_exec(data)
            except:
                pass

        self.ws = websocket.WebSocketApp(
            WS_EXECUTION,
            on_message=on_message,
        )
        self.ws.run_forever()


# ═══════════════════════════════════════════════════════════════
# MASTER ENGINE
# ═══════════════════════════════════════════════════════════════

class WarAdaptiveEngine:
    """
    WAR-ADAPTIVE MULTI-CHART TRADING ENGINE
    이란 공습 대응형 실전 자동매매 마스터 엔진
    server32 + MySQL + 외부크롤링 + 4차트 통합
    """

    TOTAL_CAPITAL = 100_000_000  # 1억원
    CYCLE_INTERVAL = 60
    EXTERNAL_INTERVAL = 300
    CENTRAL_HISTORY_MIN_BARS = 60
    CENTRAL_HISTORY_REFRESH_SEC = 20
    CENTRAL_HISTORY_MAX_WORKERS = 10
    DEFAULT_TRADE_CONFIG = {
        "total_budget": 5_000_000,
        "per_stock": 1_000_000,
        "strategies": {
            "macro": True,
            "defense": True,
            "energy": True,
            "semi": True,
        },
    }

    def __init__(self):
        log.info("=" * 60)
        log.info("  WAR-ADAPTIVE ENGINE 초기화 시작")
        log.info("=" * 60)

        self.api = Server32Client()
        self.db = MySQLClient()
        self.ext = ExternalDataCollector()
        self.ta = TechnicalAnalysis()
        self.risk = RiskManager(self.TOTAL_CAPITAL)
        self.executor = OrderExecutor(self.api, self.risk, event_recorder=self.record_trade_event)
        self.targets = TARGETS

        self.whipsaw = WhipsawDefenseEngine()
        self.chart1 = Chart1_MacroRegime()
        self.chart2 = Chart2_DefenseScalp(self.ta, self.whipsaw)
        self.chart3 = Chart3_EnergyOil(self.ta)
        self.chart4 = Chart4_SemiContrarian(self.ta)

        self.rt = RealtimeHandler(on_tick_callback=self._on_tick)
        self.exec_handler = ExecutionHandler(on_execution_callback=self._on_execution)

        self._last_external_update = datetime.min
        self._last_realtime_recover = datetime.min
        self._cycle_count = 0
        self._running = False
        self.auto_trading_enabled = False
        self.trade_log_dir = Path(__file__).resolve().parent / "trade_logs"
        self.trade_log_dir.mkdir(exist_ok=True)
        self._last_candle_sync_at: Dict[str, datetime] = {}
        self._last_auto_disable_reason = ""
        self.trade_config = {
            "total_budget": self.DEFAULT_TRADE_CONFIG["total_budget"],
            "per_stock": self.DEFAULT_TRADE_CONFIG["per_stock"],
            "strategies": dict(self.DEFAULT_TRADE_CONFIG["strategies"]),
        }

    def record_trade_event(self, event: dict):
        ts = event.get("ts") or datetime.now().isoformat()
        payload = {
            "ts": ts,
            "kind": event.get("kind", "log"),
            "source": event.get("source", "system"),
            "action": event.get("action", ""),
            "code": event.get("code", ""),
            "name": event.get("name", ""),
            "qty": int(event.get("qty", 0) or 0),
            "price": _parse_int(event.get("price", 0), 0),
            "chart": event.get("chart", ""),
            "reason": event.get("reason", ""),
            "status": event.get("status", ""),
            "message": event.get("message", ""),
            "signal_ts": event.get("signal_ts", ""),
            "stop_loss": _parse_int(event.get("stop_loss", 0), 0),
            "take_profit": _parse_int(event.get("take_profit", 0), 0),
            "raw": event.get("raw"),
        }
        trade_logs = engine_state.get("trade_logs", [])
        trade_logs.insert(0, payload)
        engine_state["trade_logs"] = trade_logs[:500]

        log_path = self.trade_log_dir / f"trades_{datetime.now().strftime('%Y%m%d')}.jsonl"
        with log_path.open("a", encoding="utf-8") as fp:
            fp.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")

    def _get_trade_config(self) -> dict:
        config = self.trade_config or {}
        strategies = dict(self.DEFAULT_TRADE_CONFIG["strategies"])
        strategies.update(config.get("strategies", {}))
        return {
            "total_budget": int(config.get("total_budget", self.DEFAULT_TRADE_CONFIG["total_budget"])),
            "per_stock": int(config.get("per_stock", self.DEFAULT_TRADE_CONFIG["per_stock"])),
            "strategies": {key: bool(value) for key, value in strategies.items()},
        }

    def _sync_risk_budget(self, total_budget: int, per_stock_budget: int):
        if self.risk.total_capital == total_budget and self.risk.per_stock_budget == per_stock_budget:
            return
        self.risk.total_capital = total_budget
        self.risk.per_stock_budget = per_stock_budget
        self.risk.max_equity = max(self.risk.max_equity, total_budget + self.risk.daily_pnl)
        log.info(f"⚙️ 실전 투자금 설정 반영: 총 {total_budget:,}원 / 종목당 {per_stock_budget:,}원")

    def build_buy_levels_map(self) -> dict:
        levels = {}
        for code, target in self.targets.items():
            row = {}
            for item in target.buy_levels:
                if item.get("label") and item.get("price"):
                    row[item["label"]] = int(item["price"])
            levels[code] = row
        return levels

    def build_prev_close_map(self) -> dict:
        data = {}
        for code, target in self.targets.items():
            data[code] = int(getattr(target, "prev_close", 0) or 0)
        return data

    def refresh_prev_closes(self):
        today = datetime.now().strftime('%Y%m%d')
        stop = (datetime.now() - timedelta(days=10)).strftime('%Y%m%d')
        for code, target in self.targets.items():
            raw = self.api.get_daily_candles(code, today, stop)
            if not raw:
                continue
            rows = [r for r in raw if str(r.get('일자', ''))]
            if not rows:
                continue
            rows.sort(key=lambda r: str(r.get('일자', '')), reverse=True)
            selected = None
            if str(rows[0].get('일자', '')) == today and len(rows) > 1:
                selected = rows[1]
            else:
                selected = rows[0]
            prev_close = _parse_int(selected.get('현재가', 0), 0)
            if prev_close > 0:
                target.prev_close = prev_close

    def build_hoga_analysis(self, code: str) -> dict:
        raw = self.rt.hoga.get(code, {}) or {}
        ask_total = int(raw.get('total_ask_vol', 0) or 0)
        bid_total = int(raw.get('total_bid_vol', 0) or 0)
        best_ask = int(raw.get('ask_price_1', 0) or 0)
        best_bid = int(raw.get('bid_price_1', 0) or 0)
        imbalance = round((bid_total / ask_total), 2) if ask_total > 0 else None
        pressure = (
            '매수우위' if imbalance is not None and imbalance >= 1.2 else
            '매도우위' if imbalance is not None and imbalance <= 0.8 else
            '중립'
        )
        return {
            "best_ask": best_ask,
            "best_bid": best_bid,
            "spread": max(0, best_ask - best_bid) if best_ask and best_bid else 0,
            "ask_total": ask_total,
            "bid_total": bid_total,
            "imbalance": imbalance,
            "pressure": pressure,
        }

    def _minute_df_to_lw(self, df: pd.DataFrame) -> list:
        if df is None or df.empty:
            return []
        candles = []
        for _, row in df.sort_values("time").iterrows():
            dt = row.get("time")
            if pd.isna(dt):
                continue
            ts = int(pd.Timestamp(dt).timestamp())
            candles.append({
                "time": ts - (ts % 60),
                "open": _parse_int(row.get("open", 0), 0),
                "high": _parse_int(row.get("high", 0), 0),
                "low": _parse_int(row.get("low", 0), 0),
                "close": _parse_int(row.get("close", 0), 0),
                "volume": _parse_int(row.get("volume", 0), 0),
            })
        return candles

    def _fetch_central_candles_for_code(self, code: str, stop_time: str) -> tuple[str, list]:
        api_code = "U001" if code == "KOSPI" else code
        raw = self.api.get_minute_candles(api_code, tick=1, stop_time=stop_time)
        if not raw:
            return code, []
        parsed = self._parse_minute_candles(raw)
        fetched = self._minute_df_to_lw(parsed)
        return code, fetched

    def sync_central_candle_history(self, force: bool = False):
        candle_hist = engine_state.setdefault("candle_history", {})
        codes = ["KOSPI", *list(TARGETS.keys())]
        stop_time = (datetime.now() - timedelta(days=3)).strftime("%Y%m%d090000")
        pending_codes = []

        for code in codes:
            bars = candle_hist.get(code, [])
            last_sync = self._last_candle_sync_at.get(code)
            recently_synced = last_sync and (datetime.now() - last_sync).total_seconds() < self.CENTRAL_HISTORY_REFRESH_SEC
            if not force and recently_synced and len(bars) >= self.CENTRAL_HISTORY_MIN_BARS:
                continue
            pending_codes.append(code)

        if not pending_codes:
            return

        max_workers = min(self.CENTRAL_HISTORY_MAX_WORKERS, len(pending_codes))
        started_at = datetime.now()
        completed = 0
        failed = 0

        log.info(
            f"중앙 캔들 병렬 동기화 시작: {len(pending_codes)}종목 "
            f"(workers={max_workers}, force={force}) -> {', '.join(pending_codes)}"
        )

        with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="candle-sync") as executor:
            futures = {
                executor.submit(self._fetch_central_candles_for_code, code, stop_time): code
                for code in pending_codes
            }
            for future in as_completed(futures):
                code = futures[future]
                try:
                    result_code, fetched = future.result()
                except Exception as exc:
                    failed += 1
                    log.warning(f"중앙 캔들 병렬 수집 실패: {code} / {exc}")
                    continue
                elapsed = (datetime.now() - started_at).total_seconds()
                if not fetched:
                    failed += 1
                    log.warning(
                        f"중앙 캔들 병렬 수집 빈응답: {result_code} "
                        f"({completed + failed}/{len(pending_codes)}, {elapsed:.2f}s)"
                    )
                    continue
                bars = candle_hist.get(result_code, [])
                candle_hist[result_code] = _merge_lw_candles(fetched, bars)[-600:]
                self._last_candle_sync_at[result_code] = datetime.now()
                completed += 1
                log.info(
                    f"중앙 캔들 병렬 수집 완료: {result_code} "
                    f"{len(fetched)}bars -> merged {len(candle_hist[result_code])}bars "
                    f"({completed + failed}/{len(pending_codes)}, {elapsed:.2f}s)"
                )

        elapsed = (datetime.now() - started_at).total_seconds()
        log.info(
            f"중앙 캔들 병렬 동기화 종료: success={completed}, failed={failed}, "
            f"total={len(pending_codes)} ({elapsed:.2f}s, workers={max_workers})"
        )

    def assess_data_readiness(self) -> dict:
        candle_hist = engine_state.get("candle_history", {})
        required_codes = list(TARGETS.keys())
        ready_codes = []
        loading_codes = []

        for code in required_codes:
            bars = candle_hist.get(code, [])
            if len(bars) >= self.CENTRAL_HISTORY_MIN_BARS:
                ready_codes.append(code)
            else:
                loading_codes.append(code)

        ready = len(loading_codes) == 0
        if ready:
            status = "ready"
            reason = "중앙 캔들 준비 완료"
        elif ready_codes:
            status = "loading"
            names = [self.targets.get(code).name if code in self.targets else code for code in loading_codes[:3]]
            reason = f"캔들 로딩중: {', '.join(names)}"
        else:
            status = "cold_start"
            reason = "중앙 캔들 초기 수집중"

        return {
            "ready": ready,
            "status": status,
            "reason": reason,
            "required_bars": self.CENTRAL_HISTORY_MIN_BARS,
            "ready_count": len(ready_codes),
            "required_count": len(required_codes),
            "loading_codes": loading_codes[:6],
        }

    def _calc_recent_atr(self, code: str, period: int = 14) -> float:
        min_df = self.rt.get_minute_df(code)
        if len(min_df) < period + 2:
            raw = self.api.get_minute_candles(code, tick=1)
            if raw:
                min_df = self._parse_minute_candles(raw)
        if len(min_df) < period + 1:
            return 0.0

        high = min_df['high'].astype(float)
        low = min_df['low'].astype(float)
        close = min_df['close'].astype(float)
        prev_close = close.shift(1)
        tr = pd.concat([
            high - low,
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ], axis=1).max(axis=1)
        atr = tr.rolling(period).mean().iloc[-1]
        return float(atr) if pd.notna(atr) else 0.0

    def generate_protective_signals(self, holdings: list) -> List[Signal]:
        signals: List[Signal] = []
        overlays = self.build_position_overlays(holdings)
        now_ts = datetime.now().strftime('%Y%m%d%H%M%S')
        for code, overlay in overlays.items():
            current_price = int(overlay.get("current_price", 0) or 0)
            atr_stop = int(overlay.get("atr_stop", 0) or 0)
            hard_stop = int(overlay.get("stop", 0) or 0)
            if current_price <= 0:
                continue
            trigger_price = max(atr_stop, hard_stop)
            if trigger_price > 0 and current_price <= trigger_price:
                signals.append(Signal(
                    code=code,
                    name=self.targets.get(code).name if code in self.targets else code,
                    action='SELL',
                    price=current_price,
                    quantity=0,
                    confidence=0.99,
                    chart='RISK',
                    reason=f'ATR 보호손절 발동 ({current_price:,} <= {trigger_price:,})',
                    stop_loss=trigger_price,
                    take_profit=int(overlay.get("atr_target", 0) or overlay.get("target", 0) or 0),
                    timestamp=now_ts,
                ))
        return signals

    def build_position_overlays(self, holdings: list) -> dict:
        overlays = {}
        for h in holdings:
            code = h.get('종목코드', '').strip()
            qty = _parse_int(h.get('보유수량', '0'), 0)
            avg_price = _parse_int(h.get('매입단가', '0'), 0)
            if not code or qty <= 0 or avg_price <= 0:
                continue
            balance_price = _parse_int(h.get('현재가', 0), 0)
            current_price = balance_price or self.rt.prices.get(code, avg_price)
            target = self.targets.get(code)
            base_stop = int(avg_price * (1 + target.stop_loss_pct)) if target else 0
            take_profit = int(target.target_price) if target else 0
            atr = self._calc_recent_atr(code)
            atr_stop = int(max(base_stop, max(avg_price, current_price) - atr * 2.2)) if atr > 0 else base_stop
            atr_target = int(max(take_profit, avg_price + atr * 3.5)) if atr > 0 else take_profit
            pnl = (current_price - avg_price) * qty
            pnl_pct = round((current_price / avg_price - 1) * 100, 2) if avg_price > 0 else 0
            last_tick_at = self.rt.last_tick_at.get(code)
            stale_seconds = int((datetime.now() - last_tick_at).total_seconds()) if last_tick_at else None
            overlays[code] = {
                "qty": qty,
                "avg_price": avg_price,
                "current_price": current_price,
                "pnl": pnl,
                "pnl_pct": pnl_pct,
                "stop": base_stop,
                "target": take_profit,
                "atr": round(atr, 2) if atr > 0 else 0,
                "atr_stop": atr_stop,
                "atr_target": atr_target,
                "marker_time": _bar_time_from_timestamp(),
                "stale_seconds": stale_seconds,
                "is_stale": bool(stale_seconds is not None and stale_seconds > 15),
                "hoga": self.build_hoga_analysis(code),
            }
        return overlays

    def assess_data_health(self) -> dict:
        codes = list(self.targets.keys())
        now = datetime.now()
        stale_codes = []
        latest_tick_at = None
        latest_bar_at = None
        for code in codes:
            tick_at = self.rt.last_tick_at.get(code)
            if tick_at:
                if latest_tick_at is None or tick_at > latest_tick_at:
                    latest_tick_at = tick_at
            else:
                stale_codes.append(code)
                continue
            age = (now - tick_at).total_seconds()
            if age > 15:
                stale_codes.append(code)

            buf = self.rt.minute_buffers.get(code, [])
            if buf:
                bar_time = buf[-1].get('time')
                if isinstance(bar_time, datetime) and (latest_bar_at is None or bar_time > latest_bar_at):
                    latest_bar_at = bar_time

        stale_ratio = (len(stale_codes) / len(codes)) if codes else 0
        status = "ok"
        reason = "실시간 정상"
        if self.rt.connection_status != "connected":
            status = "critical"
            reason = f"실시간 WS {self.rt.connection_status}"
        elif stale_ratio >= 0.5:
            status = "critical"
            reason = f"틱 정지 {len(stale_codes)}/{len(codes)}종목"
        elif stale_codes:
            status = "warning"
            reason = f"부분 지연 {len(stale_codes)}종목"

        if latest_bar_at and (now - latest_bar_at).total_seconds() > 90:
            status = "critical"
            reason = "신규봉 생성 지연"

        return {
            "status": status,
            "reason": reason,
            "connection": self.rt.connection_status,
            "last_error": self.rt.last_error,
            "stale_codes": stale_codes[:6],
            "stale_count": len(stale_codes),
            "last_tick_at": latest_tick_at.isoformat() if latest_tick_at else None,
            "last_bar_at": latest_bar_at.isoformat() if latest_bar_at else None,
        }

    def recover_realtime_if_needed(self, data_health: dict):
        if data_health.get("status") != "critical":
            return
        if (datetime.now() - self._last_realtime_recover).total_seconds() < 20:
            return

        self._last_realtime_recover = datetime.now()
        reason = data_health.get("reason", "unknown")
        log.warning(f"🚨 실시간 비상복구 시도: {reason}")
        self.record_trade_event({
            "kind": "realtime_recover",
            "source": "system",
            "action": "",
            "code": "",
            "name": "실시간복구",
            "qty": 0,
            "price": 0,
            "status": "retry",
            "reason": reason,
            "message": "WS 재연결 및 종목 재구독 시도",
        })
        try:
            self.api.unsubscribe_realtime()
        except Exception:
            pass
        try:
            self.rt.stop()
        except Exception:
            pass
        time.sleep(1)
        self.rt.start()
        time.sleep(1)
        try:
            self.api.subscribe_realtime(list(self.targets.keys()), screen='1000')
            log.info("📡 실시간 재구독 완료")
        except Exception as e:
            log.warning(f"실시간 재구독 실패: {e}")

    def refresh_web_state(self, all_signals: Optional[List[Signal]] = None, manual_signal: Optional[dict] = None) -> list:
        holdings = self.api.get_balance()
        if manual_signal:
            manual_signals = engine_state.get("manual_signals", [])
            manual_signals.insert(0, manual_signal)
            engine_state["manual_signals"] = manual_signals[:100]
        _update_web_state_v2(self, holdings, all_signals or [])
        return holdings

    def initialize(self) -> bool:
        if not self.api.login():
            log.error("❌ 로그인 실패 — 서버 확인 필요")
            return False

        status = self.api.check_status()
        if not status.get('Data', {}).get('IsLoggedIn'):
            log.error("❌ 세션 미확인")
            return False

        dash = self.api.get_dashboard(refresh=True)
        deposit = self.api.get_deposit()
        log.info(f"💰 계좌: {self.api.account_no}")
        log.info(f"💰 예수금: {deposit}")
        self.refresh_prev_closes()

        for code, target in TARGETS.items():
            info = self.db.get_stock_info(code)
            if info:
                log.info(f"  📌 {target.name} ({code}): "
                         f"시총={info.get('market_cap', 0)/100_000_000:.0f}억 "
                         f"PER={info.get('per', 0):.1f}")
            if target.prev_close == 0:
                sym = self.api.get_symbol_info(code)
                if sym:
                    target.prev_close = int(sym.get('last_price', 0))

        self.ext.update_all()
        self.sync_central_candle_history(force=True)

        self.rt.start()
        self.exec_handler.start()
        time.sleep(1)

        all_codes = list(TARGETS.keys())
        self.api.subscribe_realtime(all_codes, screen='1000')
        self.sync_central_candle_history(force=True)
        log.info(f"📡 실시간 구독: {len(all_codes)}종목")

        # 요동장 엔진에 방산·에너지 종목 등록
        for code, target in TARGETS.items():
            if target.sector in ('defense', 'energy') and target.prev_close > 0:
                self.whipsaw.register(code, target.name, target.prev_close)
                log.info(f"  요동장 등록: {target.name} ({code})")

        log.info("✅ 초기화 완료 — 엔진 가동 준비")
        return True

    def _on_tick(self, code: str, price: int, volume: int, raw: dict):
        # 요동장 엔진 실시간 가격 업데이트 (틱마다)
        self.whipsaw.update_price(code, price, datetime.now())

    def _on_execution(self, data: dict):
        msg_type = data.get('type', '')
        raw = data.get('data', {}) or {}
        if msg_type == 'order':
            log.info(f"✅ 체결알림: {json.dumps(raw, ensure_ascii=False)[:200]}")
            code = str(raw.get('종목코드', '') or raw.get('code', '')).strip()
            target_name = self.targets.get(code).name if code in self.targets else ''
            name = str(raw.get('종목명', '') or target_name or raw.get('name', '')).strip()
            qty = _parse_int(raw.get('체결수량', raw.get('주문수량', 0)), 0)
            price = _parse_int(raw.get('체결가', raw.get('주문가격', raw.get('현재가', 0))), 0)
            side = str(raw.get('주문구분', raw.get('매매구분', ''))).upper()
            action = 'SELL' if ('매도' in side or side.endswith('2')) else 'BUY' if ('매수' in side or side.endswith('1')) else ''
            self.record_trade_event({
                "kind": "execution",
                "source": "execution_ws",
                "action": action,
                "code": code,
                "name": name or code,
                "qty": qty,
                "price": price,
                "status": "filled",
                "message": str(raw.get('상태', raw.get('message', '체결알림'))),
                "raw": raw,
            })

    def run(self):
        self._running = True
        log.info("🚀 메인 루프 시작")

        while self._running:
            try:
                self._cycle_count += 1
                cycle_start = time.time()

                if (datetime.now() - self._last_external_update).seconds > self.EXTERNAL_INTERVAL:
                    self.ext.update_all()
                    self._last_external_update = datetime.now()

                kospi_price = self.rt.prices.get('KOSPI', 5792)
                regime, beta = self.chart1.evaluate(
                    kospi=kospi_price,
                    usdkrw=self.ext.usdkrw,
                    wti=self.ext.latest_wti,
                    vkospi=self.ext.vkospi,
                    foreign_net=self.ext.foreign_net_buy,
                    news_sent=self.ext.news_sentiment,
                )
                data_health = self.assess_data_health()
                self.sync_central_candle_history()
                data_readiness = self.assess_data_readiness()
                self.recover_realtime_if_needed(data_health)
                if self.auto_trading_enabled and (data_health["status"] != "ok" or not data_readiness["ready"]):
                    block_reason = data_health["reason"] if data_health["status"] != "ok" else data_readiness["reason"]
                    self.auto_trading_enabled = False
                    if self._last_auto_disable_reason != block_reason:
                        self.record_trade_event({
                            "kind": "auto_disabled",
                            "source": "system",
                            "action": "",
                            "code": "",
                            "name": "자동매매중지",
                            "qty": 0,
                            "price": 0,
                            "status": "forced_off",
                            "reason": block_reason,
                            "message": "데이터 이상 또는 캔들 미준비로 자동매매를 강제 중지했습니다.",
                        })
                        self._last_auto_disable_reason = block_reason
                elif data_health["status"] == "ok" and data_readiness["ready"]:
                    self._last_auto_disable_reason = ""

                holdings = self.api.get_balance()
                now = datetime.now()
                trade_cfg = self._get_trade_config()
                self.trade_config = trade_cfg
                self._sync_risk_budget(trade_cfg["total_budget"], trade_cfg["per_stock"])

                # 미실현 손익 갱신 (매 사이클)
                self.risk.update_unrealized_pnl(holdings, self.rt.prices)

                # 일일 초기화 (08:50 — 장 시작 10분 전)
                if now.hour == 8 and now.minute == 50 and now.second < self.CYCLE_INTERVAL:
                    self.risk.reset_daily()
                    self.whipsaw.reset_daily()

                all_signals: List[Signal] = []
                all_signals.extend(self.generate_protective_signals(holdings))

                for code, target in TARGETS.items():
                    price = self.rt.prices.get(code, target.prev_close)
                    if price <= 0:
                        continue

                    min_df = self.rt.get_minute_df(code)
                    if len(min_df) < 20:
                        raw = self.api.get_minute_candles(code, tick=5)
                        if raw:
                            min_df = self._parse_minute_candles(raw)

                    daily_df = self.db.get_daily_candles_df(code, days=60)

                    if target.sector == 'defense' and trade_cfg["strategies"].get("defense", True):
                        held = next((int(h.get('보유수량', '0')) for h in holdings
                                     if h.get('종목코드', '').strip() == code), 0)
                        sig = self.chart2.generate_signal(
                            code, min_df, daily_df, beta, price,
                            now=now, holding_qty=held,
                            total_budget=trade_cfg["total_budget"],
                            per_stock_budget=trade_cfg["per_stock"],
                        )
                        if sig:
                            all_signals.append(sig)

                    elif target.sector == 'energy' and trade_cfg["strategies"].get("energy", True):
                        sig = self.chart3.generate_signal(
                            code, min_df, self.ext.latest_wti,
                            self.ext.wti_change_pct, beta, price,
                            self.ext.news_sentiment,
                            total_budget=trade_cfg["total_budget"],
                            per_stock_budget=trade_cfg["per_stock"],
                        )
                        if sig:
                            all_signals.append(sig)

                    elif target.sector == 'semiconductor' and trade_cfg["strategies"].get("semi", True):
                        sigs = self.chart4.generate_signals(
                            code, daily_df, price, beta,
                            self.chart1.war_day_count,
                            self.ext.nvidia_change,
                            total_budget=trade_cfg["total_budget"],
                            per_stock_budget=trade_cfg["per_stock"],
                        )
                        all_signals.extend(sigs)

                for sig in all_signals:
                    if self.auto_trading_enabled and data_health["status"] == "ok" and data_readiness["ready"]:
                        self.executor.process_signal(sig, holdings)
                    elif self.auto_trading_enabled and (data_health["status"] != "ok" or not data_readiness["ready"]):
                        self.record_trade_event({
                            "kind": "order_blocked",
                            "source": "auto",
                            "action": sig.action,
                            "code": sig.code,
                            "name": sig.name,
                            "qty": sig.quantity,
                            "price": sig.price,
                            "chart": sig.chart,
                            "reason": f"데이터헬스 차단: {data_health['reason']}",
                            "status": "blocked",
                            "signal_ts": sig.timestamp,
                            "stop_loss": sig.stop_loss,
                            "take_profit": sig.take_profit,
                        })

                if WEB_ENABLED:
                    _update_web_state_v2(self, holdings, all_signals)

                elapsed = time.time() - cycle_start
                if self._cycle_count % 5 == 0:
                    log.info(
                        f"─── Cycle #{self._cycle_count} ({elapsed:.1f}s) ───\n"
                        f"  Regime: {regime.value} | Beta: {beta:.2f}\n"
                        f"  WTI: ${self.ext.latest_wti:.1f} ({self.ext.wti_change_pct*100:+.1f}%)\n"
                        f"  환율: {self.ext.usdkrw:.0f}원\n"
                        f"  뉴스: {self.ext.news_sentiment}\n"
                        f"  전쟁: D+{self.chart1.war_day_count}\n"
                        f"  시그널: {len(all_signals)}건\n"
                        f"  종목가: {dict(list(self.rt.prices.items())[:5])}\n"
                        f"  {self.whipsaw.status_report()}"
                    )

                sleep_time = max(0, self.CYCLE_INTERVAL - elapsed)
                time.sleep(sleep_time)

            except KeyboardInterrupt:
                log.info("⚠️ 사용자 중단")
                break
            except Exception as e:
                log.error(f"메인루프 오류: {e}", exc_info=True)
                time.sleep(5)

        self.shutdown()

    def _parse_minute_candles(self, raw: list) -> pd.DataFrame:
        rows = []
        for r in raw:
            rows.append({
                'time': pd.to_datetime(str(r.get('체결시간', '')), format='%Y%m%d%H%M%S', errors='coerce'),
                'open': abs(_parse_int(r.get('시가', 0), 0)),
                'high': abs(_parse_int(r.get('고가', 0), 0)),
                'low': abs(_parse_int(r.get('저가', 0), 0)),
                'close': abs(_parse_int(r.get('현재가', 0), 0)),
                'volume': abs(_parse_int(r.get('거래량', 0), 0)),
            })
        df = pd.DataFrame(rows)
        if not df.empty:
            df = df.sort_values('time').reset_index(drop=True)
        return df

    def shutdown(self):
        log.info("🛑 엔진 종료 시작...")
        self._running = False
        self.api.unsubscribe_realtime()
        self.rt.stop()
        log.info("🛑 엔진 종료 완료")


# ═══════════════════════════════════════════════════════════════
# WEB SERVER HELPERS
# ═══════════════════════════════════════════════════════════════

def _start_web_server():
    """별도 daemon 스레드에서 FastAPI/uvicorn 실행"""
    uvicorn.run(_web_app, host="0.0.0.0", port=5000, log_level="warning")


def _update_web_state(engine: 'WarAdaptiveEngine', holdings: list, all_signals: list):
    """매 루프 사이클마다 web engine_state 갱신 — 엔진과 화면 동기화"""
    rt_prices = engine.rt.prices
    deposit = engine.api.get_deposit()
    orderable_cash_raw = deposit.get('주문가능금액', '0') if isinstance(deposit, dict) else '0'
    try:
        orderable_cash = int(str(orderable_cash_raw).replace(',', '').strip() or '0')
    except Exception:
        orderable_cash = 0

    # 보유종목: 한국어 키 → 웹 친화적 dict + pnl 계산
    holdings_web = []
    for h in holdings:
        code = h.get('종목코드', '').strip()
        qty = _parse_int(h.get('보유수량', '0'), 0)
        avg = _parse_int(h.get('매입단가', '0'), 0)
        balance_cur = _parse_int(h.get('현재가', 0), 0)
        cur = balance_cur or rt_prices.get(code, avg)
        pnl = (cur - avg) * qty
        pnl_pct = round((cur / avg - 1) * 100, 2) if avg > 0 else 0
        name = TARGETS[code].name if code in TARGETS else code
        holdings_web.append({
            "code": code, "name": name, "qty": qty,
            "avg_price": avg, "current": cur,
            "pnl": pnl, "pnl_pct": pnl_pct,
        })

    # Signal dataclass → dict (최근 200건)
    signals_web = [
        {"code": s.code, "name": s.name, "action": s.action,
         "price": s.price, "qty": s.quantity, "confidence": s.confidence,
         "chart": s.chart, "reason": s.reason, "ts": s.timestamp,
         "stop_loss": s.stop_loss, "take_profit": s.take_profit,
         "marker_time": _bar_time_from_timestamp(s.timestamp)}
        for s in all_signals[-200:]
    ]
    manual_signals = engine_state.get("manual_signals", [])
    merged_signals = (manual_signals + signals_web)[:200]

    # 요동장 상태
    ws_status = {}
    for code, t in engine.whipsaw.trackers.items():
        ws_status[code] = {
            "name": t.name,
            "flag": ("emergency" if t.sell_triggered else
                     "crash" if t.crash_from_high else
                     "near_limit" if t.hit_near_limit_up else "normal"),
            "session_high": t.session_high,
            "current": t.current_price,
            "drawdown_pct": round(t.drawdown_from_high_pct * 100, 1),
            "locked_until": (t.buy_locked_until.strftime("%H:%M")
                             if t.buy_locked_until else None),
        }

    # 1분봉 축적 — 실시간 틱 → candle_history (프론트엔드 차트 시드용)
    now_ts = int(time.time())
    bar_time = now_ts - (now_ts % 60)
    candle_hist = engine_state.get("candle_history", {})

    all_codes = list(rt_prices.keys())  # KOSPI 포함
    for code in all_codes:
        price = rt_prices.get(code, 0)
        if price <= 0:
            continue
        if code not in candle_hist:
            candle_hist[code] = []
        bars = candle_hist[code]
        if bars and bars[-1]["time"] == bar_time:
            b = bars[-1]
            b["high"] = max(b["high"], price)
            b["low"] = min(b["low"], price)
            b["close"] = price
            b["volume"] = b["volume"] + 1
        else:
            bars.append({"time": bar_time, "open": price, "high": price,
                         "low": price, "close": price, "volume": 1})
            if len(bars) > 600:
                candle_hist[code] = bars[-600:]

    engine_state["candle_history"] = candle_hist
    position_overlays = engine.build_position_overlays(holdings)
    buy_levels = engine.build_buy_levels_map()
    prev_closes = engine.build_prev_close_map()
    data_health = engine.assess_data_health()
    hoga_analysis = {code: overlay.get("hoga", {}) for code, overlay in position_overlays.items()}

    engine_state.update({
        "regime": engine.chart1.regime.value,
        "beta": engine.chart1.beta,
        "war_day": engine.chart1.war_day_count,
        "wti": engine.ext.latest_wti,
        "usdkrw": engine.ext.usdkrw,
        "news_sentiment": engine.ext.news_sentiment,
        "prices": dict(rt_prices),
        "kospi": rt_prices.get('KOSPI', 0),
        "holdings": holdings_web,
        "signals": merged_signals,
        "whipsaw_status": ws_status,
        "daily_pnl": sum(h["pnl"] for h in holdings_web),
        "phase": engine.whipsaw.get_phase(datetime.now()).value,
        "auto_trading": engine.auto_trading_enabled,
        "data_health": data_health,
        "account_no": engine.api.account_no or "",
        "orderable_cash": orderable_cash,
        "buy_levels": buy_levels,
        "prev_closes": prev_closes,
        "position_overlays": position_overlays,
        "hoga_analysis": hoga_analysis,
    })
    if WEB_ENABLED:
        mark_engine_dirty("web_state_v2")


def _update_web_state_v2(engine: 'WarAdaptiveEngine', holdings: list, all_signals: list):
    """Preserve realtime-built candle_history and refresh dashboard state."""
    rt_prices = engine.rt.prices
    deposit = engine.api.get_deposit()
    orderable_cash_raw = deposit.get('주문가능금액', '0') if isinstance(deposit, dict) else '0'
    try:
        orderable_cash = int(str(orderable_cash_raw).replace(',', '').strip() or '0')
    except Exception:
        orderable_cash = 0

    holdings_web = []
    for h in holdings:
        code = h.get('종목코드', '').strip()
        qty = _parse_int(h.get('보유수량', '0'), 0)
        avg = _parse_int(h.get('매입단가', '0'), 0)
        balance_cur = _parse_int(h.get('현재가', 0), 0)
        cur = balance_cur or rt_prices.get(code, avg)
        pnl = (cur - avg) * qty
        pnl_pct = round((cur / avg - 1) * 100, 2) if avg > 0 else 0
        name = TARGETS[code].name if code in TARGETS else code
        holdings_web.append({
            "code": code,
            "name": name,
            "qty": qty,
            "avg_price": avg,
            "current": cur,
            "pnl": pnl,
            "pnl_pct": pnl_pct,
        })

    signals_web = [
        {
            "code": s.code,
            "name": s.name,
            "action": s.action,
            "price": s.price,
            "qty": s.quantity,
            "confidence": s.confidence,
            "chart": s.chart,
            "reason": s.reason,
            "ts": s.timestamp,
            "stop_loss": s.stop_loss,
            "take_profit": s.take_profit,
            "marker_time": _bar_time_from_timestamp(s.timestamp),
        }
        for s in all_signals[-200:]
    ]
    manual_signals = engine_state.get("manual_signals", [])
    merged_signals = (manual_signals + signals_web)[:200]

    ws_status = {}
    for code, t in engine.whipsaw.trackers.items():
        ws_status[code] = {
            "name": t.name,
            "flag": (
                "emergency" if t.sell_triggered else
                "crash" if t.crash_from_high else
                "near_limit" if t.hit_near_limit_up else "normal"
            ),
            "session_high": t.session_high,
            "current": t.current_price,
            "drawdown_pct": round(t.drawdown_from_high_pct * 100, 1),
            "locked_until": t.buy_locked_until.strftime("%H:%M") if t.buy_locked_until else None,
        }

    position_overlays = engine.build_position_overlays(holdings)
    buy_levels = engine.build_buy_levels_map()
    prev_closes = engine.build_prev_close_map()
    data_health = engine.assess_data_health()
    data_readiness = engine.assess_data_readiness() if hasattr(engine, "assess_data_readiness") else {
        "ready": False,
        "status": "unknown",
        "reason": "준비상태 미확인",
    }
    hoga_analysis = {code: overlay.get("hoga", {}) for code, overlay in position_overlays.items()}

    engine_state.update({
        "regime": engine.chart1.regime.value,
        "beta": engine.chart1.beta,
        "war_day": engine.chart1.war_day_count,
        "wti": engine.ext.latest_wti,
        "usdkrw": engine.ext.usdkrw,
        "news_sentiment": engine.ext.news_sentiment,
        "prices": dict(rt_prices),
        "kospi": rt_prices.get('KOSPI', 0),
        "holdings": holdings_web,
        "signals": merged_signals,
        "whipsaw_status": ws_status,
        "daily_pnl": sum(h["pnl"] for h in holdings_web),
        "phase": engine.whipsaw.get_phase(datetime.now()).value,
        "auto_trading": engine.auto_trading_enabled,
        "data_health": data_health,
        "data_readiness": data_readiness,
        "account_no": engine.api.account_no or "",
        "orderable_cash": orderable_cash,
        "buy_levels": buy_levels,
        "prev_closes": prev_closes,
        "position_overlays": position_overlays,
        "hoga_analysis": hoga_analysis,
    })

# ENTRY POINT
# ═══════════════════════════════════════════════════════════════

if __name__ == '__main__':
    engine = WarAdaptiveEngine()
    if WEB_ENABLED:
        set_engine_ref(engine)
        web_thread = threading.Thread(target=_start_web_server, daemon=True)
        web_thread.start()
        log.info("🌐 웹 대시보드: http://localhost:5000")
    if engine.initialize():
        engine.run()
    else:
        log.error("초기화 실패 — 종료")
