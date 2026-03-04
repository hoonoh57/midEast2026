' ============================================================
' WarDashboard.vb — FastGrid 기반 실시간 대시보드
' server32 WS + Python 엔진 상태를 시각화
' 연동: ws://localhost:8082/ws/realtime + ws://localhost:8082/ws/execution
' ============================================================

Imports System.Net.WebSockets
Imports System.Text
Imports System.Threading
Imports System.Threading.Tasks
Imports Newtonsoft.Json.Linq
Imports System.Drawing
Imports System.Windows.Forms

Public Class WarDashboard
    Inherits Form

    ' ── UI 컨트롤 ──
    Private WithEvents gridPositions As FastGrid   ' 보유종목
    Private WithEvents gridSignals As FastGrid     ' 시그널 로그
    Private WithEvents gridMarket As FastGrid      ' 시장현황
    Private lblRegime As Label
    Private lblBeta As Label
    Private lblWarDay As Label
    Private lblWti As Label
    Private lblUsdKrw As Label
    Private lblNews As Label
    Private lblPnl As Label
    Private panelTop As Panel
    Private panelMain As TableLayoutPanel
    Private tmrRefresh As System.Windows.Forms.Timer

    ' ── WebSocket ──
    Private _wsRealtime As ClientWebSocket
    Private _wsExecution As ClientWebSocket
    Private _ctsRealtime As New CancellationTokenSource()
    Private _ctsExecution As New CancellationTokenSource()

    ' ── 데이터 ──
    Private _prices As New Dictionary(Of String, Integer)
    Private _prevPrices As New Dictionary(Of String, Integer)
    Private _regime As String = "CRISIS"
    Private _beta As Double = 0.5
    Private _warDay As Integer = 4
    Private _signals As New List(Of String())          ' [시간, 종목, 액션, 가격, 차트, 이유]
    Private _holdings As New List(Of Dictionary(Of String, String))

    ' ── 대상 종목 ──
    Private ReadOnly _targets As New Dictionary(Of String, String) From {
        {"012450", "한화에어로"}, {"079550", "LIG넥스원"},
        {"272210", "한화시스템"}, {"064350", "현대로템"},
        {"010950", "에쓰오일"}, {"096770", "SK이노베이션"},
        {"011200", "HMM"}, {"028670", "팬오션"},
        {"005930", "삼성전자"}, {"000660", "SK하이닉스"}
    }

    Private ReadOnly _prevClose As New Dictionary(Of String, Integer) From {
        {"012450", 1432000}, {"079550", 661000},
        {"272210", 146700}, {"064350", 249000},
        {"010950", 141300}, {"096770", 130000},
        {"011200", 25750}, {"028670", 4800},
        {"005930", 195100}, {"000660", 939000}
    }

    ' ── 시장 데이터 ──
    Private _wti As Double = 80.0
    Private _usdkrw As Double = 1466.0
    Private _newsSentiment As String = "NEUTRAL"

    ' ── 시그널 그리드 데이터 (virtual mode) ──
    Private _signalRows As New List(Of String())

    ' ── 보유종목 그리드 데이터 (virtual mode) ──
    Private _holdingRows As New List(Of Dictionary(Of String, String))

    ' ── 시장현황 그리드 데이터 (virtual mode) ──
    Private _marketRows As New List(Of String())

