# taiwan-mahjong 開發指引

台灣 16 張麻將網頁遊戲，純娛樂、不需帳號。兩種模式：開房連線（分享網址加入）與單人對 AI。

- 規格書（唯一依據）：https://claude.ai/code/artifact/20a2cc0f-40bf-4925-b80e-580b7db46ca8
  - 主分頁「台灣麻將線上遊戲 系統規格書」、第二分頁「規則測試案例」
  - 規格有疑問先問使用者，不要自行發明規則；決定後同步更新規格書
- 使用者以台灣繁體中文溝通，程式註解、UI 文字、提交訊息也用繁體中文（避免簡體字與大陸用語）

## 架構（規格書第 5 節）

- 純靜態網頁，部署在 GitHub Pages；不架遊戲伺服器
- 開房時由**房主的瀏覽器**執行規則引擎與 AI，其他玩家用 WebRTC（PeerJS）連到房主
- 單人模式整局在瀏覽器內執行
- 房主只把各家自己的牌傳給各家（`viewFor`），絕不傳整個 `GameState`

## 目錄

| 路徑 | 內容 |
| --- | --- |
| `src/engine/tiles.ts` | 牌的編碼 0–41、文字寫法 `parseTiles("123m55pEE f1")` |
| `src/engine/hand.ts` | 胡牌拆解、嚦咕嚦咕、聽牌 |
| `src/engine/scoring.ts` | 台數計算 `scoreHand`、台數表 `DEFAULT_TAI` |
| `src/engine/settlement.ts` | 分數結算（底、每台、莊家連莊、豹子、花牌收分） |
| `src/engine/game.ts` | 對局狀態機（純資料、可 JSON 序列化） |
| `src/engine/wall.ts` | 骰子開門、牌牆位置（畫面用） |
| `src/engine/rng.ts` | 可重現亂數，種子決定洗牌與骰子 |
| `src/ai/` | 向聽數與 AI（簡單／普通／困難） |
| `src/game/controller.ts` | 牌桌控制器：AI 節奏、思考時間、逾時、斷線代打 |
| `src/net/` | 開房：訊息協定、房主 `HostRoom`、玩家 `ClientRoom`、PeerJS 連線、測試用記憶體連線 |
| `src/ui/` | 畫面（首頁、設定、牌桌、開房等待畫面） |
| `tests/fixtures/scoring-cases.json` | 規則測試案例（由 `tools/build_cases.py` 產生，勿手改） |
| `public/assets/` | 牌面、按鈕、骰子、牌桌 SVG；`tiles/manifest.json` 對照牌種編號 |
| `tools/gen_assets.py` | 美術素材產生器；`SKIN=yellow`／`black`／`chips` 產生其他風格到 `build/skins/`，再複製到 `public/assets/skins/` |
| `src/ui/tiles.ts` | 牌面圖檔路徑與風格切換（`setSkin`，每位玩家各自選、存在自己的瀏覽器） |

## 規則引擎慣例

- 牌種 0–8 萬、9–17 筒、18–26 條、27–33 東南西北中發白、34–41 春夏秋冬梅蘭竹菊
- 實體牌 0–143：`id = 牌種×4 + 第幾張`，花牌 136–143；`kindOf(id)` 轉牌種
- 座位 0 東 1 南 2 西 3 北；座位 0 是首局莊家，行牌順序 0→1→2→3
- 開門＝`(莊家 + 骰子合計 − 1) % 4`（`src/engine/wall.ts`）；門風＝`(座位 − 開門 + 4) % 4`，開門那家為東、1 花
- `wall` 陣列即抓牌順序；配牌每人每次 4 張輪 4 次、莊家再跳 1 張；補花補槓從陣列尾端拿
- `scoreHand` 的台數不含莊家與連莊，這兩項依付款人在 `settleWin` 計算
- 計時、AI、網路都不放在 `game.ts`；逾時由外部送出動作（出牌逾時打剛摸的牌、宣告逾時送 `pass`）
- 狀態機 `apply(state, action)` 直接修改 state；非法動作丟 `IllegalAction`

## 指令

```bash
npm install
npm test          # vitest，包含 71 個規則測試案例與隨機對局模擬
npm run typecheck
npm run dev       # 本機開發（M2 起）
python3 tools/build_cases.py   # 修改測試案例後重新產生 fixtures
```

提交前 `npm test` 與 `npm run typecheck` 都必須通過。

## 里程碑（規格書 9.2）

- [x] M1 規則引擎：台數、結算、狀態機、測試
- [x] M2 單人模式：牌桌畫面 + AI，上線 GitHub Pages（https://taiwan-mahjong-no-1.github.io/taiwan-mahjong/）
- [x] M3 開房模式：房主模組、PeerJS 連線、房間網址、重連（`src/net/`；本機測試：`?peer=127.0.0.1:9000` 搭配自架 PeerServer）
- [x] M4 離線功能：PWA（vite-plugin-pwa，離線可開啟）、全螢幕、同 Wi-Fi 互掃 QR code 開房（`src/net/offline.ts`：SDP 壓縮成約 106 字元）
- [ ] M5 試玩修正
