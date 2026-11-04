# 坦克大戰 — Battle City (HTML5)

純 JavaScript + Canvas 的坦克大戰重製版。**無框架、無建構步驟、無任何圖片或音訊檔案**：戰場地形由 `js/mapgen.js` 程序化產生（255 張，依地圖編號固定）、所有貼圖與音效都是開機時程序化產生的。

內含兩種玩法：**單人闖關**（關卡無限延伸，第 n 關用地圖編號 `(n-1) mod 255`），以及不用自己上手的 **A.I. 對戰觀戰模式**（兩隊 AI 各守自家老鷹互打）。觀戰模式的 AI 可以是手寫規則，也可以是**訓練出來的 NEAT 網路**——先用模仿學習讓網路學會規則 AI 的基本動作，再逐段演化（今天 100 場、明天接著跑），訓練成果與「每一局怎麼打」的過程數據都能在 `ai/monitor.html` 看到。

## 遊玩方式

直接用瀏覽器打開 `index.html` 即可（`file://` 就能跑，不需要伺服器，也不用安裝任何套件）。

```
開場：按 Enter 開始單人遊戲 ／ 按 T 進入 A.I. 對戰觀戰
```

## 操作

| 按鍵 | 功能 |
| --- | --- |
| `W` `A` `S` `D` 或方向鍵 | 移動 |
| `J` 或 `空白鍵` | 射擊 |
| `P` | 暫停／繼續 |
| `R` | 重開本關（觀戰模式中＝重打本輪） |
| `Enter` | 開始／回標題 |
| `T` | 在標題畫面進入 A.I. 對戰觀戰（兩隊都是規則 AI） |
| `Y` | 在標題畫面進入觀戰：藍隊＝訓練好的 NEAT 網路、紅隊＝規則 AI |
| `U` | 在標題畫面進入觀戰：兩隊都用同一份訓練基因組（自我對弈） |
| `M` | 靜音切換 |

## 單人模式

守住下方的老鷹，殲滅每關 20 台敵軍（場上同時最多 4 台）。老鷹被命中、或生命扣完即結束。

**地形**

| 地形 | 特性 |
| --- | --- |
| 磚牆 | 可破壞，以 8×8 的最小格逐塊削除 |
| 鋼牆 | 只有火力 L4 能打破 |
| 水面 | 擋坦克，子彈可穿越 |
| 樹叢 | 可通行，會蓋住坦克（畫在最上層） |
| 冰面 | 可通行但會打滑，放開按鍵仍繼續滑行 |

**敵軍種類**

| 類型 | 血量 | 速度 | 子彈 | 分數 |
| --- | --- | --- | --- | --- |
| 輕型 | 1 | 慢 | 一般 | 100 |
| 裝甲車 | 1 | 快 | 一般 | 200 |
| 速射 | 1 | 慢 | 快速 | 300 |
| 重型 | 4（變色：綠→黃→橘→白） | 很慢 | 一般 | 400 |

**火力等級**（吃星星升級，死亡後歸零）

- `L1` 基本 → `L2` 子彈加速 → `L3` 同屏兩發 → `L4` 可破鋼牆

**道具**（由「閃紅」的敵人被擊殺時掉落，或觀戰模式下定期出現）

| 道具 | 效果 |
| --- | --- |
| 星星 | 火力升一級 |
| 炸彈 | 全滅場上敵軍 |
| 時鐘 | 凍結敵軍 10 秒 |
| 鏟子 | 老鷹周圍磚環暫時變鋼牆（20 秒） |
| 護盾 | 無敵 10 秒 |
| 坦克 | 多一條命 |

**其他規則**：每 20,000 分獎勵一條命；每關第 4、11、18 台出場的敵人是閃紅（掉道具）；最高分存在瀏覽器 `localStorage`（key：`tankBattleHiScore`）。

## A.I. 對戰觀戰模式（按 `T`）

兩隊全程由 AI 操控，你只需要看。左右兩欄是三個獨立區塊（`js/hud.js`）：**① 訓練狀態**（場上這顆大腦是第幾代、訓練端有沒有在跑）、**② 紅藍隊伍＋倒數**（兩隊各自的出兵／擊殺／分數／老鷹與 30 秒計時）、**③ 用滑鼠操作**（暫停／重開／下一輪／速度／換圖／換模型，全部可點，不必碰鍵盤）。

