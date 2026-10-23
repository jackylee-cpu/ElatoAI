"""Build the native app shell interface document (xlsx) for the app colleague.

Usage: python3 docs/app-shell/build_xlsx.py "docs/原生App殼接口文檔_v0.2.xlsx"
Edit the content here and rebuild; bump VERSION and add a 變更記錄 row for each release.
"""
import sys
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.worksheet.datavalidation import DataValidation

OUT = sys.argv[1]
VERSION = "v0.2"
DATE = "2026-10-22"

FONT = "Microsoft JhengHei"
CODE = "Consolas"
HEAD_FILL = PatternFill("solid", fgColor="1F4E79")
SECTION_FILL = PatternFill("solid", fgColor="DDEBF7")
STATUS_FILL = {
    "可開工": PatternFill("solid", fgColor="E2EFDA"),
    "草案": PatternFill("solid", fgColor="FFF2CC"),
    "待定": PatternFill("solid", fgColor="FCE4D6"),
}
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(wrap_text=True, vertical="top")

wb = Workbook()


def sheet(title, headers, widths, rows, code_cols=(), status_col=None, first=False):
    ws = wb.active if first else wb.create_sheet()
    ws.title = title
    for i, (h, w) in enumerate(zip(headers, widths), start=1):
        c = ws.cell(row=1, column=i, value=h)
        c.font = Font(name=FONT, bold=True, color="FFFFFF", size=10.5)
        c.fill = HEAD_FILL
        c.alignment = Alignment(wrap_text=True, vertical="center")
        c.border = BORDER
        ws.column_dimensions[c.column_letter].width = w
    r = 2
    for row in rows:
        if isinstance(row, str):  # section divider
            ws.cell(row=r, column=1, value=row)
            for col in range(1, len(headers) + 1):
                cell = ws.cell(row=r, column=col)
                cell.fill = SECTION_FILL
                cell.font = Font(name=FONT, bold=True, size=10.5)
                cell.border = BORDER
            r += 1
            continue
        for i, v in enumerate(row, start=1):
            c = ws.cell(row=r, column=i, value=v)
            c.font = Font(name=CODE if i in code_cols else FONT, size=10 if i in code_cols else 10.5)
            c.alignment = WRAP
            c.border = BORDER
            if status_col == i and v in STATUS_FILL:
                c.fill = STATUS_FILL[v]
        r += 1
    ws.freeze_panes = "B2" if len(headers) > 2 else "A2"
    ws.auto_filter.ref = f"A1:{ws.cell(row=1, column=len(headers)).column_letter}{r - 1}"
    if status_col:
        dv = DataValidation(type="list", formula1='"可開工,草案,待定"', allow_blank=True)
        ws.add_data_validation(dv)
        col = ws.cell(row=1, column=status_col).column_letter
        dv.add(f"{col}2:{col}{r + 50}")
    return ws