#Region "초기화"

    Public Sub New()
        InitializeComponent()
        InitializeGrids()
        InitializeMarketRows()
    End Sub

    Private Sub InitializeComponent()
        Me.Text = "WAR-ADAPTIVE DASHBOARD v1.0  |  이란 공습 대응 시스템  |  2026-03-04"
        Me.Size = New Size(1600, 900)
        Me.BackColor = Color.Black
        Me.ForeColor = Color.White
        Me.Font = New Font("Consolas", 9)

        ' ── 상단 매크로 패널 ──
        panelTop = New Panel With {
            .Dock = DockStyle.Top,
            .Height = 60,
            .BackColor = Color.FromArgb(15, 15, 30)
        }

        lblRegime = MakeLabel("REGIME: CRISIS", 10, 10, Color.OrangeRed, 14, bold:=True)
        lblBeta = MakeLabel("BETA: 0.50", 230, 10, Color.Yellow, 13)
        lblWarDay = MakeLabel("D+4", 380, 10, Color.Orange, 13)
        lblWti = MakeLabel("WTI: $80.0", 480, 10, Color.LightSkyBlue, 13)
        lblUsdKrw = MakeLabel("USD/KRW: 1,466", 650, 10, Color.LightSkyBlue, 13)
        lblNews = MakeLabel("뉴스: NEUTRAL", 850, 10, Color.LightGreen, 13)
        lblPnl = MakeLabel("오늘 손익: ₩0", 1080, 10, Color.White, 13)

        panelTop.Controls.AddRange(New Control() {
            lblRegime, lblBeta, lblWarDay, lblWti, lblUsdKrw, lblNews, lblPnl
        })

        ' ── 그리드 레이아웃 ──
        panelMain = New TableLayoutPanel With {
            .Dock = DockStyle.Fill,
            .ColumnCount = 3,
            .RowCount = 2,
            .BackColor = Color.Black
        }
        panelMain.ColumnStyles.Add(New ColumnStyle(SizeType.Percent, 30))
        panelMain.ColumnStyles.Add(New ColumnStyle(SizeType.Percent, 35))
        panelMain.ColumnStyles.Add(New ColumnStyle(SizeType.Percent, 35))
        panelMain.RowStyles.Add(New RowStyle(SizeType.Absolute, 25))
        panelMain.RowStyles.Add(New RowStyle(SizeType.Percent, 100))

        ' 헤더 레이블
        panelMain.Controls.Add(MakeSectionLabel("■ 시장현황 (실시간)"), 0, 0)
        panelMain.Controls.Add(MakeSectionLabel("■ 보유종목 & 손익"), 1, 0)
        panelMain.Controls.Add(MakeSectionLabel("■ 시그널 로그"), 2, 0)

        gridMarket = New FastGrid()
        gridPositions = New FastGrid()
        gridSignals = New FastGrid()

        panelMain.Controls.Add(gridMarket, 0, 1)
        panelMain.Controls.Add(gridPositions, 1, 1)
        panelMain.Controls.Add(gridSignals, 2, 1)

        Me.Controls.Add(panelMain)
        Me.Controls.Add(panelTop)

        ' ── 타이머 ──
        tmrRefresh = New System.Windows.Forms.Timer With {.Interval = 1000}
        AddHandler tmrRefresh.Tick, AddressOf OnTimerTick
    End Sub

    Private Function MakeLabel(text As String, x As Integer, y As Integer,
                               color As Color, size As Single,
                               Optional bold As Boolean = False) As Label
        Return New Label With {
            .Text = text,
            .Location = New Point(x, y),
            .AutoSize = True,
            .ForeColor = color,
            .BackColor = Color.Transparent,
            .Font = New Font("Consolas", size, If(bold, FontStyle.Bold, FontStyle.Regular))
        }
    End Function

    Private Function MakeSectionLabel(text As String) As Label
        Return New Label With {
            .Text = text,
            .Dock = DockStyle.Fill,
            .ForeColor = Color.Silver,
            .BackColor = Color.FromArgb(20, 20, 40),
            .Font = New Font("Consolas", 9, FontStyle.Bold),
            .TextAlign = ContentAlignment.MiddleLeft,
            .Padding = New Padding(4, 0, 0, 0)
        }
    End Function

    Private Sub InitializeGrids()
        ' ── 시장현황 그리드 ──
        gridMarket.AddColumn("종목", "종목", 90)
        gridMarket.AddColumn("현재가", "현재가", 85)
        gridMarket.AddColumn("등락률", "등락률", 65)
        gridMarket.AddColumn("섹터", "섹터", 60)

        AddHandler gridMarket.CellValueNeeded, AddressOf GridMarket_CellValueNeeded

        ' ── 보유종목 그리드 ──
        gridPositions.AddColumn("종목명", "종목명", 80)
        gridPositions.AddColumn("보유수량", "수량", 55)
        gridPositions.AddColumn("평균단가", "평균가", 85)
        gridPositions.AddColumn("현재가", "현재가", 85)
        gridPositions.AddColumn("손익", "손익(원)", 90)
        gridPositions.AddColumn("손익률", "손익률", 65)

        AddHandler gridPositions.CellValueNeeded, AddressOf GridPositions_CellValueNeeded

        ' ── 시그널 그리드 ──
        gridSignals.AddColumn("시간", "시간", 75)
        gridSignals.AddColumn("종목", "종목", 75)
        gridSignals.AddColumn("액션", "액션", 45)
        gridSignals.AddColumn("가격", "가격", 85)
        gridSignals.AddColumn("차트", "차트", 55)
        gridSignals.AddColumn("이유", "이유", 160)

        AddHandler gridSignals.CellValueNeeded, AddressOf GridSignals_CellValueNeeded
    End Sub

    Private Sub InitializeMarketRows()
        For Each kv In _targets
            _marketRows.Add(kv.Key)   ' 종목코드만 저장, 값은 CellValueNeeded에서 동적 계산
        Next
        gridMarket.RowCount = _marketRows.Count
    End Sub