規則層（`js/ai.js`，訓練端的老師也是它）：

- **戰場**：9:21 直立長場（18×42 cells、144×336 邏輯 px）。畫布位圖 288×672，頁面用 CSS 依視窗高度放大——**位圖不放大**，貼圖才不會糊。
- **地形每輪隨機、但可重現**：255 張由 `js/mapgen.js` 依地圖編號生成（`mapId → 固定種子 → 固定地形`），同一張編號在任何機器上都長得一樣。上下 180° 點對稱（tile 級鏡像），兩隊面對的幾何完全等價；開局前對每個出生 tile 跑一次 Dijkstra，走不到敵方要塞就沿最便宜的路徑挖開（老鷹與要塞牆禁挖）——每一台車都真的有路可走。
- **各守各家**：藍隊守下方老鷹、紅隊守上方老鷹（旋轉 180°）。每隊 20 台坦克池，場上同時最多 4 台；**開場即 4 對 4**（兩隊同幀站滿自家四個出生點，之後打完才補），第一台從自家老鷹旁的中央出生點對稱出車。
- **藍＝進攻、紅＝防守**：藍隊唯一的贏法是 **30 秒內打爆紅隊老鷹**；拖滿 30 秒或兩隊兵力池耗盡一律紅隊贏。紅隊另有「反守為攻」：打爆藍隊老鷹也算紅隊贏。
- **不準朝自己要塞開槍**：開火前先沿槍口走一遍彈道，第一個擋下來的是自家老鷹或要塞牆就收手。規則 AI（`js/ai.js`）與訓練網路（`ai/controller.js`）用同一套幾何判斷。
- **自己打爆自家老鷹要記帳**：該隊該局直接 0 分，對面也拿不到勝負分；結算畫面與 ② 欄會標「⚠ 自破」。
- **貼身就先解決對方坦克**：敵車中心距 <40px 時最高優先目標改成那台車，節奏同步加快（重新決策 8 幀、冷卻 8～15 幀）。
- **席位決定目標**：敵車壓到自家牆腳（56px）兩席都先回防；防守席守在自家門前防線、絕不追到對方門口；**進攻席的位移只認對方主堡**，「先打敵車」落在開火層——同軸前方有活敵車就打車，已貼到敵鷹門口才打堡，否則不開槍。
- **開火節拍跟著「家裡有沒有事」**：貼身 8～16 幀、敵車到屏蔽圈 10～20 幀、敵車在自家半場 16～30 幀、都沒事維持 25～75 幀；同軸擲骰 0.8、貼身 0.9、不同軸時近距離留少量壓制機率。**沒有改成必中**——準度要留訊號給訓練計分。
- **不會原地磨蹭**：所有 AI 的轉向必須伴隨位移、走得通不準原路退回、轉向後要連走 12 幀才準再轉。玩家坦克不受此限。
- **道具歸 AI 使用**：誰先撞到誰生效。
- **自動續戰**：結果畫面停 5 秒後自動開下一輪並隨機抽圖；右欄可「🔀 每輪隨機／📌 固定這張圖」切換、◀▶ 瀏覽地圖編號。

展示層（唯讀疊加，不改任何規則；訓練端不讀、計分不讀）：

- **① 系列賽計分板**：連續觀戰記 BO7，先拿 4 勝是系列冠軍；賽末點亮紅字、冠軍出爐有定格。只活在這一頁（重整＝新系列）。
- **② Kill feed＋結算卡**：擊殺當下畫布右上角播報（幀號＋該隊第幾台，8 秒淡出）；終局在畫布中央疊結算卡——用時／雙方擊殺／耗彈／每殺發數。
- **③ 張力可視化**：倒數最後 10 秒紅色脈動、左欄「藍隊破局進度」條（藍車離紅鷹的最近距離）與「包圍壓力」（紅鷹 56px 內的藍車數）。

## 會變聰明的 AI（NEAT 自進化）

觀戰模式裡的 AI 有兩種來源：**規則 AI**（`js/ai.js`，手寫的 if-else）與**訓練 AI**（用 NEAT 演化出來的類神經網路）。訓練分兩段：先用模仿學習把規則 AI 的行為複製進網路，得到一個「一開場就會開車」的種子，再讓 NEAT 從種子往上進化；過程是**逐段累積**的——今天跑幾百場、把族群落盤，明天從同一個檔案接續，網路一代比一代強。每一輪都能用 `ai/monitor.html` 看到它「怎麼打」而不只是「誰贏」。