# ---------------------------------------------------------------- 說明
ws = wb.active
ws.title = "說明"
ws.column_dimensions["A"].width = 22
ws.column_dimensions["B"].width = 100
intro = [
    ("title", f"AI Buddy 原生 App 殼接口文檔　{VERSION} · {DATE}"),
    ("對象", "負責 iOS／Android 原生殼的同事。照這份文件就可以開工，不用看網頁或韌體的程式碼。"),
    ("範圍", "只包括原生殼要做的事：① 網頁和原生之間的橋接接口 ② 藍牙配網（殼和設備之間）③ 殼本身的設定、權限、品牌 flavor 和上架要求。\n不包括：網頁介面、我們的伺服器 API、韌體。這些由我們負責。"),
    ("架構", "殼＝全屏 WebView，載入品牌的網址。畫面、帳號、資料、伺服器調用全部在網頁裡做；殼只提供網頁做不到的原生能力：藍牙、原生登入、推送、權限。\n殼不直接呼叫我們的伺服器，也不保存任何用戶資料。網頁改介面不用重新送審。"),
    ("三個品牌", "一個專案、三個 build flavor：A 馬會快活、B 政協青年聯會版、C AI Buddy（自有 IP）。1/15 只上架 A 和 B；C 延後，先不用出 C 的測試版，但專案結構要留位。每個品牌各自的名稱、圖示、bundle id、開發者帳號和網址，見「品牌設定」。接口三個品牌完全一樣。\n每個品牌有自己一套伺服器（帳號、資料互不相通），所以同一個人在兩個品牌各有一個帳號。"),
    ("先看", "「現在可以開工」分頁：按工作包列出現在可以做甚麼、做到哪裡、還在等甚麼。"),
    ("設備配網", "量產用戶的流程是：在 App 內用藍牙找到設備 → 選 Wi-Fi、填密碼 → 同時完成綁定；解綁也在 App 內做。\n設備上的熱點配網（AIBuddy-XXXX 熱點、192.168.4.1）只留給開發和運維，殼不需要支援。"),
    ("分頁", "現在可以開工：工作包清單和每項還在等甚麼\n調用約定：網頁和原生怎樣互相調用\n注入腳本：殼要注入頁面的 JS（可直接複製）\n橋接接口：網頁可以呼叫的每個原生方法\n事件：原生主動通知網頁的事件\n錯誤碼：所有方法共用的錯誤碼\n藍牙配網流程：一次配網從頭到尾誰做甚麼\n設備藍牙協定：殼和設備之間的藍牙協定（標準部分已定；自訂端點等韌體 R-21，10/30 前定稿）\n殼設定與權限：WebView 設定、系統權限、上架要求\n品牌設定：三個 flavor 各自的設定\n待定事項：還沒定、會影響殼的事\n變更記錄"),
    ("狀態", "可開工＝接口已定，可以照做\n草案＝方向已定，細節可能改，改了會在變更記錄寫明\n待定＝還沒決定，先不要做"),
    ("時間", "W3（10/26–10/30）殼的骨架、標準藍牙配網和原生登入可用，網頁開始對接；韌體的自訂藍牙端點定稿\nW6（11/16–11/20）A、B 兩個殼上 TestFlight 和 Google 內部測試：藍牙、登入、推送（玩具上線、低電）可用，連續用 30 分鐘不閃退\nW8（11/30–12/4）11/30 提交審核；12/11 前要通過"),
    ("聯絡", "接口有疑問或想改，直接找我們；改動記在「變更記錄」。"),
]
r = 1
for k, v in intro:
    if k == "title":
        c = ws.cell(row=r, column=1, value=v)
        c.font = Font(name=FONT, bold=True, size=16, color="1F4E79")
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=2)
        ws.row_dimensions[r].height = 28
        r += 2
        continue
    a = ws.cell(row=r, column=1, value=k)
    a.font = Font(name=FONT, bold=True, size=10.5)
    a.fill = SECTION_FILL
    a.alignment = WRAP
    a.border = BORDER
    b = ws.cell(row=r, column=2, value=v)
    b.font = Font(name=FONT, size=10.5)
    b.alignment = WRAP
    b.border = BORDER
    ws.row_dimensions[r].height = 15 * (v.count("\n") + 1 + len(v) // 70) + 6
    r += 1

# ---------------------------------------------------------------- 現在可以開工
# 狀態 here means: 可開工 = do it now; 草案 = start, details may still move; 待定 = wait.
sheet(
    "現在可以開工",
    ["#", "工作包", "包括（見各分頁）", "現在可以做到哪裡", "還在等甚麼", "等誰／何時", "需要日期", "狀態"],
    [5, 22, 36, 52, 44, 20, 14, 9],
    [
        "現在就做",
        (1, "殼專案骨架和品牌 flavor", "殼設定與權限（WebView 部分）、品牌設定",
         "一個專案、A／B 兩個 flavor（C 留位）：全屏 WebView、持久登入狀態、音訊自動播放、白名單導航、離線頁、啟動畫面、直向、Android 返回鍵、debug 版遠端除錯。\n品牌代號用 hkjc、genex；名稱、圖示、bundle id 先用臨時值，首頁網址先指向 https://elatoai.hkqft.com（現有測試網址），做成 flavor 設定，之後只改設定。",
         "正式 App 名稱、bundle id、網域、圖示", "我們和客戶（待定事項 #4）；圖示由設計負責人（待定）", "W3（10/30 前）", "可開工"),
        (2, "橋接層", "調用約定、注入腳本、錯誤碼",
         "注入 window.AIBuddyNative、iOS／Android 收發訊息、_resolve／_emit、來源檢查、超時、UNKNOWN_METHOD、User-Agent。\n不用等網頁：在 Safari Web Inspector／Chrome 遠端除錯的 console 直接呼叫 AIBuddyNative.call(\"app.getInfo\") 就能測。",
         "—", "—", "W3（10/30 前）", "可開工"),
        (3, "應用和權限", "橋接接口 A-01–A-05、P-01–P-02；事件 app.resume、app.pause；殼設定與權限（系統權限、麥克風 getUserMedia）",
         "全部照接口做。權限說明文字照「殼設定與權限」。", "—", "—", "W3（10/30 前）", "可開工"),
        (4, "藍牙：掃描、連接、Wi-Fi 清單", "B-01–B-05、B-07；事件 ble.*；設備藍牙協定",
         "協定已定：Espressif 標準配網（wifi_provisioning，BLE），Security 1。用官方 ESP Provisioning iOS／Android 庫，設備名前綴 AIBuddy-。\nPoP 先當作可選參數（ble.connect 的 pop，現在一律是 null）。\n我們提供一片燒了藍牙測試版韌體（spotpear-ai-toy-bleprobe）的板：可以掃描、連接、拿 Wi-Fi 清單、送 Wi-Fi 帳密。",
         "aibuddy-info 端點（測試版只有一個臨時端點 aibuddy，所以 ble.connect 讀設備資料那一步先用假資料）；PoP 最後給不給", "我們（韌體 R-21）", "W3（10/30 前）", "可開工"),
        (5, "原生登入", "L-01、L-02；品牌設定（Google client ID、Sign in with Apple）",
         "照接口做到拿回 idToken。開發期間先在你或我們的開發者帳號下建測試用的 client ID 和 App ID；網頁端的 signInWithIdToken 還在做，所以端到端登入要等網頁。",
         "各品牌開發者帳號下的正式 client ID、App ID；網頁端對接", "客戶開帳號（R-32）；網頁由我們做", "W3（10/30 前）", "可開工"),
        "可以先做，細節可能改",
        (6, "藍牙：送 Wi-Fi 和綁定票", "B-06；事件 ble.provisionProgress；設備藍牙協定的 aibuddy-bind、aibuddy-status",
         "標準的送 Wi-Fi 帳密、等連上可以先做（測試版韌體支援）。綁定票的格式和伺服器 API 已定（見「藍牙配網流程」第 6 步），殼只要原樣轉交。",
         "aibuddy-bind、aibuddy-status 兩個自訂端點的韌體實作", "我們（韌體 R-21）", "W3（10/30 前）", "草案"),
        (7, "推送", "N-01、N-02；事件 push.*；品牌設定（推送）",
         "接 Firebase Messaging，拿到 token 經 push.register 回給網頁；處理冷啟動和前台通知。每個品牌一個 Firebase 專案（見「品牌設定」）。",
         "iOS 經 FCM 還是 APNs（建議 FCM）；推送內容", "你和我們（待定事項 #6、#7）", "W6（11/20 前）", "草案"),
        (8, "上架準備", "殼設定與權限（上架）",
         "權限文案、最低系統版本、審核說明的原生功能描述可以先寫。內部測試版可以先用我們的帳號和臨時 bundle id 上 TestFlight／Google 內部測試。",
         "馬會、政協青年聯會的機構開發者帳號（要 D-U-N-S，需時 1–3 週）", "客戶（R-32），最遲 11/13", "W6（11/20 前）", "草案"),
        "先不要做",
        (9, "深層連結", "殼設定與權限（深層連結）",
         "—", "正式網域；我們要在網域上放 apple-app-site-association 和 assetlinks.json", "我們（待定事項 #4）", "W6（11/20 前）", "待定"),
        (10, "快活會員登入", "待定事項 #5",
         "—", "馬會決定用我們的帳號還是馬會會員帳號（Q12）；如果接馬會帳號，會加一個新接口", "馬會", "W5（11/13 前）", "待定"),
    ],
    status_col=8,
)

# ---------------------------------------------------------------- 調用約定
SHIM = r"""(function () {
  if (window.AIBuddyNative) return;
  var pending = {}, listeners = {}, seq = 0;
  function send(msg) {
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.aibuddy) {
      window.webkit.messageHandlers.aibuddy.postMessage(msg);
    } else if (window.AIBuddyAndroid) {
      window.AIBuddyAndroid.postMessage(msg);
    }
  }
  window.AIBuddyNative = {
    bridgeVersion: 1,
    platform: "__PLATFORM__",
    brand: "__BRAND__",
    call: function (method, params) {
      var id = String(++seq);
      return new Promise(function (resolve, reject) {
        pending[id] = { resolve: resolve, reject: reject };
        send(JSON.stringify({ id: id, method: method, params: params || {} }));
      });
    },
    on: function (name, fn) {
      (listeners[name] = listeners[name] || []).push(fn);
      return function () {
        listeners[name] = listeners[name].filter(function (f) { return f !== fn; });
      };
    },
    _resolve: function (id, res) {
      var p = pending[id];
      if (!p) return;
      delete pending[id];
      if (res && res.ok) p.resolve(res.data); else p.reject((res && res.error) || { code: "UNKNOWN" });
    },
    _emit: function (name, payload) {
      (listeners[name] || []).forEach(function (fn) { try { fn(payload); } catch (e) {} });
    }
  };
})();"""

sheet(
    "調用約定",
    ["項目", "約定", "例子"],
    [22, 70, 70],
    [
        ("注入物件", "殼在每個頁面載入前（document start、只限主框架）注入「注入腳本」分頁的整段腳本，把 __PLATFORM__ 換成 ios 或 android，__BRAND__ 換成品牌代號（見「品牌設定」）。網頁以 window.AIBuddyNative 是否存在判斷是不是在殼內。", "見「注入腳本」分頁（選取 A 欄全部程式碼複製即可）"),
        ("User-Agent", "在系統原有的 UA 後面加一段，網頁的伺服器端渲染也能判斷：AIBuddyShell/<殼版本> (brand=<品牌代號>; bridge=1; platform=ios|android)", "Mozilla/5.0 (iPhone; ...) Mobile/15E148 AIBuddyShell/1.0.0 (brand=hkjc; bridge=1; platform=ios)"),
        ("網頁 → 原生", "網頁送一個 JSON 字串（不是物件）：{id, method, params}。\niOS：window.webkit.messageHandlers.aibuddy.postMessage(字串)，handler 名稱 aibuddy。\nAndroid：window.AIBuddyAndroid.postMessage(字串)，用 addJavascriptInterface 注入，物件名稱 AIBuddyAndroid，方法加 @JavascriptInterface。", '{"id":"7","method":"ble.scanWifi","params":{"deviceId":"A1B2"}}'),
        ("原生 → 網頁：回覆", "每個請求剛好回覆一次，在主線程執行：\nwindow.AIBuddyNative._resolve(\"<id>\", <結果>)\n成功：{\"ok\":true,\"data\":{...}}；沒有資料時 data 為 {}。\n失敗：{\"ok\":false,\"error\":{\"code\":\"...\",\"message\":\"...\",\"reason\":\"...\"}}，code 見「錯誤碼」，message 給開發看，不顯示給用戶。", 'window.AIBuddyNative._resolve("7", {"ok":true,"data":{"networks":[{"ssid":"HomeWiFi","rssi":-52,"secure":true}]}})'),
        ("原生 → 網頁：事件", "原生主動通知網頁時，在主線程執行 window.AIBuddyNative._emit(\"<事件名>\", <payload>)。事件清單見「事件」。網頁未註冊的事件會被忽略，所以可以放心發。", 'window.AIBuddyNative._emit("ble.deviceFound", {"deviceId":"A1B2","name":"AIBuddy-6270","rssi":-61})'),
        ("字串轉義", "把 JSON 塞進 evaluateJavaScript 時，整段 JSON 本身就是合法的 JS 字面值，直接拼接即可；只有 id 要用 JSON 字串（帶引號）。不要自己手寫轉義。", ""),
        ("未知方法", "收到不認識的 method，回 UNKNOWN_METHOD。網頁會先用 app.getInfo 的 capabilities 判斷能力，所以舊版殼不用擔心新方法。", ""),
        ("來源檢查", "只處理來自本品牌白名單網域（見「品牌設定」）頁面的請求；其他來源一律回 FORBIDDEN_ORIGIN。iOS 用 WKScriptMessage.frameInfo.securityOrigin；Android 用 WebViewCompat.addWebMessageListener 的 allowedOriginRules，或在 postMessage 裡檢查 WebView 當前 URL。", ""),
        ("超時", "各方法的建議超時見「橋接接口」。超時由殼負責，到時回 TIMEOUT，並把設備或系統對話框收拾好（例如斷開藍牙）。", ""),
        ("敏感資料", "Wi-Fi 密碼、綁定票、登入 idToken 不能寫進日誌、崩潰報告或分析工具，用完即丟，不保存。", ""),
        ("版本", "bridgeVersion 是整數，目前為 1。新增方法或事件不升版；改了現有方法的參數或語義才升版，並在變更記錄寫明。", ""),
        ("用 Capacitor 的話", "可以，但仍要對網頁暴露同一個 window.AIBuddyNative 介面（方法名、參數、回傳、錯誤碼不變），例如用一個 Capacitor plugin 實作，再注入上面的腳本把 send() 改為呼叫 plugin。這樣網頁不用寫兩套。", ""),
    ],
    code_cols=(3,),
)

# ---------------------------------------------------------------- 注入腳本
ws = wb.create_sheet("注入腳本")
ws.column_dimensions["A"].width = 110
c = ws.cell(row=1, column=1, value="殼在每個頁面 document start 注入以下腳本（只限主框架）。把 __PLATFORM__ 換成 ios／android，__BRAND__ 換成品牌代號。選取 A3 起到最後一行複製即可。")
c.font = Font(name=FONT, bold=True, size=10.5)
c.alignment = WRAP
ws.row_dimensions[1].height = 32
for i, line in enumerate(SHIM.split("\n"), start=3):
    cell = ws.cell(row=i, column=1, value=line)
    cell.font = Font(name=CODE, size=10)
    cell.fill = PatternFill("solid", fgColor="F2F2F2")

# ---------------------------------------------------------------- 橋接接口
W3, W6 = "W3（10/30 前）", "W6（11/20 前）"
api_rows = [
    "應用（app）",
    ("A-01", "app.getInfo", "取得殼的資料和能力。網頁一開始會呼叫一次。", "{}",
     '{"platform":"ios","osVersion":"18.1","appVersion":"1.0.0","build":"12","bridgeVersion":1,"brand":"hkjc","capabilities":["ble","auth.apple","auth.google","push","mic"]}',
     "—", "capabilities 只列出這個平台和品牌真正支援的能力。例如 Android 不提供 Apple 登入，就不列 auth.apple。", "", "1 秒", W3, "可開工"),
    ("A-02", "app.openExternal", "用系統瀏覽器打開網址，例如私隱政策、客服頁。", '{"url":"https://example.com/privacy"}', "{}",
     "INVALID_PARAMS", "WebView 內點到非白名單網域的連結時，殼也要自動改用系統瀏覽器打開，不用等網頁呼叫。", "", "1 秒", W3, "可開工"),
    ("A-03", "app.openSettings", "打開本 App 的系統設定頁，讓用戶開回被拒的權限。", "{}", "{}",
     "—", "iOS：UIApplication.openSettingsURLString", "Android：Settings.ACTION_APPLICATION_DETAILS_SETTINGS", "1 秒", W3, "可開工"),
    ("A-04", "app.clearSession", "登出或刪除帳號後，清除 WebView 的 cookie、localStorage、快取，登出原生 Google，然後重新載入品牌首頁。", "{}", "{}",
     "—", "iOS：WKWebsiteDataStore.default().removeData(全部類型)；GIDSignIn.sharedInstance.signOut()", "Android：CookieManager.removeAllCookies、WebStorage.deleteAllData、clearCache(true)；CredentialManager.clearCredentialState", "5 秒", W3, "可開工"),
    ("A-05", "app.setKeepAwake", "配網期間保持螢幕不熄。", '{"on":true}', "{}",
     "—", "iOS：isIdleTimerDisabled", "Android：FLAG_KEEP_SCREEN_ON", "1 秒", W3, "可開工"),
    "權限（permission）",
    ("P-01", "permission.check", "查詢權限狀態，不彈系統對話框。", '{"type":"bluetooth"}  type：bluetooth | microphone | notifications',
     '{"status":"granted"}  status：granted | denied | undetermined | restricted',
     "INVALID_PARAMS", "bluetooth：CBManager.authorization", "bluetooth：API 31+ 查 BLUETOOTH_SCAN 和 BLUETOOTH_CONNECT；API 30 及以下查 ACCESS_FINE_LOCATION", "1 秒", W3, "可開工"),
    ("P-02", "permission.request", "請求權限；需要時彈系統對話框。用戶之前已永久拒絕的，直接回 denied，網頁會引導用戶去 app.openSettings。", '{"type":"microphone"}', '{"status":"granted"}',
     "INVALID_PARAMS", "bluetooth：建立 CBCentralManager 會觸發對話框\nmicrophone：AVAudioApplication.requestRecordPermission\nnotifications：UNUserNotificationCenter.requestAuthorization", "Android 13+ notifications 要 POST_NOTIFICATIONS；12 及以下直接回 granted", "等用戶回應，不設超時", W3, "可開工"),
    "藍牙配網（ble）：流程見「藍牙配網流程」，設備協定見「設備藍牙協定」",
    ("B-01", "ble.getState", "查詢手機藍牙狀態。", "{}", '{"state":"on"}  state：on | off | unauthorized | unsupported',
     "—", "CBCentralManager.state", "BluetoothAdapter.isEnabled", "2 秒", W3, "可開工"),
    ("B-02", "ble.startScan", "開始掃描附近的設備。每找到一台就發 ble.deviceFound；掃描結束發 ble.scanStopped。同一台設備只報一次，訊號變化不用再報。", '{"timeoutMs":15000}', "{}（立即回覆，結果經事件送出）",
     "PERMISSION_DENIED, BLE_OFF, BLE_UNSUPPORTED", "只報名稱以 AIBuddy- 開頭的設備。用 ESP Provisioning 庫：ESPProvisionManager.searchESPDevices(devicePrefix:\"AIBuddy-\", transport:.ble, security:.secure)", "ESPProvisionManager.searchBleEspDevices(\"AIBuddy-\")", "按 timeoutMs", W3, "可開工"),
    ("B-03", "ble.stopScan", "停止掃描。", "{}", "{}", "—", "", "", "1 秒", W3, "可開工"),
    ("B-04", "ble.connect", "連接一台設備，建立加密連線，再讀出設備資料（自訂端點 aibuddy-info）。如果設備的 brand 和本 App 的品牌不同，斷開並回 WRONG_BRAND。", '{"deviceId":"A1B2","pop":null}  deviceId 用 ble.deviceFound 給的值；pop 是 Security 1 的 proof of possession，null 或缺少＝不用 PoP（目前一律 null，見待定事項 #2）',
     '{"deviceId":"A1B2","name":"AIBuddy-6270","info":{"mac":"F8:5B:1B:53:62:70","brand":"hkjc","edition":"raceday","firmware":"1.0.1","wifiConfigured":false,"bound":false}}',
     "DEVICE_NOT_FOUND, CONNECT_FAILED, SECURITY_FAILED, WRONG_BRAND, TIMEOUT", "ESPDevice.connect(...)，security .secure（Security 1）；pop 原樣交給庫的 ESPDeviceConnectionDelegate", "ESPDevice.connectBLEDevice(...)，ESPConstants.SecurityType.SECURITY_1；pop 用 setProofOfPossession", "20 秒", W3, "可開工"),
    ("B-05", "ble.scanWifi", "請設備掃描附近的 Wi-Fi，回傳清單。設備只支援 2.4GHz，所以清單只會有 2.4GHz 網絡。", '{"deviceId":"A1B2"}',
     '{"networks":[{"ssid":"HomeWiFi","rssi":-52,"secure":true}]}  按 rssi 由強到弱排序，同名只留最強一個，去掉空 SSID',
     "DEVICE_DISCONNECTED, TIMEOUT", "ESPDevice.scanWifiList", "ESPDevice.scanNetworks", "15 秒", W3, "可開工"),
    ("B-06", "ble.provision", "把 Wi-Fi 和綁定票交給設備，等它連上 Wi-Fi 並完成綁定。過程中發 ble.provisionProgress。\n步驟：① 寫 aibuddy-bind（有 bindTicket 時）② 送 Wi-Fi 帳密並套用 ③ 等設備回報 Wi-Fi 已連上 ④ 每秒讀一次 aibuddy-status，直到 claimed 或失敗。\nbindTicket 為 null 時只改 Wi-Fi（已綁定的設備換路由器），第 ③ 步成功就回覆。",
     '{"deviceId":"A1B2","ssid":"HomeWiFi","password":"********","bindTicket":"q3Jx0bS2kV9mT1aZpL8wEg"}  bindTicket 是 22 個字元的 base64url 字串，網頁向伺服器取得（5 分鐘有效、只能用一次），殼原樣轉交、不用解讀',
     '{"result":"claimed"}；只改 Wi-Fi 時 {"result":"wifi_connected"}',
     "WIFI_AUTH_FAILED, WIFI_NOT_FOUND, WIFI_TIMEOUT, CLAIM_REJECTED（看 error.reason）, DEVICE_DISCONNECTED, TIMEOUT",
     "ESPDevice.sendData(path:\"aibuddy-bind\")；ESPDevice.provision(ssid:passPhrase:) 的狀態回調；再 sendData(path:\"aibuddy-status\")", "ESPDevice.sendDataToCustomEndPoint；ESPDevice.provision(ssid, password, ProvisionListener)", "90 秒", W3, "可開工"),
    ("B-07", "ble.disconnect", "斷開設備。配網完成或用戶離開配網頁時，網頁會呼叫。", '{"deviceId":"A1B2"}', "{}", "—", "", "", "2 秒", W3, "可開工"),
    "原生登入（auth）：拿到 idToken 後，由網頁交給 Supabase（signInWithIdToken）",
    ("L-01", "auth.signInWithApple", "原生 Sign in with Apple。網頁先產生隨機 rawNonce，把它的 SHA-256（小寫 hex）傳給殼；殼把它設為 request.nonce。網頁拿 idToken 和 rawNonce 去 Supabase 登入。", '{"nonce":"<SHA-256 hex>"}',
     '{"idToken":"eyJ...","authorizationCode":"c1a...","email":"a@b.com","fullName":"陳大文"}  email、fullName 只有第一次登入才有，沒有就省略',
     "CANCELLED, AUTH_FAILED", "ASAuthorizationAppleIDProvider，requestedScopes = [.fullName, .email]", "不提供（capabilities 不列 auth.apple），網頁在 Android 隱藏 Apple 按鈕", "等用戶回應", W3, "可開工"),
    ("L-02", "auth.signInWithGoogle", "原生 Google 登入（WebView 內的 Google OAuth 會被 Google 擋）。nonce 處理和 Apple 一樣。", '{"nonce":"<SHA-256 hex>"}', '{"idToken":"eyJ..."}',
     "CANCELLED, AUTH_FAILED", "GoogleSignIn SDK 7.1+：signIn(withPresenting:hint:additionalScopes:nonce:)，用該品牌的 iOS client ID", "Credential Manager：GetGoogleIdOption(serverClientId = 該品牌的 Web client ID, nonce)", "等用戶回應", W3, "可開工"),
    "推送（push）",
    ("N-01", "push.register", "請求通知權限並取得推送 token。網頁會把 token 交給我們的伺服器。token 之後變了，發 push.tokenChanged。", "{}", '{"token":"fcm-token...","platform":"ios","provider":"fcm"}',
     "PERMISSION_DENIED", "建議 iOS 也經 FCM（APNs key 交給 Firebase），兩個平台同一種 token", "FirebaseMessaging.getToken", "10 秒", W6, "草案"),
    ("N-02", "push.getLaunchNotification", "App 因用戶點通知而冷啟動時，網頁載入後取一次那個通知的資料；沒有就回 null。取過一次後清空。", "{}", '{"data":{"url":"/home/devices"}} 或 null',
     "—", "", "", "1 秒", W6, "草案"),
]
sheet(
    "橋接接口",
    ["編號", "方法", "用途", "參數 params", "成功回傳 data", "可能錯誤碼", "iOS 實作提示", "Android 實作提示", "建議超時", "需要日期", "狀態"],
    [7, 24, 44, 40, 48, 26, 40, 40, 12, 14, 9],
    api_rows,
    code_cols=(2, 4, 5),
    status_col=11,
)

# ---------------------------------------------------------------- 事件
sheet(
    "事件",
    ["事件", "甚麼時候發", "payload", "備註", "狀態"],
    [26, 44, 60, 44, 9],
    [
        ("ble.deviceFound", "掃描中找到一台新的 AIBuddy- 設備", '{"deviceId":"A1B2","name":"AIBuddy-6270","rssi":-61}', "deviceId 是殼自己的識別，網頁只用來傳回給 ble.connect；iOS 和 Android 可以不同。", "可開工"),
        ("ble.scanStopped", "掃描因超時、ble.stopScan 或錯誤而結束", '{"reason":"timeout"}  reason：timeout | stopped | error；error 時另加 "error":{"code":...}', "", "可開工"),
        ("ble.provisionProgress", "ble.provision 每進入一個新階段", '{"deviceId":"A1B2","stage":"wifi_connecting"}  stage：sending | wifi_connecting | wifi_connected | claiming | claimed | failed', "網頁用來顯示進度。最終結果以 ble.provision 的回覆為準。", "可開工"),
        ("ble.stateChanged", "手機藍牙開關或授權改變", '{"state":"off"}', "", "可開工"),
        ("ble.disconnected", "已連接的設備意外斷開（不是網頁呼叫 ble.disconnect）", '{"deviceId":"A1B2"}', "", "可開工"),
        ("app.resume", "App 回到前台", "{}", "網頁會刷新設備狀態。", "可開工"),
        ("app.pause", "App 進入背景", "{}", "", "可開工"),
        ("push.tokenChanged", "推送 token 改變", '{"token":"..."}', "", "草案"),
        ("push.received", "App 在前台時收到通知（殼不要自己彈系統通知）", '{"title":"...","body":"...","data":{"url":"/home"}}', "", "草案"),
        ("push.opened", "App 在背景或前台時，用戶點了通知", '{"data":{"url":"/home/devices"}}', "冷啟動的情況改用 push.getLaunchNotification。", "草案"),
    ],
    code_cols=(1, 3),
    status_col=5,
)

# ---------------------------------------------------------------- 錯誤碼
sheet(
    "錯誤碼",
    ["code", "意思", "網頁會怎樣處理"],
    [24, 56, 56],
    [
        "通用",
        ("INVALID_PARAMS", "參數缺少或格式不對", "當作程式錯誤，記錄下來"),
        ("UNKNOWN_METHOD", "殼不認識這個方法", "隱藏相關功能"),
        ("FORBIDDEN_ORIGIN", "請求來自非白名單網域", "不會發生在正常頁面"),
        ("PERMISSION_DENIED", "用戶拒絕了需要的權限", "提示並提供「去設定」按鈕（app.openSettings）"),
        ("CANCELLED", "用戶取消（例如關掉登入對話框）", "不提示，回到原畫面"),
        ("TIMEOUT", "超過建議超時", "提示重試"),
        ("UNKNOWN", "其他錯誤，message 寫明原因", "提示重試"),
        "藍牙",
        ("BLE_OFF", "手機藍牙關閉", "提示用戶打開藍牙"),
        ("BLE_UNSUPPORTED", "手機不支援 BLE", "提示換手機"),
        ("DEVICE_NOT_FOUND", "deviceId 已失效或設備不在範圍內", "回到掃描"),
        ("CONNECT_FAILED", "連接失敗", "提示靠近設備、重試"),
        ("SECURITY_FAILED", "加密連線建立失敗（PoP 不對等）", "提示重啟設備後重試"),
        ("WRONG_BRAND", "設備屬於另一個品牌", "提示「這台設備不能用這個 App 設定」"),
        ("DEVICE_DISCONNECTED", "過程中設備斷開", "提示重試"),
        ("WIFI_AUTH_FAILED", "Wi-Fi 密碼錯誤", "讓用戶重新輸入密碼"),
        ("WIFI_NOT_FOUND", "設備找不到這個 Wi-Fi", "提示 5GHz 不支援、靠近路由器"),
        ("WIFI_TIMEOUT", "設備連 Wi-Fi 超時（原因不明）", "提示重試"),
        ("CLAIM_REJECTED", "Wi-Fi 已連上，但綁定沒有成功。error.reason：\nalready_bound：設備已屬於另一個帳號（伺服器回 409 device_owned）\nticket_invalid：票過期、用過，或不是這個品牌的伺服器發的（伺服器回 403 bind_ticket_invalid，三種情況不分開）\ndevice_auth_failed：設備密鑰不對（伺服器回 401，正常不會出現，是出廠問題）\nserver_unreachable：設備連不上伺服器", "already_bound：提示請原主先解綁；ticket_invalid：自動取新票重試一次；其他：提示聯絡客服或重試"),
        "登入",
        ("AUTH_FAILED", "Apple／Google 回報失敗", "提示改用其他登入方式"),
    ],
    code_cols=(1,),
)

# ---------------------------------------------------------------- 藍牙配網流程
sheet(
    "藍牙配網流程",
    ["步驟", "誰", "做甚麼", "調用", "備註"],
    [7, 12, 56, 34, 50],
    [
        "新設備：配網並綁定",
        (1, "網頁", "用戶按「新增設備」。確認殼有 ble 能力，請求藍牙權限。", "app.getInfo → permission.request(bluetooth)", "沒有 ble 能力（例如在普通瀏覽器）就顯示「請用 App 新增設備」。"),
        (2, "網頁", "確認手機藍牙已開。", "ble.getState", ""),
        (3, "殼", "掃描並逐台回報設備；網頁列出設備名稱（AIBuddy-XXXX，XXXX 印在設備或包裝上）。", "ble.startScan → ble.deviceFound", "列表按訊號強弱排序。"),
        (4, "殼", "用戶選一台：連接、建立加密連線、讀設備資料，檢查品牌。", "ble.connect", "bound=true 時，網頁會向伺服器確認是不是自己的設備；不是的話提示「請原主先解綁」，不繼續。"),
        (5, "殼 → 設備", "設備掃描 Wi-Fi，網頁顯示清單；用戶選一個並填密碼。", "ble.scanWifi", "可以讓用戶手動輸入隱藏的 SSID。"),
        (6, "網頁", "向本品牌的伺服器取綁定票（一次性、5 分鐘有效、綁定這個帳號）。", "POST /api/device_bind_ticket（網頁自己做，不經殼）",
         "已完成，殼不用呼叫，列出來讓你知道票從哪來。\n回 200 {ticket, expires_at, expires_in: 300}；401 未登入；429 同一帳號一分鐘內超過 5 張（Retry-After: 60）。\n每個品牌一套伺服器，票只在發出它的那套有效，所以別的品牌的 App 綁不走這台設備。"),
        (7, "殼 → 設備", "把綁定票、Wi-Fi 帳密交給設備，逐步回報進度。", "ble.provision → ble.provisionProgress", ""),
        (8, "設備", "連上 Wi-Fi，用設備密鑰加綁定票向伺服器認領，結果寫入 aibuddy-status。", "（韌體做）", "伺服器端已完成（P0-11）。殼只負責讀 aibuddy-status。"),
        (9, "網頁", "收到 claimed，向伺服器確認綁定，斷開藍牙，跳到設備頁。", "ble.disconnect", ""),
        (10, "網頁", "失敗時按錯誤碼提示：密碼錯回到第 5 步，其他從第 7 步重試（重新取票）。", "", "綁定票只能用一次，重試必須取新票。"),
        "已綁定的設備換 Wi-Fi（例如換路由器）",
        (0, "網頁", "設備還在線時，換 Wi-Fi 在網頁的 Wi-Fi 管理頁做，經伺服器轉給設備，不經殼。下面的藍牙流程只用在設備連不上任何已存的 Wi-Fi 時。", "（不經殼）", ""),
        (1, "用戶", "長按設備 BOOT 鍵 5 秒，設備開始藍牙廣播。", "", "韌體 R-18。"),
        (2, "殼／網頁", "同上第 1–5 步。", "", ""),
        (3, "殼 → 設備", "只送 Wi-Fi，不送綁定票。", "ble.provision（bindTicket: null）", "回 wifi_connected 即完成，綁定不變。"),
        "解綁",
        (1, "網頁", "在設定頁按「解綁」，由伺服器處理。設備之後自動開始藍牙廣播，等下一次綁定。", "（不經殼）", "殼不用做任何事。"),
    ],
    code_cols=(4,),
)

# ---------------------------------------------------------------- 設備藍牙協定
sheet(
    "設備藍牙協定",
    ["項目", "內容", "例子", "狀態"],
    [22, 70, 56, 9],
    [
        ("協定", "已定：Espressif 的標準 Wi-Fi 配網協定（wifi_provisioning／protocomm，BLE 傳輸）。殼直接用 Espressif 官方庫：iOS esp-idf-provisioning-ios、Android esp-idf-provisioning-android，不用自己寫 GATT。藍牙測試版韌體（10/13）已用這套協定在 Spotpear 板上跑通。", "", "可開工"),
        ("廣播名稱", "已定：AIBuddy-XXXX，XXXX 是設備 Wi-Fi MAC 最後 4 位 hex（大寫）。和現在熱點的名稱一致，測試版韌體已是這個名稱。", "AIBuddy-6270", "可開工"),
        ("何時廣播", "未配網、存好的 Wi-Fi 連不上、未綁定（包括剛被解綁）、或用戶長按 BOOT 5 秒時。配網完成後停止廣播並釋放藍牙。", "", "草案"),
        ("加密", "已定：Security 1（X25519 金鑰交換 + AES-CTR）。iOS 庫用 security .secure，Android 庫用 SECURITY_1。", "", "可開工"),
        ("PoP", "還沒定給不給、怎樣給。測試版韌體不用 PoP。殼把 ble.connect 的 pop 參數原樣交給庫，null＝不用；這樣以後定了也不用改殼。", "", "待定"),
        ("韌體空間", "已解決：藍牙配網令韌體大約多 670KB，超出原來 2MB 的程式分區；量產板已改用每個 4MB 的程式分區（P2-12，11/13 凍結），放得下。藍牙配網要寫進 11/27 交 Spotpear 的出廠韌體，因為新設備第一次開機還沒有 Wi-Fi，不能經 OTA 補上。", "", "可開工"),
        ("標準端點", "prov-session、prov-scan、prov-config 由 Espressif 庫處理，殼不用直接碰。", "", "可開工"),
        ("測試版韌體", "spotpear-ai-toy-bleprobe：開機直接進藍牙配網，可以掃描、連接、拿 Wi-Fi 清單、送 Wi-Fi 帳密。它只有一個臨時自訂端點 aibuddy（寫入任何內容，回 {\"mac\":...,\"ticket_len\":...}），沒有下面三個正式端點，連上 Wi-Fi 後也不會認領。只用來開發殼，不是正式行為。", '回：{"mac":"F8:5B:1B:53:62:70","ticket_len":22}', "可開工"),
        ("自訂端點 aibuddy-info", "寫入 \"{}\"，回傳設備資料 JSON。", '回：{"mac":"F8:5B:1B:53:62:70","brand":"hkjc","edition":"raceday","firmware":"1.0.1","wifiConfigured":false,"bound":false}', "草案"),
        ("自訂端點 aibuddy-bind", "寫入綁定票，回傳是否收到。必須在送 Wi-Fi 帳密之前寫。", '寫：{"ticket":"bt_9f3c..."}\n回：{"ok":true}', "草案"),
        ("自訂端點 aibuddy-status", "寫入 \"{}\"，回傳目前進度。Wi-Fi 連上之後，殼每秒讀一次，直到 claimed 或 claim_failed。設備在這期間保持藍牙連線，最多 60 秒。", '回：{"stage":"claim_failed","reason":"already_bound"}\nstage：idle | wifi_connecting | wifi_failed | claiming | claimed | claim_failed\nreason 同錯誤碼 CLAIM_REJECTED', "草案"),
        ("資料大小", "每次自訂端點的 JSON 不超過 512 bytes，UTF-8。", "", "草案"),
        ("Wi-Fi", "只支援 2.4GHz；WPA2／WPA3-Personal 和開放網絡，不支援企業級（802.1X）。", "", "草案"),
        ("開發用熱點", "設備仍保留 AIBuddy-XXXX 熱點和 192.168.4.1 頁面，只給開發和運維用。殼不需要支援。", "", "可開工"),
    ],
    code_cols=(3,),
    status_col=4,
)

# ---------------------------------------------------------------- 殼設定與權限
sheet(
    "殼設定與權限",
    ["類別", "項目", "iOS", "Android", "原因"],
    [12, 24, 50, 50, 40],
    [
        "WebView",
        ("WebView", "載入網址", "啟動時載入該品牌的首頁（見「品牌設定」）", "同左", ""),
        ("WebView", "白名單導航", "只有品牌白名單網域在 WebView 內打開；其他網址交給系統瀏覽器（decidePolicyFor navigationAction）", "shouldOverrideUrlLoading 同樣處理", "防止頁面被帶到外部網站，也是來源檢查的基礎"),
        ("WebView", "注入橋接腳本", "WKUserScript，injectionTime = .atDocumentStart，forMainFrameOnly = true", "WebViewCompat.addDocumentStartJavaScript（androidx.webkit），allowedOriginRules = 白名單網域", "見「調用約定」"),
        ("WebView", "User-Agent", "customUserAgent／applicationNameForUserAgent 加上 AIBuddyShell 那段", "settings.userAgentString 後面加上同一段", "網頁判斷是否在殼內"),
        ("WebView", "登入狀態保存", "用 WKWebsiteDataStore.default()（持久化），不要用 nonPersistent", "domStorageEnabled = true；CookieManager 接受 cookie，onPause 時 flush()", "Supabase 登入狀態存在 localStorage，關 App 後要保留"),
        ("WebView", "音訊播放", "allowsInlineMediaPlayback = true；mediaTypesRequiringUserActionForPlayback = []", "mediaPlaybackRequiresUserGesture = false", "App 內和角色語音對話時要自動播放回覆"),
        ("WebView", "麥克風（getUserMedia）", "iOS 15+ 實作 WKUIDelegate requestMediaCapturePermissionFor：白名單來源而且系統麥克風權限已允許時回 .grant，避免每次再問", "WebChromeClient.onPermissionRequest：白名單來源而且 RECORD_AUDIO 已允許時 grant(RESOURCE_AUDIO_CAPTURE)", "網頁版語音對話用 getUserMedia"),
        ("WebView", "安全區域", "contentInsetAdjustmentBehavior = .never；網頁自己用 env(safe-area-inset-*) 處理", "不做 edge-to-edge，保留系統狀態列和導航列", ""),
        ("WebView", "縮放和下拉", "關閉雙指縮放；不要下拉刷新", "同左", "像原生 App 一樣"),
        ("WebView", "返回", "不用處理", "返回鍵：WebView.canGoBack() 就 goBack()，否則 moveTaskToBack(true)", ""),
        ("WebView", "載入失敗", "顯示原生的離線頁（品牌化）和「重試」按鈕", "同左", "沒網絡時不要顯示 WebView 的錯誤頁"),
        ("WebView", "啟動畫面", "原生啟動畫面一直顯示，到首頁第一次載入完成", "同左", ""),
        ("WebView", "遠端除錯", "debug build：isInspectable = true（iOS 16.4+）；release 關閉", "debug build：WebView.setWebContentsDebuggingEnabled(true)；release 關閉", "方便我們一起除錯"),
        ("WebView", "螢幕方向", "只限直向", "只限直向", ""),
        ("WebView", "深層連結", "Universal Links：品牌網域的連結直接在 App 內的 WebView 打開該網址", "App Links：同左", "apple-app-site-association 和 assetlinks.json 由我們放到網域上，需要你給 Team ID、bundle id、簽名 SHA-256"),
        "系統權限",
        ("權限", "藍牙", "Info.plist：NSBluetoothAlwaysUsageDescription＝「用藍牙尋找並設定你的設備」", "BLUETOOTH_SCAN（usesPermissionFlags=\"neverForLocation\"）、BLUETOOTH_CONNECT；API 30 及以下另加 BLUETOOTH、BLUETOOTH_ADMIN、ACCESS_FINE_LOCATION（maxSdkVersion=30）；uses-feature android.hardware.bluetooth_le required=false", "藍牙配網"),
        ("權限", "麥克風", "NSMicrophoneUsageDescription＝「在 App 內和角色對話時需要使用麥克風」", "RECORD_AUDIO、MODIFY_AUDIO_SETTINGS", "App 內語音對話"),
        ("權限", "通知", "Push Notifications capability", "POST_NOTIFICATIONS（Android 13+）", "推送"),
        ("權限", "網絡", "—", "INTERNET", ""),
        ("權限", "登入", "Sign in with Apple capability", "—", "Apple 審核 4.8"),
        ("權限", "深層連結", "Associated Domains：applinks:<品牌網域>", "intent-filter autoVerify=\"true\"", ""),
        "上架",
        ("上架", "最低功能（Apple 4.2）", "純網頁殼會被拒。我們的原生功能：藍牙配網、原生登入、推送", "—", "審核說明要寫清楚這三樣"),
        ("上架", "模板 App（Apple 4.2.6、4.3）", "三個品牌各自用自己的開發者帳號上架：A 馬會、B 政協青年聯會、C 我們", "Google Play 同樣分帳號", ""),
        ("上架", "登入（Apple 4.8）", "有 Google 登入就要有 Sign in with Apple", "—", ""),
        ("上架", "刪除帳號（Apple 5.1.1(v)）", "刪除帳號在網頁裡做；完成後網頁呼叫 app.clearSession", "同左", "殼不用另做頁面"),
        ("上架", "兒童分類", "不要放進 Kids 分類（App 是給家長和成人會員用的）", "目標年齡選成人", ""),
        ("上架", "審核資料", "審核用的測試帳號、設備示範影片、私隱標籤所需的資料清單由我們提供", "Data safety 表格同樣由我們提供資料", ""),
        ("上架", "最低系統版本", "建議 iOS 15", "建議 Android 8.0（API 26）", "待你確認，見「待定事項」"),
    ],
)

# ---------------------------------------------------------------- 品牌設定
sheet(
    "品牌設定",
    ["項目", "A 馬會快活", "B 政協青年聯會版", "C AI Buddy", "備註"],
    [22, 34, 34, 34, 40],
    [
        ("1/15 上架", "是", "是", "否，延後", "C 先不用出測試版，但專案結構要留位"),
        ("品牌代號（brand）", "hkjc", "genex", "aibuddy", "網頁的品牌設定已用這三個代號。注入腳本和 User-Agent 用；設備的 brand 也是這個值"),
        ("App 名稱", "待馬會確認", "待客戶確認", "AI Buddy", ""),
        ("Bundle ID／applicationId", "待定（馬會的帳號下）", "待定（政協青年聯會的帳號下）", "待定（我們的帳號下）", "開發期間用臨時 bundle id"),
        ("開發者帳號", "馬會的機構帳號（要 D-U-N-S）", "政協青年聯會的機構帳號（要 D-U-N-S）", "我們的帳號", "Apple 4.2.6／4.3；最遲 11/13 要開好"),
        ("首頁網址", "待定", "待定", "待定", "每個品牌一套伺服器和網頁，網頁的品牌由那套伺服器的設定決定，不看網址。開發期間先用 https://elatoai.hkqft.com"),
        ("白名單網域", "待定", "待定", "待定", "每個品牌一個子網域，正式網域待定。開發期間白名單放 elatoai.hkqft.com；做成 flavor 設定"),
        ("登入方式", "待定（可能接馬會會員帳號，見待定事項）", "Email 驗證碼、Google、Apple", "Email 驗證碼、Google、Apple", "Email 驗證碼在網頁做，殼不用管"),
        ("Google OAuth client ID", "iOS、Android 各一個，由該品牌帳號建立", "同左", "同左", "Web client ID 由我們提供；新建的 client ID 要告訴我們，我們在 Supabase 登記"),
        ("Sign in with Apple", "該品牌帳號的 App ID 開啟", "同左", "同左", ""),
        ("推送", "自己的 Firebase 專案", "同左", "同左", "建議每個品牌一個 Firebase 專案：每個品牌的伺服器只拿自己的推送密鑰，和資料分開的做法一致（v0.1 建議共用，已改）"),
        ("圖示、啟動畫面、主色", "由馬會提供", "由客戶提供", "我們提供", "離線頁也用這套"),
    ],
)

# ---------------------------------------------------------------- 待定事項
sheet(
    "待定事項",
    ["#", "事項", "影響殼的哪部分", "由誰決定", "需要日期", "狀態"],
    [5, 56, 36, 20, 16, 9],
    [
        (1, "殼用 Capacitor 還是純原生", "不影響接口（網頁只認 window.AIBuddyNative），不擋開工", "你", "盡快告訴我們", "待定"),
        (2, "藍牙配網的 PoP 給不給、怎樣給（Security 1 已定，v0.2）", "只影響 ble.connect 的 pop 參數的值；殼照「設備藍牙協定」原樣轉交，不擋開工", "我們（韌體 R-21）", "W3（10/30 前）", "待定"),
        (3, "設備藍牙協定的自訂端點 aibuddy-info／-bind／-status 細節", "ble.connect、ble.provision", "我們（韌體 R-21）", "W3（10/30 前）", "草案"),
        (4, "A、B 的網域、App 名稱、bundle id（品牌代號已定：hkjc、genex、aibuddy，v0.2）", "品牌設定、白名單、深層連結；開發期間用臨時值，不擋開工", "我們和客戶", "W2（10/23 前），已逾期", "待定"),
        (5, "快活的登入是用我們的帳號，還是接馬會的會員帳號（Q12）", "如果接馬會帳號，要加 auth.signInWithHkjc 之類的接口", "馬會", "W5（11/13 前）", "待定"),
        (6, "推送：iOS 經 FCM 還是直接用 APNs（建議 FCM）", "push.register 的 provider", "你和我們", "W5（11/13 前）", "草案"),
        (7, "推送要通知甚麼（至少：玩具第一次上線、低電）", "不影響接口，只影響推送內容", "我們", "W5（11/13 前）", "待定"),
        (8, "最低支援的 iOS／Android 版本", "殼設定", "你", "W2（10/23 前）", "草案"),
        (9, "Android 上要不要提供 Apple 登入（建議不提供）", "auth.signInWithApple", "我們", "W3（10/30 前）", "草案"),
        (10, "馬會、政協青年聯會的機構開發者帳號（R-32）", "正式 bundle id、Google client ID、Sign in with Apple、送審；內部測試版可先用我們的帳號", "客戶", "最遲 W5（11/13）", "待定"),
    ],
    status_col=6,
)

# ---------------------------------------------------------------- 變更記錄
sheet(
    "變更記錄",
    ["日期", "版本", "變更", "誰"],
    [14, 12, 80, 14],
    [
        ("2026-10-12", "v0.1", "初版：調用約定、注入腳本、橋接接口（app、permission、ble、auth、push）、事件、錯誤碼、藍牙配網流程、設備藍牙協定（草案）、殼設定與權限、品牌設定、待定事項。", ""),
        (DATE, "v0.2", "新增「現在可以開工」分頁。\n藍牙：協定（Espressif 標準配網＋官方庫）、廣播名稱、Security 1 改為已定；新增 PoP、韌體空間（4MB 程式分區）、測試版韌體三行；ble.connect 加可選參數 pop。\n綁定：綁定票格式（22 字元 base64url）和伺服器 API（POST /api/device_bind_ticket，已完成）寫進流程第 6 步；CLAIM_REJECTED 的 reason 改為和伺服器一致：already_bound、ticket_invalid、device_auth_failed、server_unreachable（v0.1 的 ticket_expired、ticket_used、wrong_brand 合併為 ticket_invalid）。\n換 Wi-Fi：設備在線時改在網頁做，不經殼。\n品牌：1/15 只上架 A、B；品牌代號定為 hkjc、genex、aibuddy；每個品牌一套伺服器，網頁不按網址判斷品牌；推送改建議每個品牌一個 Firebase 專案。\n待定事項：更新 #1、#2、#4、#7，新增 #10 開發者帳號。", ""),
    ],
)

for ws in wb.worksheets:
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.print_title_rows = "1:1" if ws.title != "說明" else None
    ws.page_margins.left = ws.page_margins.right = 0.4

wb.save(OUT)
print("saved", OUT)