#End Region

#Region "그리드 CellValueNeeded 핸들러"

    Private Sub GridMarket_CellValueNeeded(sender As Object, e As CellValueNeededEventArgs)
        If e.RowIndex >= _marketRows.Count Then Return
        Dim code = _marketRows(e.RowIndex)
        Dim name = If(_targets.ContainsKey(code), _targets(code), code)
        Dim price = If(_prices.ContainsKey(code), _prices(code), _prevClose.GetValueOrDefault(code, 0))
        Dim prev = _prevClose.GetValueOrDefault(code, 0)
        Dim chgPct = If(prev > 0, (price - prev) / CDbl(prev) * 100, 0)

        Dim sector = "방산"
        If code = "010950" OrElse code = "096770" OrElse code = "011200" OrElse code = "028670" Then sector = "에너지"
        If code = "005930" OrElse code = "000660" Then sector = "반도체"

        Select Case e.ColumnIndex
            Case 0 : e.Value = name
            Case 1
                e.Value = If(price > 0, $"{price:#,##0}", "-")
                e.TextColor = PriceColor(chgPct)
            Case 2
                e.Value = If(prev > 0, $"{chgPct:+0.00;-0.00}%", "-")
                e.TextColor = PriceColor(chgPct)
            Case 3 : e.Value = sector
        End Select
    End Sub

    Private Sub GridPositions_CellValueNeeded(sender As Object, e As CellValueNeededEventArgs)
        If e.RowIndex >= _holdingRows.Count Then Return
        Dim row = _holdingRows(e.RowIndex)

        Dim code = row.GetValueOrDefault("종목코드", "").Trim()
        Dim name = row.GetValueOrDefault("종목명", code)
        Dim qty = CLng(row.GetValueOrDefault("보유수량", "0"))
        Dim avgPrice = CLng(row.GetValueOrDefault("매입단가", "0"))
        Dim curPrice = If(_prices.ContainsKey(code), _prices(code), avgPrice)
        Dim pnl = (curPrice - avgPrice) * qty
        Dim pnlPct = If(avgPrice > 0, (curPrice - avgPrice) / CDbl(avgPrice) * 100, 0)

        Select Case e.ColumnIndex
            Case 0 : e.Value = name
            Case 1 : e.Value = qty.ToString("#,##0")
            Case 2 : e.Value = avgPrice.ToString("#,##0")
            Case 3
                e.Value = curPrice.ToString("#,##0")
                e.TextColor = PriceColor(pnlPct)
            Case 4
                e.Value = pnl.ToString("+#,##0;-#,##0;0")
                e.TextColor = PriceColor(pnlPct)
            Case 5
                e.Value = $"{pnlPct:+0.00;-0.00}%"
                e.TextColor = PriceColor(pnlPct)
        End Select
    End Sub

    Private Sub GridSignals_CellValueNeeded(sender As Object, e As CellValueNeededEventArgs)
        If e.RowIndex >= _signalRows.Count Then Return
        Dim row = _signalRows(e.RowIndex)
        If e.ColumnIndex >= row.Length Then Return
        e.Value = row(e.ColumnIndex)

        ' 액션 컬러
        If e.ColumnIndex = 2 Then
            If row(2) = "BUY" Then
                e.TextColor = Color.Lime
            ElseIf row(2) = "SELL" Then
                e.TextColor = Color.Tomato
            End If
        End If
    End Sub

    Private Function PriceColor(chgPct As Double) As Color
        If chgPct > 0 Then Return Color.Crimson
        If chgPct < 0 Then Return Color.DodgerBlue
        Return Color.White
    End Function

#End Region