### 第 0 步：先用規則 AI 的資料暖啟動（強烈建議）

從隨機權重開始演化，第一代就會「動」，但動的方向是亂猜的，最容易掉進「卡牆掃射」這種局部最優。所以管線的起點是**把規則 AI 的行為複製進網路**：

```bash
# 1) 收示範：規則 AI 打幾局，記錄每幀的（觀測 → 決定），依事件加權取樣
node ai/imitate.js --stages 0,1,2 --games 3 --out runs/seed.json
#    → runs/seed.json（模仿種子）＋ runs/seed.genome.json（給網頁/監測看的基因組）

# 2) NEAT 從這份種子往上進化（族群全部由它變異而來）
node ai/evolve.js --seed-from runs/seed.json --gens 80 --pop 24 --stages 0,1 --seeds 2 --out runs/warm.json
```

暖啟動買到的不是「更強的最終冠軍」，而是「合理的起點」：種子第一代就有水位、射擊精準度演化之後的網路都比不上；但「那條走廊要一路走完」的勝負本領要靠演化自己練出來（種子對規則 AI 常常破不了局——這是行為複製的天生上限）。演化夠不夠格，看 `test-train.js` 暖啟動那一節的門檻（5 代冠軍要打得過規則 AI），不靠降標。

⚠ **種子會過期，而且過期不會報錯**：`js/ai.js`（＝老師）一改，舊種子複製的就是上一代老師的行為，檔案裡的 `generatedAt` 是唯一線索。改完老師要重收：`node ai/imitate.js --role attack --out runs/seed-attack.json`／`--role defense`，並把新檔蓋進 `ai/seeds/`（CI 讀那份）。重收後第一代可能更低——那不是收壞了，是新老師更難模仿。

### 訓練（純 Node，不需要瀏覽器）

```bash
# 今天：跑 20 代（族群 24 × 3 張地圖 × 2 種子 × 雙座位 = 288 場/代）
node ai/evolve.js --gens 20 --pop 24 --stages 0,1,2 --seeds 2 --out runs/neat.json

# 明天：從上次落盤處接續，這次只跑 3000 場（能跑幾代算幾代）
node ai/evolve.js --resume runs/neat.json --episodes 3000

# 看成果：收斂曲線 + 對規則 AI 的實戰勝率（用沒參與評估的新種子）
node ai/evolve.js --report runs/neat.json

# 過程監測：逐幀數據 + 紅旗，並寫出 ai/monitor.html 要的資料
node ai/monitor.js --ckpt runs/warm.json --stage 0 --games 4

# 匯出冠軍給瀏覽器（雙模型要寫到「該角色」那一份，否則觀戰那隊讀不到）
node ai/evolve.js --resume runs/attack-v6.json --gens 20 --export-to ai/trained-attack.json
node ai/evolve.js --resume runs/defense-v6.json --gens 20 --export-to ai/trained-defense.json
```

`--gens` 與 `--episodes` 至少要給一個（都沒給會無限演化，CLI 直接拒絕啟動）；兩個都給時取較嚴的那個，場數不足一代時仍會把一代跑完。`--opponent rule|random|best` 換對手，`best` 等於跟目前的冠軍自我對弈。其他：`--pop`、`--stages 0,1,2`、`--seeds N`、`--save-every N`、`--seed N`、`--quiet`、`--max-frames`。續練時 `--stages` 是「明確換考題」（不給會沿用存檔設定）；換圖與換算分版本時舊冠軍會先在新尺上重評一次（校準局不計入訓練場數），履歷與看板都會標出這條接縫。

### 算分怎麼看

適應度由 `ai/fitness.js` 的 `TERMS` 決定（目前算分版本 v14：進攻 24 項／防守 23 項，外加過程懲罰與反刷分設計）。要逐項看權重與算式：`node ai/ledger.js --rubric`；要看某一局各項怎麼加總：`node ai/ledger.js --ckpt <存檔> --breakdown`。匯出檔與履歷都帶 `scoringVersion`，**換尺前後的分數不可直接比**。每一版的動機、實測數據與驗收，全部記錄在 [BALANCE-RESEARCH.md](BALANCE-RESEARCH.md)，這裡不重複。

### 「我玩了很多場，數字怎麼都沒增加？」

因為**觀戰不訓練**。`ai/trained-attack.js`／`ai/trained-defense.js` 是訓練成果的**快照**：瀏覽器不會回寫任何東西——網頁上沒有梯度、不落盤、也不存檔。要讓分數真的上去，只有跑訓練這一條路——最省事就是下面的全自動模式。

但觀戰有**自動跟隨**：每 12 秒重讀一次那兩份快照。訓練端若用 `--export-every 1` 每代刷新（`ai/auto-train.js` 預設就是），左欄 ① 的代數與快照時間會自己往上走，任一族的冠軍換人時場上該隊的車直接換網路，**不必重新整理**。① 那塊的值欄只放「場上這顆大腦是第幾代、拿幾分」，細節（練到第幾代、快照幾時匯出、對面是誰）收在滑鼠提示裡。「本機累計已看 N 輪」存在 `localStorage`，只是本機計數，跟 AI 變不變聰明無關。

### 雙族群：進攻模型與防守模型分開練

「藍進攻、紅防守」之後，一個族群不可能同時把兩件事都練到最好，所以訓練端拆成兩族：

```bash
node ai/split.js                       # 第一次：從舊的單模型冠軍拆出進攻族＋防守族兩份存檔
node ai/auto-train.js                  # 之後交替演化（auto.bat 就是這條）
```

`ai/auto-train.js` 每一輪做兩段：**進攻族練 N 代**（對手＝防守族最新的冠軍）→ 匯出 → **防守族練 N 代**（對手＝剛匯出的進攻族新冠軍）。兩族互為考題，一邊變強另一邊的尺跟著變嚴。各自一份 checkpoint（`runs/attack-v6.json`／`runs/defense-v6.json`，檔名裡的 v6 是開族標籤不是算分版本）、各自一份觀戰快照（`ai/trained-attack.js`／`ai/trained-defense.js`），絕不共用。

觀戰時 `index.html` 的藍席放進攻模型、紅席放防守模型（右欄 ③「上場的模型」可切：雙模型對打／同網自我對弈／藍網路・紅規則／藍規則・紅網路）。即時看板 `ai/live.html` 一次只反映**正在練的那一族**；要看兩族的歷史請開 `ai/ledger.html`（`node ai/ledger.js --all` 產生）。

### 全自動模式（雙擊 `auto.bat`，之後不用手動匯出、不用按鍵）

「我要自動遊戲自動訓練 不要有手動處理」——這條路把整條產線接起來：

```bash
node ai/auto-train.js             # 無限輪，每輪「進攻族 20 代 → 防守族 20 代」自動接續
node ai/auto-train.js --gens 10   # 每段改 10 代
node ai/auto-train.js --once      # 只跑一輪就停（測試／有事要關機）
node ai/auto-train.js --mode rule # 觀戰改成「藍＝進攻網路、紅＝規則 AI」（預設 dual）
node ai/auto-train.js --stage 2   # 看地圖索引 2（STAGE 顯示 3）
node ai/auto-train.js --no-open   # 不自動開瀏覽器
node ai/auto-train.js --off       # 停用「開頁面自動觀戰」（不會停訓練）
```

它做五件事：

1. **兩族交替訓練**：子程序跑 `ai/evolve.js --resume <該族存檔> --gens N --save-every 1 --export-to ai/trained-<角色>.json --export-every 1`，對手取另一族最新的冠軍快照。
2. **每代刷新兩份快照**：瀏覽器每 12 秒重讀，代數與匯出時間自己動，冠軍換人時場上直接換 policy。
3. **自動開場**：寫出 `ai/auto-watch.js` 旗標，`index.html` 一打開就自己進觀戰。想自己玩時，在觀戰結束畫面按 Enter 回標題即可。
4. **第一次開機也零手動**：兩份 v6 存檔若不存在，先自己跑 `node ai/split.js` 拆出兩族。
5. **掛掉自動重開**：子程序非零結束會在 5 秒後重試（退避最多 60 秒）；只有 Ctrl+C 會真的停，並把旗標刪掉。