#Region "WebSocket 연결"

    Public Async Sub StartAsync()
        Await Task.WhenAll(
            ConnectRealtimeAsync(),
            ConnectExecutionAsync()
        )
    End Sub

    Private Async Function ConnectRealtimeAsync() As Task
        Try
            _wsRealtime = New ClientWebSocket()
            Await _wsRealtime.ConnectAsync(
                New Uri("ws://localhost:8082/ws/realtime"),
                _ctsRealtime.Token
            )
            log_msg("✅ 실시간 WS 연결")
            Await ReceiveLoopAsync(_wsRealtime, AddressOf OnRealtimeMessage, _ctsRealtime.Token)
        Catch ex As Exception
            log_msg($"실시간 WS 오류: {ex.Message}")
        End Try
    End Function

    Private Async Function ConnectExecutionAsync() As Task
        Try
            _wsExecution = New ClientWebSocket()
            Await _wsExecution.ConnectAsync(
                New Uri("ws://localhost:8082/ws/execution"),
                _ctsExecution.Token
            )
            log_msg("✅ 체결 WS 연결")
            Await ReceiveLoopAsync(_wsExecution, AddressOf OnExecutionMessage, _ctsExecution.Token)
        Catch ex As Exception
            log_msg($"체결 WS 오류: {ex.Message}")
        End Try
    End Function

    Private Async Function ReceiveLoopAsync(ws As ClientWebSocket,
                                            handler As Action(Of String),
                                            ct As CancellationToken) As Task
        Dim buf(65535) As Byte
        Do While ws.State = WebSocketState.Open AndAlso Not ct.IsCancellationRequested
            Try
                Dim seg = New ArraySegment(Of Byte)(buf)
                Dim result = Await ws.ReceiveAsync(seg, ct)
                If result.MessageType = WebSocketMessageType.Close Then Exit Do
                Dim msg = Encoding.UTF8.GetString(buf, 0, result.Count)
                handler(msg)
            Catch ex As Exception
                Exit Do
            End Try
        Loop
    End Function

    ' ── 실시간 tick 처리 ──
    Private Sub OnRealtimeMessage(msg As String)
        Try
            Dim j = JObject.Parse(msg)
            Dim msgType = j("type")?.ToString()
            Dim code = j("code")?.ToString()

            If msgType = "tick" AndAlso Not String.IsNullOrEmpty(code) Then
                Dim data = j("data")
                If data Is Nothing Then Return

                Dim priceStr = data("current_price")?.ToString()?.TrimStart("-"c, "+"c)
                Dim price As Integer
                If Integer.TryParse(priceStr, price) AndAlso price > 0 Then
                    If _prices.ContainsKey(code) Then
                        _prevPrices(code) = _prices(code)
                    End If
                    _prices(code) = price
                End If
            End If
        Catch
        End Try
    End Sub

    ' ── 체결/대시보드 처리 ──
    Private Sub OnExecutionMessage(msg As String)
        Try
            Dim j = JObject.Parse(msg)
            Dim msgType = j("type")?.ToString()

            If msgType = "dashboard" Then
                Dim data = j("data")
                If data Is Nothing Then Return

                ' 보유종목 업데이트
                Dim holdings = data("Holdings")
                If holdings IsNot Nothing Then
                    _holdingRows.Clear()
                    For Each item In holdings
                        Dim row As New Dictionary(Of String, String)
                        For Each prop In CType(item, JObject).Properties()
                            row(prop.Name) = prop.Value?.ToString()
                        Next
                        _holdingRows.Add(row)
                    Next
                    SafeInvoke(Sub()
                        gridPositions.RowCount = _holdingRows.Count
                        gridPositions.Invalidate()
                    End Sub)
                End If

            ElseIf msgType = "order" Then
                ' 시그널 로그에 체결 추가
                Dim data = j("data")
                If data IsNot Nothing Then
                    Dim code = data("종목코드")?.ToString()?.Trim()
                    Dim name = If(code IsNot Nothing AndAlso _targets.ContainsKey(code),
                                  _targets(code), code)
                    Dim qty = data("체결수량")?.ToString()
                    Dim price = data("체결가")?.ToString()
                    Dim row = New String() {
                        DateTime.Now.ToString("HH:mm:ss"),
                        name,
                        "EXEC",
                        If(price, ""),
                        "체결",
                        $"수량:{qty}"
                    }
                    SafeInvoke(Sub() AddSignalRow(row))
                End If
            End If
        Catch
        End Try
    End Sub

#End Region