進度看兩處：`runs/trainer.log`（訓練原始輸出）與 `ai/live.html`（即時看板）。鎖檔 `runs/auto-train.lock` 會擋掉重複啟動，避免兩支程序互相蓋存檔。⚠ 從 agent 的 shell 重啟時（一般使用者不受影響、照舊雙擊 `auto.bat`）：`cmd //c start` 在部分機器開不出新主控台，能用的是 `node runs/_launch-trainer.js`（detached spawn）；脫離之後停止要用 `taskkill //PID <runs/auto-train.lock 裡的 pid> //T //F`（存檔是 tmp+rename，最多損失「當前這一代」）。

### 邊看邊練（同時觀戰與訓練）

訓練是純 Node 的無頭模擬，觀戰是瀏覽器裡的獨立程序，兩者互不干擾：**可以一邊開著 `index.html` 看舊快照、一邊在另一個終端機訓練**。要只跑固定幾代時用 `train.bat`，它等於：

```bash
node ai/train-cli.js                 # 進攻族 runs/attack-v6.json，20 代
node ai/train-cli.js defense         # 換防守族（runs/defense-v6.json）
node ai/train-cli.js defense 10      # 防守族只跑 10 代
node ai/train-cli.js 40 runs/neat.json   # 指定存檔（角色從檔名認）
# 參數不拘順序：角色 / 代數 / 存檔路徑 各認各的
```

⚠ 只練一族時，對手取**另一族最新的冠軍快照**（拿不到才退回規則 AI），所以分數仍舊可比；但「一邊變強另一邊的尺跟著變嚴」的交替不會自己發生，那是 `auto.bat` 的事。同一份存檔**不要同時開兩個訓練程序**。確認訓練活著最快的方式：`node ai/evolve.js --status runs/<存檔>.json`（「最後落盤幾秒前」每 2 代歸零一次，超過 3 分鐘沒更新就是掛了）。

### 即時訓練看板（`ai/live.html`）

雙擊 `ai/live.html`（`file://` 直接開）。它每 3 秒重讀 `ai/live-data.js`，顯示目前世代、歷史最佳、本代平均、累計場數、冠軍停滯代數、本段進度與預估剩餘時間、考題設定、實戰考績、最近世代與歷次工作階段；收斂曲線把「換圖」「換算分版本」「換對手」「工作階段開始」畫成虛線，接縫前後不假裝可比。

**「它到底有沒有變強」靠兩把不進適應度的參考尺回答**（`--ref` 或自動找 `ai/refs/` 下的凍結尺）：一把是遊戲內建規則 AI，一把是**凍結的對手機快照**（`ai/refs/` 下的檔案永不更新）。每代拿同一批個體去打固定的 8 場考題。判讀方式：活對手每段都在變，主曲線跳一格可能只是**換尺**；如果那兩條虛線同向移動，才是真的變強或變弱。另有「原始分」與「0 分占比」兩欄，不然「最佳平在 0」在圖上跟真的停滯長得一模一樣。

### 過程監測網頁（`ai/monitor.html`）

「最後誰贏」看不出訓練好不好——一台貼著牆掃射、從不機動的坦克照樣能贏規則 AI。所以監測量的是**過程**：`ai/telemetry.js` 在每一幀記下每台被網路控制的坦克按了什麼、動了沒有、子彈死在哪、走過哪些格子，再用 10 條紅旗把「結論好看但過程是壞的」打法抓出來（動作單一、從不後撤、卡牆開火、不推進、其實是規則 AI 在開、送頭、拆自己家……每條紅旗都附實測值、門檻與修法）。

```bash
node ai/monitor.js --ckpt runs/warm.json --stage 0 --games 4    # 產出 ai/monitor-data.js，再開 ai/monitor.html
node ai/monitor.js --ckpt runs/seed.json,runs/warm-v2.json --stage 0 --games 4   # 多份 checkpoint 橫向比較
```

### 訓練履歷（`ai/ledger.js`）

監觀看「這一輪怎麼打」，觀戰看「這一場怎麼打」，履歷回答另外兩個問題：**牠到底被訓練過幾次**、**牠是被什麼標準評出來的**。

```bash
node ai/ledger.js --ckpt runs/warm-v2.json      # 文字版履歷（含歷練時間軸）
node ai/ledger.js --all                         # 掃 runs/ 與 ai/trained.json 一次看完
node ai/ledger.js --rubric                      # 只印評判標準（進攻 24 項／防守 23 項＋10 條紅旗＋12 條協議）
node ai/ledger.js --verify runs/warm-v2.json    # 用沒參與評估的新種子實戰一輪，考績寫回檔案
node ai/ledger.js --ckpt runs/warm-v2.json --breakdown   # 拆一局給你看各項貢獻怎麼加總
```