#Region "시그널 추가 (Python 엔진 → 폴링)"

    Public Sub AddSignalRow(row As String())
        ' 최대 200건 유지
        _signalRows.Insert(0, row)
        If _signalRows.Count > 200 Then
            _signalRows.RemoveAt(_signalRows.Count - 1)
        End If
        gridSignals.RowCount = _signalRows.Count
        gridSignals.Invalidate()
    End Sub

    ''' <summary>Python 엔진 로그 파일에서 최신 시그널 폴링</summary>
    Public Sub PollEngineLog()
        Const LOG_FILE = "war_engine.log"
        Try
            If Not IO.File.Exists(LOG_FILE) Then Return
            Dim lines = IO.File.ReadAllLines(LOG_FILE, Encoding.UTF8)
            Dim recent = lines.Reverse().Take(50)

            For Each line In recent
                ' "🟢 매수실행:" 또는 "🔴 매도실행:" 파싱
                If line.Contains("매수실행:") OrElse line.Contains("매도실행:") Then
                    Dim isBuy = line.Contains("매수실행:")
                    Dim action = If(isBuy, "BUY", "SELL")
                    Dim timeStr = ""
                    If line.Length > 23 Then timeStr = line.Substring(11, 8)

                    ' 중복 방지: 이미 있는 항목은 스킵
                    If _signalRows.Any(Function(r) r.Length > 0 AndAlso r(0) = timeStr) Then Continue For

                    Dim row = New String() {timeStr, "", action, "", "", line.Trim()}
                    SafeInvoke(Sub() AddSignalRow(row))
                End If
            Next
        Catch
        End Try
    End Sub

#End Region

#Region "타이머 / UI 갱신"

    Private Sub OnTimerTick(sender As Object, e As EventArgs)
        ' 매크로 레이블 갱신 (현재는 정적, 실제로는 Python 엔진 폴링으로 교체)
        UpdateMacroLabels()

        ' 그리드 갱신
        gridMarket.Invalidate()
        gridPositions.Invalidate()
        gridSignals.Invalidate()

        ' 로그 폴링
        PollEngineLog()
    End Sub

    Private Sub UpdateMacroLabels()
        SafeInvoke(Sub()
            ' Regime 색상
            Dim regColor As Color = Color.OrangeRed
            Select Case _regime
                Case "EXTREME_CRISIS" : regColor = Color.Red
                Case "CRISIS"         : regColor = Color.OrangeRed
                Case "CAUTIOUS"       : regColor = Color.Orange
                Case "RECOVERY"       : regColor = Color.LightGreen
                Case "AGGRESSIVE"     : regColor = Color.Lime
            End Select
            lblRegime.Text = $"REGIME: {_regime}"
            lblRegime.ForeColor = regColor

            lblBeta.Text = $"BETA: {_beta:F2}"
            lblWarDay.Text = $"D+{_warDay}"

            lblWti.Text = $"WTI: ${_wti:F1}"
            lblWti.ForeColor = If(_wti > 85, Color.Tomato, Color.LightSkyBlue)

            lblUsdKrw.Text = $"USD/KRW: {_usdkrw:#,##0}"
            lblUsdKrw.ForeColor = If(_usdkrw > 1500, Color.Tomato, Color.LightSkyBlue)

            lblNews.Text = $"뉴스: {_newsSentiment}"
            Dim newsColor As Color = Color.LightGreen
            Select Case _newsSentiment
                Case "EXTREME_NEG" : newsColor = Color.Red
                Case "NEG"         : newsColor = Color.OrangeRed
                Case "POS"         : newsColor = Color.LimeGreen
                Case "EXTREME_POS" : newsColor = Color.Lime
            End Select
            lblNews.ForeColor = newsColor
        End Sub)
    End Sub

    Private Sub SafeInvoke(action As Action)
        If Me.InvokeRequired Then
            Me.BeginInvoke(action)
        Else
            action()
        End If
    End Sub

    Private Sub log_msg(msg As String)
        SafeInvoke(Sub()
            Dim row = New String() {DateTime.Now.ToString("HH:mm:ss"), "SYS", "INFO", "", "", msg}
            AddSignalRow(row)
        End Sub)
    End Sub

#End Region

#Region "Form 이벤트"

    Protected Overrides Sub OnLoad(e As EventArgs)
        MyBase.OnLoad(e)
        tmrRefresh.Start()
        Task.Run(Async Function() Await StartAsync())
    End Sub

    Protected Overrides Sub OnFormClosing(e As FormClosingEventArgs)
        tmrRefresh.Stop()
        _ctsRealtime.Cancel()
        _ctsExecution.Cancel()
        _wsRealtime?.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None)
        _wsExecution?.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None)
        MyBase.OnFormClosing(e)
    End Sub

    ' ── 외부에서 매크로 데이터 업데이트 (Python 엔진 연동) ──
    Public Sub UpdateMacro(regime As String, beta As Double, warDay As Integer,
                           wti As Double, usdkrw As Double, newsSentiment As String)
        _regime = regime
        _beta = beta
        _warDay = warDay
        _wti = wti
        _usdkrw = usdkrw
        _newsSentiment = newsSentiment
    End Sub

#End Region

End Class