三個設計點：**標準與算分出自同一支碼**（每一項權重都是 `ai/fitness.js` 的 `TERMS`，不是另外寫的說明文件）；**舊存檔不編故事**（沒有 `sessions` 的存檔會標成「推導」）；**考題與考績分開**（評估與 `--verify` 用不同種子，否則勝率量的是背題不是會打）。

### 訓練設計的不變量

1. **一局必須可重現**：`(地圖, 種子, 控制器組合)` 完全決定結果。`ai/arena.js` 用 `vm` 沙盒載入**真正的遊戲碼**（DOM、canvas、`localStorage`、`requestAnimationFrame` 全打樁），訓練場裡的行為跟瀏覽器裡看到的是同一套實作。
2. **適應度逐幀歸一化**：流量型計量（擊殺、傷害、開火、撿道具）一律換算成「每 1000 在場幀」，在場幀扣掉出生無敵與被凍結，避免「活著不動」刷分。
3. **觀測規格不能改**：`ai/observation.js` 的 `OBS_SPEC`（v2、85 欄）一旦改版等於作廢所有既有基因組；checkpoint 記錄規格版本，載入不符直接失敗並說明原因。
4. **座位公平**：地圖上下點對稱、兩隊首發同幀、每幀隨機翻轉結算順序（否則「同幀互毀」全由固定一隊獲勝）、每個基因組在同一組 `(地圖, 種子)` 下藍紅各坐一次取平均。NEAT 會把任何系統性偏置放大成高分——不修正就會練出「假聰明」。
5. **過程也計分**：卡牆比例、動作單一、零傷害開火、打到自己家都以**連續梯度**進適應度懲罰（純規則 AI 的隊伍不受誤傷）；亂槍掃射由「每發子彈造成的 hp 損失」封頂；整局躺平直接歸零；拖到幀上限沒結果扣分。

## 技術實作

```
index.html          版面：左右資訊面板 + canvas
css/style.css       HUD 版面
js/constants.js     所有常數與列舉（單一真相來源）
js/input.js         鍵盤輸入（held / one-shot）
js/audio.js         WebAudio 合成音效（無音檔）
js/sprites.js       程序化產生所有貼圖（無圖檔）
js/mapgen.js        程序化地形（mapId → 固定種子 → 固定地形；含 tile 級 Dijkstra 開路）
js/map.js           18×42 cell 地形、基地（要塞磚環）、鏟子
js/entities.js      Tank / Bullet（grid-locked 移動）
js/ai.js            坦克 AI（單人與觀戰共用；觀戰的席位分岔也在這）
js/powerups.js      道具產生與生命週期
js/renderer.js      Canvas 渲染 + DOM HUD
js/game.js          狀態機 + 主迴圈 + 規則
js/watch.js         瀏覽器載入訓練基因組上場（兩席各自的角色模型、每 12 秒自動跟隨新冠軍）
js/hud.js           左右兩欄面板＋競賽感疊層（系列賽／Kill feed／結算卡／張力）
ai/engine.js        `vm` 沙盒：把真正的遊戲碼載進 Node（打樁 DOM/canvas/localStorage/rAF）
ai/observation.js   遊戲狀態 → 85 欄觀測向量（OBS_SPEC 帶版本，定稿後不可改）
ai/controller.js    policy → 坦克輸入；含卡牆反射與「別打自家老鷹」安全閘
ai/arena.js         無頭競技場：跑一局、量一局（逐幀差分，不改遊戲規則）
ai/teacher.js       示範資料收集：規則 AI 打的時候逐幀記（觀測 → 決定）
ai/imitate.js       行為複製：示範 → MLP 擬合 → 合法基因組（runs/seed.json）
ai/neat.js          NEAT：創新歷史、結構變異、物種化、交叉、JSON 快照、暖啟動
ai/fitness.js       適應度：逐幀歸一化 + 目標拆解 + 反刷分 + 過程懲罰（SCORING_VERSION 在這）
ai/balance.js       起步平衡度探針（唯讀）：--mode ceiling|matrix|ladder、--terms
ai/telemetry.js     逐幀過程監測 + 10 條紅旗規則
ai/checkpoint.js    原子落盤／跨 process 載回
ai/evolve.js        訓練 CLI（--gens/--episodes/--resume/--seed-from/--report/--status/--export/--export-to）
ai/live.js / live.html / live-data.js   即時訓練看板（file:// 直接開，每 3 秒重讀）
ai/ledger.js / ledger.html              訓練履歷（時間軸／標準表／考績／逐項拆解）
ai/train-cli.js     一鍵訓練本體（train.bat 只留 ASCII 外殼）
ai/auto-train.js    全自動產線：兩族交替、每代匯出雙快照、鎖檔防重複啟動
auto.bat / train.bat    Windows 雙擊啟動（全自動交替／固定代數）
ai/monitor.js / monitor.html            過程監測網頁（多 checkpoint 橫向比較）
ai/trained-attack.* / trained-defense.* 觀戰快照（json 給 Node、js 給 file:// 瀏覽器）
ai/seeds/seed-*.json  模仿種子的定格副本（CI 讀這份；重記種子後要蓋進來）
measure-breach.js   唯讀探針：規則 AI 破局／時間到／反殺分布
audit-intensity.js  唯讀探針：對戰激烈度（終局秒數／擊殺／每殺耗彈）
BALANCE-RESEARCH.md 每一批調整的動機、實測數據與驗收指標對照（研究履歷）
.github/workflows/ci.yml    push／PR 自動跑三套測試＋快照完整性檢查
test-harness.js     Node 無頭回歸測試
test-neat.js        NEAT 不變量測試
test-train.js       訓練管線測試
```

- **最小字級 16px（使用者規則）**：所有頁面文字 ≥16px，層次靠 17～30px 拉，不靠縮字。
- **座標系統**：1 子格 = 8px，戰場 18×42 格（9:21）= 144×336 邏輯 px，坦克 16×16。畫布 288×672（`SCALE = 2`），頁面用 CSS 依視窗高度放大，位圖不放大（`SPRITE_SS = 2`，貼圖以 2× 細節解析度繪製再縮回邏輯尺寸）。
- **移動手感**：轉向時垂直軸自動吸附到最近格線，前進只改方向軸座標，不會漂移、不會卡牆。
- **迴圈**：`requestAnimationFrame` + 固定 60fps timestep 累加器，邏輯更新與渲染分離。
- **音效**：方波/鋸齒波/三角波與雜訊緩衝合成，`AudioContext` 延遲建立（瀏覽器首次互動後才會發聲）。

## 測試

無瀏覽器依賴的回歸測試，直接在 Node 執行（需要 Node 16 以上）：

```bash
node test-harness.js     # 遊戲本身與規則層：195 passed, 0 failed
node test-neat.js        # NEAT 不變量：44 passed, 0 failed
node test-train.js       # 訓練管線：313 passed, 0 failed
```

三套也由 `.github/workflows/ci.yml` 在每次 push／PR 自動跑一遍（純 Node，`ubuntu-latest` 上約一到兩分鐘），最後一步還會檢查兩份冠軍快照解不解得開、席位與算分版本跟現行碼對不對得上。測試用 `vm` 沙盒打樁 DOM 後**載入真正的遊戲碼**，驅動真實幀與鍵盤事件驗證行為；涵蓋狀態流轉、磚牆削除、道具、v6 觀戰規則與彈道閘、隨機地形不變量（對抽樣地圖逐張檢查對稱／路徑／出生點淨空）、競賽感唯讀欄位、座位公平、適應度形狀、斷點續存（真的重開一支 node 接回去）、暖啟動門檻。⚠ 地圖改成隨機產生後，測試**刻意不寫死座標**：只留對全部 255 張都成立的不變量，以及用 `blankMap`／`setTile` 自己蓋的乾淨地圖。⚠ CI 是全新 clone、沒有 `runs/`，暖啟動測試找不到 `runs/seed-<席位>.json` 時會退回版控裡的 `ai/seeds/seed-<席位>.json`——重記種子後記得蓋進去。

## 授權與出處

本專案為個人學習用的重實作，遊戲概念源自 1985 年 NAMCO 的 Battle City；程式碼、關卡配置與所有貼圖／音效皆為本專案自行撰寫產生，未使用任何原始遊戲的圖檔或音檔。
