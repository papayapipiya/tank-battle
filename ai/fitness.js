/* ai/fitness.js — 把一局的統計換成適應度（v6 起：進攻／防守各一套評判標準）
   ═══════════════════════════════════════════════════════════
   三條鐵律在這一層的具體落點：

   1. 逐幀歸一化
      一局 600 幀和一局 3000 幀不能直接比「誰殺得多」。
      所有流量型計量（擊殺、傷害、開火）一律換算成「每 1000 在場幀」，
      在場幀又扣掉出生無敵與被凍結，避免「活著不動」刷分。

   2. 目標對齊，而且**要對齊到角色上**
      v5 以前兩隊是同一種任務（各守各家、順帶對射），所以一套 TERMS 通用。
      v6 使用者把方向改了：藍隊＝進攻、紅隊＝防守，兩邊各有自己的模型、
      也各有自己的勝利條件。同一把尺量兩種工作會練出四不像：
      給進攻方「家門口攔截」的分，它就會在家裡巡邏；
      給防守方「拖到時間到」的分，它就會躲進角落不交戰。
      所以現在每一項都標 roles，同一個 key 在兩套標準裡可以有不同權重、
      不同算式，甚至一邊有一邊沒有。

   3. 懲罰刷分與自殘
      亂開槍（每發平均傷害低）、把自己要塞（老鷹或要塞牆）打掉、
      卡牆、只輸出一類動作 —— 都是明確負分。
      ⚠ 防守方另有一道「消極門檻」：撐到時間到確實算贏（使用者的規則），
        但那一項的分數要按「實際上攔了多少」給，
        否則「把車藏在角落不動」就是最安全的局部最優 —— 那正是使用者
        明確反對的東西（「要表現出積極性的進攻跟防守」）。

   ⚠ 為什麼分成 TERMS 與 scoreOf 兩層（而不是把算式直接寫死在迴圈裡）：
     訓練履歷要把「這一局的分是怎麼湊出來的」逐項列給使用者看。
     如果分數一套算法、說明另一套算法，兩者遲早分岔，
     到時展示給使用者的「評判標準」就不是實際在用的那個。
     所以這裡是「先依角色挑出當用的幾項 → 逐項算 → 加總 → 蓋地板」，
     teamFitness 只取最終數字，explainFitness 取同一份逐項明細。
   ═══════════════════════════════════════════════════════════ */
'use strict';

/**
 * 算分規則的「版本」——跟 OBS_SPEC 一樣要在落盤時記下來。
 *   v1：ai/arena.js 的傷害差分漏掉「致命一擊」→ 擊殺幾乎不進 damageDone。
 *   v2：修正；v1 與 v2 不可比。
 *   v3：新增「家門口攔截」與「協同壓制」。
 *   v4：對手變了（規則 AI 不再原地旋轉），考題改變所以升版。
 *   v5：防守從「家門口 56px」擴大到「自家半場」，並規定所有 AI
 *       「轉身必須有位移、走得通不準立刻原路退回」。
 *   v6：**方向修正 —— 藍隊改為純進攻、紅隊改為純防守，兩隊各自有各自的模型。**
 *       三件事同時改變，所以 v5 的分數全部不能跟 v6 比：
 *         · 時鐘從 90 秒縮到 30 秒，且「時間到」不再比積分，直接判紅隊贏；
 *         · 藍隊只剩一個贏法（摧毀紅隊老鷹），因此它的評判標準改用
 *           「推進／拆牆／破局速度」這一整組進攻項，防守項對它不再計分；
 *         · 紅隊改成防守，並加上「消極門檻」：沒攔到人就撐到時間到，
 *           勝利那項拿不到滿分。
 *       同一時間射擊安全判斷也升級：不準打到老鷹**或要塞牆**，
 *       且水／樹林不再被當成「擋住子彈」（js/map.js 的子彈本來就飛得過去）。
 *   v7：**兩件事都來自使用者的新規則，而且都會改變同一批個體的排序：**
 *         · 自己人把自家老鷹打爆 → js/map.js 記錄兇手（base.killedBy），
 *           arena 換算成 ownBaseKilledBySelf／foeBaseOwnGoal，
 *           計分端新增 ownEagleBySelf（−80）＋「自破那局歸 0」的地板，
 *           並把 breach／holdWin／holdGate／speed 從 won 改成 winByMerit：
 *           對方自破送來的勝利不發勝負分，否則「等它自己打死自己」是最省力的贏法。
 *         · 兩台坦克太接近時先解決對方 → js/ai.js 把近身格鬥排進 _goal 第一優先，
 *           arena 新增 duelKills／duelFrames，計分端新增 duelKill（+8，封 4 台）。
 *       v6 的分數不能跟 v7 比（勝負項的成立條件變嚴了），所以舊冠軍會被重新評分。
 *   v8：**考題（環境）變了，不是算式變了 —— 但結果一樣不可比。**
 *         · 使用者：「紅藍的坦克一開始就全部出來，四台」。
 *           js/game.js 的開場從「第 20 幀擠出第一台、之後每 100／150 幀補一台」
 *           改成「開局一次填滿每隊 4 個出生點」（場上上限仍是 4，打完才補）。
 *         · 這直接換掉整局的初始狀態：開局就是 8 台車、子彈密度與擊殺數
 *           一起跳級，而 breach／duelKills／kills／fieldFrames／supportFrames
 *           全都是在這個初始狀態上量出來的。v7 的「開局各 1 台」分數跟
 *           v8 的「開局各 4 台」分數放在一起排，等於拿舊尺量新戰場，
 *           所以照 v4／v6 的先例升版，讓兩族的冠軍在現行考題下重評。
 *         · 權重、地板、TERMS 逐項說明在 v8 沒有改動 —— 改的是量測的戰場。
 *   v9：**戰場換了形狀（26×26 正方形 → 18×42 cells 的 9:21 直立長場），
 *         而且是「隨機地形」取代 35 張手刻關卡。** 使用者指定：
 *         「地圖改成 9:21，地圖放大，地圖隨機」＋「訓練端也隨機」。
 *         · 幾何一變，penetration 那項的「離敵鷹最近距離」就有了新的量程：
 *           進攻方從底邊到紅鷹的直線距離由 184px 變成 312px，歸一化的尺
 *           （HALF_FIELD_PX）跟著從 104 換成 168（= FIELD_H / 2）。
 *         · 考題（地形）本身換成 MapGen 依 mapId 生成 ⇒ breach／foeHalfShare／
 *           fieldFrames／supportFrames 全是在新的空間裡量的。
 *         · 算式與權重沒動，所以 v8 的冠軍可以、也應該在新考題下被重評
 *           （evolve.js 的 championRescore：8 場校準局，不計入訓練場數）。
 *         · 感測器（ai/observation.js 的 OBS_SPEC v2）刻意**不**升版：
 *           升版會讓五個載入點硬擋掉那兩條 ~845 代、16 萬場的 checkpoint，
 *           等於把「越玩越聰明」歸零。座標歸一化仍用 104/208，
 *           所以 y 現在可能超過 1 —— 那是要重新習慣的分佈偏移，不是算分錯誤。
 *   v10：**尺本身重新配平（BALANCE-RESEARCH.md 的 B／C／D），三件事一起動：**
 *         · B「壓低通用交戰項的天花板」：killPer1k 9／封 40 → 4.5／封 24、
 *           damagePer1k 2.5／封 40 → 1.5／封 24、firepowerUp 5→3、powerup 3→2、
 *           duelKill 8→6、teamwork 10→6、accuracy 7→5。實測 `rule·rule` 的
 *           進攻尺裡有 608 分來自「在哪邊都能做的事」，而本業 breach 只有 70 ——
 *           一個只學到「亂開槍也能高分」的族群沒有理由去壓老鷹。
 *           這些項留著（早期唯一的密集梯度），只是不再蓋過本業。
 *         · C「兩族各補一項天天都發生的本業項」：新增 besiege（包圍敵鷹 30）、
 *           denial（拒止：敵隊壓進我家半場的占比愈低愈好，25，但要自家在半場內
 *           攔到 4hp 才給全額）。稀有事件（breach 發放率 39.6%）不能是唯一的方向盤，
 *           起步階段的族群需要每局都按比例拿得到的梯度。
 *           原規畫的第三項 screenHold（門前在場 20）在 48 場實測後刪除了：
 *           隨機按鍵的門前占比（28.0%）比規則 AI（14.8%）還高 —— 存在型分數
 *           「愈無聊愈高」，留著等於獎勵亂晃（詳見 TERMS 裡的刪除記錄）。
 *         · D「勝負項重做」：holdWin 拆成兩種贏法（撐過時鐘 18／打掉藍鷹 45，
 *           用 value 分級、key 不變；45 是量出來的：探針顯示「換上自己的模型」
 *           進攻席加 97 分、防守席只加 14 分，差在防守的決定性一擊只值 30，
 *           本業上限又比進攻矮 14 分）；defense／halfDefense 的封頂從摸不到的
 *           6hp／8hp 壓到 4hp／6hp、單位價抬到同一總量，讓基準線坐到滿分的 0.2～0.5；
 *           holdGate 的門檻從 6 hp 降到 2 hp（原本的 6 hp 實測只發放 0.23～2.6 分，等於是裝飾），
 *           並把「門前在場占比」做成乘在「已攔到傷害」上的加成 —— 只站位、零攔截不發分；
 *           timeoutFail 從全額 −25 改成「按推進程度給部分的罰」，
 *           否則早期進攻族群 50% 的局被同一個 0 抹平，選壓消失。
 *         · 算式與權重都變了 ⇒ v9 的分數不可比，兩族冠軍在新尺下重評
 *           （ai/evolve.js 的 championRescore 會自動觸發，並把接縫寫進履歷）。
 *   v11：**把使用者的攻擊順序寫進尺裡（批次五 J）。**
 *         · 規則端（js/ai.js）已改成「先打敵車，離對方主堡 ≤56px 才改瞄主堡」，
 *           門檻就是牆腳那把尺（AI_ASSAULT_RADIUS＝DEMO_THREAT_RADIUS）。
 *         · 計分端原本不看距離：`foeWall` 只數「敵人要塞牆少了幾格」，
 *           所以站在自家門口隔空啃牆，跟貼到牆腳拆牆一樣值 5 分／格 ——
 *           那等於用分數把「先打地」留下來，跟剛改的規則對著幹。
 *         · 新增逐槍歸因的兩個計量（js/map.js bulletHit 回傳 wallCells →
 *           js/game.js recordWallHit → ai/arena.js 分堆）：
 *           foeWallNear（開火點在敵鷹 56px 內）／foeWallFar（還在門外），
 *           分堆用的判斷是 js/ai.js 的 EnemyAI.baseWithin，不另設門檻。
 *         · foeWall 的算式改成 min(8, near + 0.25×far)：遠距離啃牆仍給一點分
 *           （拆牆確實是推進的必要條件，歸零會讓早期族群失去一條梯度），
 *           但只有貼臉拆的拿全額。breach（70）不打折 —— 老鷹被打掉就是贏，
 *           跟從多遠打的無關，而且它已經是全尺最高的一項。
 *         · 刻意**沒有**加「同軸有敵車卻去啃牆」的負分：spray 那項已在罰
 *           「每發平均傷害 < 0.25」的低效槍，同一件事處兩次會互相蓋掉，
 *           而且「準則變成不打牆」是可被規避的存在型懲罰。先看 48/96 場探針
 *           怎麼說，要加再加（一次只動一個旋鈕，本專案的慣例）。
 *         · 算式變了 ⇒ v10 的分數不可比，兩族冠軍在新尺下重評。
 *   v12：**把「打死人」變成一筆存得下來的錢（批次六：激烈度）。**
 *         · 起因是可量的，不是觀感。`node audit-intensity.js 120` 對同一份考題
 *           （255 張隨機圖 × 各自的 seed）量現任雙冠軍：平均 9.7 秒收場、中位 8.8 秒，
 *           每場 5.9 殺、112.3 發、19.1 發才換一台；同一份考題換規則 AI 上場是
 *           25.6 秒／12.8 殺／54 發／4.2 發一殺。互射占比反而是模型的 60.9% 對規則的 9.0%
 *           —— 缺的不是交火，是「殲滅」與「收尾」：槍很兇，人不死，8 秒就斬首。
 *         · 病根在尺：killPer1k／damagePer1k 是「每 1000 在場幀」的流量計量，
 *           一局只打 9 秒的車把分子分母一起縮小，照樣坐滿天花板；
 *           而 breach(70)＋speed(20) 讓「直取老鷹」遠比「清掉場上的人」值錢，
 *           accuracy(封頂 1.5hp／發)＋spray(-12) 又幾乎不罰 19 發一殺。
 *         · A1 新增 annihilation：min(8, 擊殺數) × 6 —— 尺上第一筆「總量」戰功，
 *           不隨時長打折；短局要拿滿就得真的一台一台清。
 *         · A2 speed 進攻 20→8、防守 12→3，並乘上殲滅實績 min(1, 擊殺數 / 4)：
 *           速決本身不再是一張大獎，要「又快又打死人」才拿得到原來的位置。
 *           兩席幅度不同不是隨手：v10 那條「兩席本業上限差 ≤10」是不變量，
 *           進攻被砍 12 而防守只砍 6 的話差會變成 12.05（破線），砍到 3 才回到 9.1。
 *         · A3 accuracy 封頂 1.5hp/發→0.8hp/發、權重 5→10（總量 7.5→8，但要在每發
 *           都有 0.8hp 的準頭才摸得到），spray -12→-30：彈雨開始賠分。
 *         · A4（A1 的預算，不是新旋鈕）killPer1k 4.5→3.0、damagePer1k 1.5→1.0：
 *           annihilation 那 48 分是「換掉」流量項，不是疊在上面 ——
 *           通用交戰軸的天花板維持 v11 的 242，`--mode ceiling` 量出來的
 *           「本業佔自己天花板」才不會從 44% 被稀釋到 38%（那條線是 v10 的驗收，
 *           也是起步平衡度的來源）。
 *         · 刻意不動 breach(70)：破網仍是進攻席的全部目標，只是不再「越早越划算」。
 *           也沒有新增「貼身對射時長」那項 —— 使用者選的是計分面，先把尺的偏向修正，
 *           一次只動一個旋鈕；規則端（js/ai.js）這版完全沒改。
 *         · 算式與權重都變 ⇒ v11 的分數不可比，兩族冠軍在新尺下重評。
 *   v13：**給「破局」加殲滅實績門檻（批次七：激烈度驗收的第二刀）。**
 *         · 起因仍是量的，而且這次是 v12 自己的後續讀數（`node audit-intensity.js 120`，
 *           BALANCE-RESEARCH §5.9.7；`runs/audit-intensity.v12-mature2.log`，藍 4064／紅 4026）：
 *           v12 把三條線都拉回正確方向（中位終局 8.8 → 10.8 秒、每場擊殺 5.9 → 8.4、
 *           每 1 殺 19.1 → 14.5 發），但使用者選的三條驗收線（≥15 秒／≥9 台／≤8 發）**全部仍未過**，
 *           而且 120 局裡 38.3% 還在 10 秒內收場。
 *         · 病根在 v12「刻意不動」的那一項：`node ai/balance.js --mode matrix`（兩席冠軍對打那格）
 *           量到進攻席最大的單一項還是 breach ＋40.83／局、發放率 58.3%、**不問清了幾台**，
 *           同一格局均 573 幀＝9.6 秒；`annihilation` 雖然從 18.00 長到 22.75，
 *           「先清人再破網」在排序上跟「繞過所有人直取老鷹」**同分、但更慢**，尺並沒有在選前者。
 *         · 動作：breach 由「打破就值 70」改成「打破 × min(1, 擊殺數 / 6) × 70」。
 *           型式沿用 v12 給 speed 的那條實績門檻，只是線拉到 6 台（一隊 20 台、開場 4 台，
 *           6 台是「壓倒性但還沒屠場」的程度，比 annihilation 的封頂 8 台低一档）。
 *         · 規則端 js/ai.js 一行不動：破局照樣算贏，只是勝負分不再無條件全額發放。
 *           也不動 foeWall／besiege／annihilation／spray —— 一次只動一個旋鈕。
 *         · ⚠ 已知代價（都在 §5.9.7 算過）：現任進攻冠軍每局平均 3.8 殺，門檻把它的 breach
 *           從 70 打到 ≈44.3，落地必定掉分（又一次換尺，舊分數全部作廢）；
 *           進攻席只剩「稀有事件 × 實績」這一條勝負訊號，排序變稀，要重新量信噪比
 *           （v12 那輪量到的是每局 σ 66.46 → 24 局均值 σ 13.57）。
 *         · 算式變了 ⇒ v12 的分數不可比，兩族冠軍在新尺下重評。
 */
/** 場地半場（px）：penetration 項用它把「離敵鷹最近多少」歸一化。
 *  = js/constants.js 的 FIELD_H / 2（9:21 之後是高度的一半，不是寬）。
 *  本檔跑在 vm 外拿不到 bundle 的 const，所以抄一份並由 test-train.js
 *  拿無頭引擎的 R.FIELD_H 對它做一次相等檢查 —— 抄錯不會報錯，
 *  只會讓「推進到城門口」這項永遠給 0 分。
 *  ⚠ 必須宣告在 SCORING_VERSION_NOTE 之前：那是同檔的 const，
 *     有暫時性死區，放在後面引用會直接 ReferenceError。 */
const HALF_FIELD_PX = 168;

/* v10 新增「本業占比」的滿分線（ai/arena.js 逐幀量出來的比值 → 0..1 的分）。
 * 這幾條線是量的，不是猜的 —— 批次二（角色化規則 AI）＋批次三（計分 v10）落地後
 * 重跑 ai/balance.js --mode matrix --maps 16 --seeds 3（48 場，涵蓋 rand·rand 與 rule·rule）：
 *   藍隊貼在紅鷹 56px 圈內      rule 中位 6.0%、p25 3.2%、p75 8.5%、p98 17.8%｜rand 0.000
 *   紅隊擋在老鷹靠敵一側 56px  rule 中位 14.8%、p25 10.4%、p75 20.8%、p98 38.1%｜rand 中位 28.0%
 *   藍隊壓進紅隊半場            rule 中位 42.2%、p25 27.5%、p75 52.0%、p98 67.1%｜rand 0.000
 *   紅隊半場內攔下的傷害        rule 中位 4 hp（舊 holdGate 的 6 hp 門檻因此在實測中很少湊齊）
 * 校準原則：規則 AI（＝什麼都不學就做得到的程度）落在 0.4～0.6 之間 ——
 * 往上還有明顯空間可爬，往下（亂開槍、整局躲家）拿不到分。
 * 換地圖、換出兵節奏都要重看這幾個數，線跟著動（本檔的注記＋探針會抓到）。
 * ⚠ 同一份資料也殺掉了「門前在場」那一項：rand 的占比（28.0%）比 rule（14.8%）高，
 *    代表「在門口待多久」是愈會玩愈低的存在型分數，隨機的車被牆跟老鷹圈困住就吃飽。
 *    詳見 TERMS 裡 denial 之後那段刪除記錄。 */
const BESIEGE_FULL = 0.15;        // 敵鷹門口 56px 圈內的在場幀占比 → 滿分
const GATE_HOLD_FULL = 0.30;      // 自家老鷹門口同一圈的在場幀占比 → 滿分（holdGate 的一半）
const DENIAL_ZERO = 0.55;         // 敵隊壓進自家半場 55% ⇒ 拒止 0 分
const DENIAL_FULL = 0.25;         // 壓不進來（≤25%）⇒ 拒止上限
const DENIAL_PROOF_HP = 4;        // 拒止要自家先攔到 4hp 才算全額（rand·rand 攔 0hp ⇒ 這一項 0 分）
const GATE_HP_FULL = 5;           // defense（家門口攔截）封頂的 hp
const HALF_HP_FULL = 6;           // halfDefense（半場攔截）封頂的 hp
const WALL_CELL_CAP = 8;          // foeWall 封頂的格數（牆共 20 格，v6 起就封在 8）
const WALL_FAR_SHARE = 0.25;      // v11：開火點在敵鷹門口（56px）外時，每格的折算比例

/* v12（激烈度）的尺＋v14（選得動）的兩把新尺。都是從 `node audit-intensity.js 120`
 * 與 `node measure-termsigma.js 24` 的實測長出來的：
 *   模型冠軍 9.5 秒收場／6.9 殺／17.2 發一殺｜規則 AI 同一組考題 31.5 秒／12.8 殺／4.2 發一殺（兩邊都是中位數）。
 * ⚠ 這幾個數會同時出現在履歷（ai/ledger.js TERMS 拆解）與測試的期望算式裡，
 *    一律從這裡取，不要在別處重打 —— 改了這裡沒改那邊，看板就跟實際計分對不上。 */
const ANNIHILATION_CAP = 6;       // v14：8→6 台（單價 6→8、總量 48 不變）—— 封頂落在族群真正住著的區間之上
const SPEED_KILL_PROOF = 4;       // speed 要幾台擊殺才給滿（比照 DENIAL_PROOF_HP 的「實績」做法）

/* v14：accuracy 的口徑從「每發平均傷害」換成「每 1 殺發數」。
 * 換掉的理由是量出來的，不是感覺：舊口徑在族群裡 σ 只有 0.39／0.36、每場發到 0.82／0.75 分
 * （滿權重 10），因為 0.8hp/發 那道封頂要「每發推掉五分之一台車」才摸得到，而現任冠軍是 15～17 發才換一台 ——
 * 大家都貼著 0，這一項在選擇上就不存在（v12 押在命中上的那條線實際上選不動）。
 * 新口徑是一條穿過族群實際所在區的斜坡：ACCURACY_SPK_ZERO 發一殺 ⇒ 0 分、ACCURACY_SPK_FULL 發一殺 ⇒ 滿分，
 * 兩端刻意包住驗收線（每 1 殺 ≤8 發）與現況（17.2 發），所以「少開一槍換一台」立刻變成可見的梯度。 */
const ACCURACY_SPK_ZERO = 20;     // 每 1 殺 20 發 ⇒ 這一項 0 分（比現況 17.2 再差一點才歸零，免得又貼地）
const ACCURACY_SPK_FULL = 6;      // 每 1 殺 6 發 ⇒ 滿分（驗收線 8 發之上再嚴一檔，老師是 4.2）
const ACCURACY_MONEY = 8;         // 滿分金額：沿用 v12 的 0.8hp×權重 10＝8，改值不改頂（通用交戰軸 242 不能動）

/* v14：spray 的門檻跟著「每殺耗彈」走，不再是「每場開火量」。
 * 舊門檻（每場 >30 發且每發 <0.25hp）在現行每場 105～118 發之下早已每局踩滿（防守席 96%），
 * 罰到頂就是常數項 —— 跟沒有這一項一樣。現在從 ACCURACY_SPK_ZERO（20 發一殺）起罰、
 * 到 SPRAY_SPK_MAX（40 發一殺）罰滿，斜坡落在族群的右尾，所以它有梯度、而且跟 accuracy 不重疊
 * （accuracy 管 6～20 那一段的「獎勵」，spray 管 20 以上那一段的「罰」，兩段剛好接起來、不重複收費）。 */
const SPRAY_SHOTS_MIN = 30;       // 至少要開滿這個數才考慮判成彈雨（樣本太小不罰，v6 以來的老規矩）
const SPRAY_SPK_MAX = 40;         // 每 1 殺 40 發 ⇒ 罰滿（-30）；起點沿用 ACCURACY_SPK_ZERO＝20

/* v13（破局要殲滅實績）的那道門檻。跟上面幾把尺一樣是從實測長出來的，不是拍的：
 * `node ai/balance.js --mode matrix`（runs/balance-matrix.v12-mature2.json，兩席冠軍對打 24 局）
 * 讀到進攻席 breach ＋40.83／局、發放率 58.3%、每局擊殺只有 3.8 台、局均 573 幀＝9.6 秒。
 * 定在 6 台的理由：一隊出兵 20 台、開場 4 台，6 台是「壓倒性但還沒清場」，
 * ⚠ v14 起 annihilation 的封頂也收在同一格（ANNIHILATION_CAP＝6）—— 原本這裡寫的是「門檻要比封頂低，
 *   否則拿滿 breach 變成拿滿 annihilation 的重複收費」，v14 把封頂從 8 收到 6 之後這兩條線重合了。
 *   這是刻意的，不是漏改：驗收線要的是「每場 ≥9 殺」（每隊 4.5 殺），族群真正住在 0～6 這一段，
 *   把兩條線對齊等於讓「打死第 6 台」同時抬滿勝負項與殲滅項（＋8＋約 11.7），重複的方向跟想要的方向一致。
 *   若日後要拆開，動的是這裡兩個數字的相對位置，不是把 breach 的 70 降價。
 * ⚠ 這條線會同時出現在履歷（ai/ledger.js 讀 TERMS.formula）與測試的期望算式裡，一律從這裡取。 */
const BREACH_KILL_PROOF = 6;

const SCORING_VERSION = 14;

/** 一句話講清楚「這一版改的是什麼」：
 *  收斂曲線上的接縫（ championRescore ／換版）要能被看懂，
 *  不然使用者只看到「v7 → v8，分數掉了一截」，不知道掉的那一截是尺變了還是車變弱了。
 *  升版時在這裡補一句，訓練履歷／考題那一段會把它印出來。 */
const SCORING_VERSION_NOTE =
  `v${SCORING_VERSION}＝把「選不動的項」改成有梯度的口徑（批次八 A）：尺的勝負項一個都沒動，` +
  '改的是三項跟「激烈度驗收」直接有關、卻在族群裡退化成常數的項。' +
  `① accuracy 從「min(${0.8}, 造成傷害／開火數) × 10」換成「每 1 殺發數 ${ACCURACY_SPK_ZERO}→0 分、${ACCURACY_SPK_FULL}→滿分」的斜坡、權重 10→8（滿分金額維持 ${ACCURACY_MONEY}）—— ` +
  '段邊界那格實測舊口徑每場只發 0.82／0.75 分、σ 0.39／0.36、踩滿 0%：15～17 發才換一台時人人都貼著 0，' +
  '大家都 0 的項在選擇上等於沒有項，v12 押在「命中」上的那條線實際上選不動。' +
  `② spray 的門檻從「每場 >${SPRAY_SHOTS_MIN} 發且每發 <${0.25}hp ⇒ 罰滿」換成「每 1 殺 >${ACCURACY_SPK_ZERO} 發起罰、到 ${SPRAY_SPK_MAX} 罰滿」的斜坡（單價 -30 不變）—— ` +
  '舊門檻在每場 105～118 發之下每局都踩滿（防守席 96%、σ 6.0），每局都罰滿的懲罰項跟沒有這一項一樣。' +
  '兩段口徑對齊驗收線（每 1 殺 ≤8 發）：6～20 那段由 accuracy 發獎、20 以上那段由 spray 處罰，接起來但不重疊。' +
  `③ annihilation 封頂 8→6、單價 6→8（${ANNIHILATION_CAP}×8＝48 總量不變），把「多殺一台」的邊際價值抬在族群真正住的 0～6 殺那段；` +
  '封頂 8→12、單價 6→4 那種同額但反向的動法會讓梯度變緩，落地前先否掉。' +
  `⚠ 這一把讓 annihilation 的封頂跟 breach 的實績門檻（${BREACH_KILL_PROOF} 台）重合了，理由記在 BREACH_KILL_PROOF 那段注記裡。` +
  '規則端 js/ai.js 一行不動；天花板（419.80／428.93）、項數（攻 24／守 23）、通用交戰軸 242 全部逐字不變（改值不改頂）。' +
  `v13＝破局要殲滅實績（批次七）：breach 從「打破就值 70」改成「打破 × min(1, 擊殺數/${BREACH_KILL_PROOF}) × 70」—— ` +
  'v12 給「殲滅」定價了，但沒重新定價「破局」，所以 24 局冠軍對打實測裡進攻席最大的單一項仍是 breach（＋40.83／局、發放率 58.3%、不問清了幾台），' +
  '同一格局均 573 幀＝9.6 秒：「先清人再破網」跟「繞過所有人直取老鷹」同分，尺沒在選前者。' +
  `門檻型式沿用 v12 給 speed 的那一條（min(1, 擊殺/${SPEED_KILL_PROOF})），線拉到 ${BREACH_KILL_PROOF} 台；` +
  '規則端 js/ai.js 一行不動（破局照樣算贏），foeWall／besiege／annihilation／spray 也都不動。' +
  '⚠ 代價：現任冠軍在「只斬首」的考題上會掉分（實測每局 3.8 殺 ⇒ breach 70→約 44），' +
  '而進攻席的勝負訊號從「稀有事件」變成「稀有事件 × 實績」，排序更稀，信噪比要重新量。' +
  'v12＝激烈度（批次六）：尺上第一次有「殲滅總量」這筆錢 —— ' +
  '新增 annihilation ＝ min(8, 擊殺數) × 6（不隨時長打折，短局要拿滿就得一台一台清；v14 改成 6×8，總量不變）；' +
  `speed 進攻 20→8、防守 12→3，再乘殲滅實績 min(1, 擊殺數/${SPEED_KILL_PROOF})（速決不再是一張大獎）；` +
  'accuracy 封頂 1.5hp/發→0.8hp/發（權重 5→10，總量 7.5→8）、spray -12→-30（每發 <0.25hp 的彈雨開始賠分）—— 這兩項的口徑在 v14 又換了一次，理由見上面那段。' +
  '新項是「換掉」不是「加在上面」：killPer1k 4.5→3.0、damagePer1k 1.5→1.0，通用交戰軸的天花板維持 242，' +
  '兩席本業上限的差也壓回 ≤10（防守 speed 因此砍到 3 而非 6）。' +
  'breach(70)／foeWall／besiege／denial 那些不動，規則端 js/ai.js 這版完全沒改 —— 量到的病是「槍很兇、人不死、8 秒斬首」，' +
  '而這是尺把「早收場」定價太高、「打死人」按流量給分的結果，不是選靶的問題。' +
  `v11：攻擊目標順序進計分（批次五 J）—— 拆敵人要塞牆要看在哪裡開的槍：` +
  `foeWall 改成 min(${WALL_CELL_CAP}, 近距離格數 + ${WALL_FAR_SHARE}×遠距離格數)（${WALL_CELL_CAP} 格封頂不變），` +
  `「近」＝開火點離敵鷹 ≤56px（跟規則 AI 改瞄主堡的門檻同一把尺，由 js/ai.js 判），` +
  '新計量 foeWallNear／foeWallFar（逐槍歸因到子彈的開火點）；breach／penetration／besiege 那些不動，' +
  '也沒有加「同軸有敵車卻啃牆」的負分（spray 已在罰低效槍，同一件事處兩次會分不清動的是哪條）。' +
  'v10＝尺重新配平：通用交戰項天花板壓到本業之下（擊殺效率 9/40→4.5/24 等 7 項）、' +
  '新增兩項「天天都發生」的本業項（包圍敵鷹 30／拒止 32，第三項「門前在場 20」量過 48 場後刪除：隨機按鍵的門前占比比規則 AI 還高）、' +
  'holdWin 拆成撐時鐘 18 與打敵鷹 45、holdGate 25→34、家門口攔截 30→35、半場攔截 20→24（把防守本業上限 173 補到 196，與進攻的 190 同高）、holdGate 門檻 6hp→2hp 且門前占比只做加成（零攔截不發分）、' +
  '拖到時間到的罰改成按推進程度給部分的；' +
  'v9＝9:21 直立長場（18×42）＋隨機地形，penetration 的半場尺從 104 換成 ' +
  `${HALF_FIELD_PX}（= FIELD_H/2）；` +
  'v8＝開場 4 vs 4；v7＝自破老鷹記帳＋貼身先解決對方；v6＝藍進攻／紅防守雙模型。';

/** 角色：藍隊永遠進攻、紅隊永遠防守（席位由 js/constants.js 決定） */
const ROLES = Object.freeze({ ATTACK: 'attack', DEFENSE: 'defense' });
const ROLE_LABEL = Object.freeze({ attack: '進攻', defense: '防守' });
const ATTACK_TEAM = 0;
const roleOfTeam = teamId => (teamId === ATTACK_TEAM ? ROLES.ATTACK : ROLES.DEFENSE);

const W = {
  // ── 勝負 ──
  breach: 70,              // 進攻：摧毀紅隊老鷹（藍隊唯一的贏法）；v13 起要按殲滅實績打折，見該項 value
  timeoutFail: -25,        // 進攻：30 秒到還沒破局（v10 起按推進程度打折，見該項 value）
  holdWin: 45,             // 防守：打掉藍隊老鷹＝滿分；只撐過時鐘＝0.4（18 分，與 v9 同值）
  holdGate: 34,            // 防守：這局贏得不消極（v10：2hp 門檻＋門前占比；25→34 把防守本業上限補到與進攻同高）
  ownBaseAlive: { attack: 6, defense: 14 },
  speed: { attack: 8, defense: 3 },   // v12：20→8／12→3，且要殲滅實績才給滿（為什麼兩席砍的幅度不同見 speed 的 why）
  stalemate: -18,          // 跑到無頭引擎保險絲還沒有結果

  // ── 進攻推進 ──
  foeHalf: 14,             // 壓進敵半場的在場幀占比
  penetration: 10,         // 離敵鷹最近到哪裡
  foeWall: 5,              // 拆掉敵人要塞牆幾格（v11：只有貼到門口開的槍算全額，遠距離打 0.25 折）
  besiege: 30,             // v10 進攻：貼在敵鷹門口多久（包圍）

  // ── 防守成果 ──
  defense: 7,              // 家門口（老鷹 56px 內）攔下的傷害（v10 校準：5→7、封頂 6hp→5hp）
  halfDefense: 4,          // 自家半場（家門口以外）攔下的傷害（v10 校準：2.5→4、封頂 8hp→6hp）
  denial: 32,              // v10 防守：把敵隊擋在自家半場外面（要自家有攔截實績才算數；25→32 同上）

  // ── 兩邊都算的戰鬥與紀律（v10：天花板統統壓到本業之下）──
  teamwork: 6,
  killPer1k: 3.0,          // v12：4.5→3.0（封頂 24/1000 幀不動 ⇒ 天花板 108→72）。理由見 annihilation
  annihilation: 8,         // v14：6→8（封頂 8→6 台，總量 48 不變）—— 邊際價值要落在族群真正住的 0～6 殺這一段
  death: -4,
  damagePer1k: 1.0,        // v12：1.5→1.0（封頂 24 ⇒ 36→24），與 killPer1k 同一個理由
  accuracy: 8,             // v14：10→8，但口徑從「每發平均傷害（封頂 0.8hp）」換成「每 1 殺發數」的斜坡（總量 8 不變）
  powerup: 2,
  firepowerUp: 3,
  ownBaseCellLost: -3,
  selfBaseShot: -7,
  ownEagleBySelf: -80,       // v7：把自己家老鷹打爆（比拆牆嚴重一個等級）
  duelKill: 6,               // v7：貼身距離內解決掉一台敵車
  wallPin: -40,
  monotony: -35,
  spray: -30,                // v12：-12→-30，實測 19 發才換一台的彈雨在舊價下完全不在乎
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const both = [ROLES.ATTACK, ROLES.DEFENSE];

/**
 * 評判標準的單一真相來源。每一項：
 *   key / label / roles（這一項對哪個角色生效）
 *   weight（數字，或 {attack, defense} 兩套權重）
 *   formula（用人話寫出的算式；角色不同時可給 {attack, defense}）
 *   cap（上限）/ gate（生效條件）/ why（存在理由）
 * value(ctx) 是「乘上權重之前的量」，可能是 0/1 開關、比例或計數。
 */
const TERMS = [
  /* ══ 勝負：兩個角色是兩種不同的贏法 ══════════════════════ */
  {
    key: 'breach', label: '摧毀紅隊老鷹', roles: [ROLES.ATTACK], weight: W.breach,
    formula: `進攻方自己把紅隊老鷹打掉 × min(1, 擊殺數 / ${BREACH_KILL_PROOF}) × 70；紅隊自破不算戰功`,
    why: '使用者規則：藍色只能把對方打敗才算贏。這一項就是進攻方的全部目標，' +
      '所以它是全表最大的一項 —— 其它進攻項只是「還沒打破時的方向指引」。' +
      'v7 起加了一道歸因：紅隊把自己的老鷹打爆時，規則上藍隊確實贏了，' +
      '但那是對方犯的錯，不是藍隊打出來的 —— 發分等於教網路「等對手自殺」。' +
      'v13 再加一道實績：打破老鷹只是「結果」，尺要付錢的是「把場上的人清掉之後再打破」。' +
      '⚠ 這一次的依據是 v12 自己的後續讀數（不是觀感）：`node audit-intensity.js 120` 兩席成熟冠軍' +
      '讀到中位終局 10.8 秒、每場 8.4 殺、14.5 發一殺 —— 三條驗收線都朝對的方向走、也都還沒到，' +
      '而 120 局裡 38.3% 還在 10 秒內收場；`--mode matrix` 那格更直接：進攻席最大的單一項還是 breach' +
      '（＋40.83／局、發放率 58.3%）、局均 573 幀＝9.6 秒，每局只清掉 3.8 台。' +
      '換句話說，v12 讓「清人」開始有錢，但「不清人也能拿滿 70」那條捷徑還在，' +
      '「先清人再破網」在排序上跟直取老鷹同分、只是更慢 —— 沒有理由選它。' +
      '門檻用 min(1, 擊殺/6) 而不是「要不要打破」：保留稀有事件本身的大獎（不然進攻席的勝負訊號會整個消失，' +
      '那是批次四「分數不動、行為亂跳」那個坑），只把「空手斬首」那一端壓到 0。',
    value: c => (c.winByMerit ? clamp((c.s.kills || 0) / BREACH_KILL_PROOF, 0, 1) : 0),
  },
  {
    key: 'timeoutFail', label: '拖到時間到沒破局', roles: [ROLES.ATTACK], weight: W.timeoutFail,
    formula: '沒贏且本局以「30 秒時鐘到」結束時：(1 − 推進占比) ×（-25）——' +
      '離敵鷹愈近扣愈少（完全沒過半場扣滿 25，貼到城門口幾乎不扣）',
    why: '時鐘對進攻方是懲罰：拖滿就是輸。少了這一項，「在家門前繞圈等時間」' +
      '對早期的進攻網路是零風險策略 —— 它什麼都不用學就能避開卡牆、亂掃射那些負分。' +
      'v10 改成按推進程度打折：ladder 量到「對手強的時候 50% 的局吃 0 分」，' +
      '全額罰款會把「已經會往前開但還沒破網」與「完全躺平」壓成同一個 0，' +
      '而那正是起步階段唯一還剩的排序訊號。',
    value: c => (!c.won && c.rep.timedOut ? 1 - c.penetrationShare : 0),
  },
  {
    key: 'holdWin', label: '守住本局', roles: [ROLES.DEFENSE], weight: W.holdWin,
    formula: '防守方靠自己獲勝：打掉藍隊老鷹＝1（45 分）、只是撐過 30 秒＝0.4（18 分）；藍隊自破不算',
    why: '防守方的勝利條件有兩種，但共同點都是「紅隊老鷹還在」。' +
      '時間到判紅隊贏是使用者定的規則，所以這裡不能把它記成和局或拖平。' +
      'v7：藍隊把自己家打爆也是「規則上紅隊贏」，但那一局紅隊什麼都沒做對，' +
      '把滿分發下去會讓「躲在角落等對方自破」變成最優解。' +
      'v10 把兩種贏法拆開：實測紅隊 44.8% 的在場幀在對方半場，' +
      '原因就是「拖滿時鐘」與「反打對面家」同分 —— 尺既然一樣給，就沒有理由留在家裡。' +
      '分級定在 0.4，是因為「撐過時鐘」那一檔要維持 18 分（基準線不能因為改版就位移，' +
      '否則 rule·rule 的兩席均分差會假裝變大）；代價是把「主動打掉對面老鷹」從 30 抬到 45，' +
      '讓防守席也有一條與 breach（70）同數量級的勝負項 —— 探針實測防守席換上模型只加 14 分、' +
      '進攻席加 97 分，差在「進攻的決定性一擊值 70、防守的決定性一擊只值 30」。' +
      'key 不動、用 value 分級：ai/balance.js 的「holdWin 發放率」要繼續找得到這一項。',
    value: c => (c.winByMerit ? (c.s.foeBaseKilled ? 1 : 0.4) : 0),
  },
  {
    key: 'holdGate', label: '消極門檻', roles: [ROLES.DEFENSE], weight: W.holdGate,
    formula: `贏了才給：min(1, 攔截 hp / 2) × (0.5 ＋ 0.5 × min(1, 門前在場占比 / ${GATE_HOLD_FULL})) × ${W.holdGate}`,
    why: '「要表現出積極性的防守」。撐到時間到就發滿分等於叫防守方躲起來 —— ' +
      '贏是贏，但這 34 分要按「實際上擋了多久、攔掉多少」給。' +
      'v10 改了兩處：① 門檻從 6 hp 降到 2 hp（6 hp 實測只發放 0.23～2.6 分，' +
      '等於是裝飾，真正的贏家幾乎都碰不到）；② 加上「門前在場」的加成 —— 敵人不進來時，' +
      '半場攔截量天生為 0，舊版會把守得最嚴的一局判成消極。' +
      '⚠ 加成是「乘在已攔到傷害的那一半上」，不是各半：48 場實測 rand·rand 的門前占比' +
      '（28.0%）比 rule·rule（14.8%）還高，若允許「只站位、零攔截」換到一半門檻分，' +
      '就把剛剛量出來那個反技能的東西又接回尺裡了。所以沒擋到傷害 ⇒ 這一項 0 分。',
    value: c => {
      if (!c.winByMerit) return 0;
      const held = Math.min(1, c.interceptions / 2);                    // 硬門檻：起碼攔到 2hp
      const present = Math.min(1, c.screenShare / GATE_HOLD_FULL);      // 擋多久，最多補一倍
      return clamp(held * (0.5 + 0.5 * present), 0, 1);
    },
  },
  {
    key: 'ownBaseAlive', label: '自家老鷹還在', roles: both,
    weight: W.ownBaseAlive,
    formula: {
      attack: '結算時藍隊老鷹還在（是＝1／否＝0）（× 6）',
      defense: '結算時紅隊老鷹還在（是＝1／否＝0）（× 14）',
    },
    why: '同一件事在兩個角色上的價值完全不同：防守方「老鷹還在」就是本業，' +
      '進攻方被反破解雖然照規矩算輸，但自家被拆代表它把兵力擺錯了地方，' +
      '扣得比防守方輕、一樣要扣。',
    value: c => (c.s.ownBaseAlive ? 1 : 0),
  },
  {
    key: 'speed', label: '結束得快', roles: both, weight: W.speed,
    formula: {
      attack: `贏的時候：(1 - 局幀 / 上限) × min(1, 擊殺數 / ${SPEED_KILL_PROOF}) × ${W.speed.attack}（v12：權重 20→${W.speed.attack}，且要有殲滅實績）`,
      defense: `靠打掉藍隊老鷹取勝時：同上 × ${W.speed.defense}（v12：12→${W.speed.defense}）；撐到時間到不算「快」`,
    },
    cap: `整局一局打到 ${SPEED_KILL_PROOF} 台才給滿；沒打死人 ⇒ 這一項 0 分`,
    why: '同樣是贏，10 秒破網比 29.9 秒驚險守住好得多 —— 但 v11 之前這條太貴：' +
      'breach(70)＋speed(20) 讓「繞過所有人直取老鷹」成為進攻席的最優解，' +
      '實測雙冠軍對打平均 9.7 秒就收場（中位 8.8 秒），場上 12.8 台的規則 AI 對局是 25.6 秒，' +
      '觀眾看到的是「兩輛車衝過、老鷹爆了」，不是對戰。' +
      'v12 把單價砍到 8／6，再乘上殲滅實績 min(1, 擊殺/' + SPEED_KILL_PROOF + ')：' +
      '要「早收場」照樣加分，但得先把人打死，速決本身不再是一張大獎。' +
      '「實績」的寫法比照 denial 的 DENIAL_PROOF_HP —— 分數要來自自己打出來的東西，' +
      '不是來自對手剛好很弱。v7：對方自破送來的勝利也不算「快」—— 那個時間是它浪費在自己家的。' +
      '⚠ 兩席砍的幅度不同（20→8、12→3 而不是各砍一半）：v10 立了一條不變量 —— ' +
      '兩席「本業上限」的差要 ≤10 分，否則一族天生比另一族有更多可爬的空間，起步就不平衡。' +
      '進攻席這一項被砍掉 12 分，防守席若只砍 6 分，兩席的差就從 6.2 漲到 12.05、破線；' +
      '砍到 3 分讓差回到 9.1。這也符合該項的語意：防守席的 speed 只在它真的打掉藍鷹時才發，' +
      '而紅隊的本業是「守住＋清場」，不是「快」。',
    value: c => (c.winByMerit && !c.rep.timedOut
      ? clamp(1 - c.rep.frames / c.maxFrames, 0, 1) * clamp((c.s.kills || 0) / SPEED_KILL_PROOF, 0, 1)
      : 0),
  },
  {
    key: 'stalemate', label: '跑到保險絲還沒有結果', roles: both, weight: W.stalemate,
    formula: '沒獲勝且局幀碰到無頭引擎上限（是＝1／否＝0）（× -18）',
    why: '規則上一局最多 1890 幀就一定會結束；碰到這個上限代表有東西壞了' +
      '（或兩邊徹底不動）。留這一項是為了讓「訓練跑偏」本身可見，不是用來評分戰術。',
    value: c => (!c.won && c.rep.capped ? 1 : 0),
  },

  /* ══ 進攻方的推進過程（還沒破網時也要有梯度）══════════════ */
  {
    key: 'foeHalf', label: '壓進敵半場', roles: [ROLES.ATTACK], weight: W.foeHalf,
    formula: 'min(1, max(0, (敵半場在場幀占比 - 0.15) / 0.35)) × 14',
    cap: '15% 起算、50% 滿',
    why: '「進攻」必須是可觀察的行為，不能只在破網成功那一下才有分。' +
      '實測規則 AI 對規則 AI：藍隊贏局約 23%，其餘大多是卡在自家半場對射 —— ' +
      '沒有這一項，早期的進攻網路會學成「在家門口等機會」。',
    value: c => clamp((c.foeHalfShare - 0.15) / 0.35, 0, 1),
  },
  {
    key: 'penetration', label: '最接近敵鷹', roles: [ROLES.ATTACK], weight: W.penetration,
    formula: `min(1, max(0, (${HALF_FIELD_PX} - 離敵鷹最近距離 px) / ${HALF_FIELD_PX})) × 10`,
    cap: `貼到敵鷹中心（${HALF_FIELD_PX}px＝半場）為滿分；整局沒有一台車在場給 0`,
    why: '推進到城門口的努力要留痕：就算最後沒打破，「最近到過哪裡」' +
      '比「殺了幾台」更能指出方向正確的基因。',
    value: c => (c.s.foeBaseMinDist === null ? 0
      : clamp((HALF_FIELD_PX - c.s.foeBaseMinDist) / HALF_FIELD_PX, 0, 1)),
  },
  {
    key: 'foeWall', label: '拆掉敵人要塞牆', roles: [ROLES.ATTACK], weight: W.foeWall,
    formula: `min(${WALL_CELL_CAP}, 近距離拆的格數 + ${WALL_FAR_SHARE}×遠距離拆的格數) × ${W.foeWall}`,
    cap: `每局最多算 ${WALL_CELL_CAP} 格；「近距離」＝開火那瞬間離敵鷹 ≤56px（AI_ASSAULT_RADIUS）`,
    why: '老鷹外圍那圈磚是進攻路上唯一的地形障礙，拆牆＝真的在推進。' +
      '封在 8 格是因為牆共 20 格，全拆完只是把「拆」變成刷分項目；' +
      '真正的結算還在 breach 那 70 分。' +
      'v11 把同一格分兩種價：使用者的攻擊順序是「先打敵車，接近主堡才打主堡」，' +
      '而 v10 之前的尺只看「少了幾格」，站在自家門口隔空啃牆跟貼到牆腳拆一樣值 5 分／格 ——' +
      '等於用分數把剛改掉的舊行為留住。現在遠距離的只給 ' + WALL_FAR_SHARE + ' 倍，' +
      '歸因用子彈自己記的開火點（js/entities.js 的 fireX／fireY），不是撞牆那幀的車位：' +
      '子彈 8px/幀、飛到對面 20 幀以上，那 40px 漂移跟 56px 的門檻同一個等級。',
    value: c => clamp((c.s.foeWallNear || 0) + WALL_FAR_SHARE * (c.s.foeWallFar || 0), 0, WALL_CELL_CAP),
  },
  {
    key: 'besiege', label: '包圍敵鷹', roles: [ROLES.ATTACK], weight: W.besiege,
    formula: `min(1, 敵鷹 56px 圈內的在場幀占比 / ${BESIEGE_FULL}) × 30`,
    cap: `在場幀的 ${BESIEGE_FULL * 100}% 貼在門口就是滿分`,
    why: 'v10 新增，因為舊尺裡「推進」只有兩種訊號：稀有事件（breach 發放率 39.6%）' +
      '與一次性距離（penetration 只看最近到過哪裡，實測中位 50.6px、拿 6.11 分就不會再漲）。' +
      '起步階段絕大多數個體既沒破網也沒到門口，那兩項全是 0 —— 方向盤只能靠亂開槍。' +
      '「在敵鷹門口待了多久」每局都按比例發放，而且只有一直壓著才拿得到，' +
      '擦過一眼不算。半徑沿用 arena 的家門口定義（BASE_DEFENSE_RADIUS 56px），' +
      '與防守端的「門前在場」量同一把尺（那兩族的占比才可比）——' +
      '不過同一把尺在紅隊那邊不能當一項分數用，理由見下面 denial 之後的刪除記錄。',
    value: c => clamp((c.s.besiegeFrames || 0) / Math.max(1, c.s.fieldFrames) / BESIEGE_FULL, 0, 1),
  },

  /* ══ 防守方的成果 ═══════════════════════════════════════ */
  {
    key: 'defense', label: '家門口攔截', roles: [ROLES.DEFENSE], weight: W.defense,
    formula: `min(${GATE_HP_FULL}, 敵車在自家老鷹 56px 內挨的傷害) × ${W.defense}`,
    cap: `每局最多算 ${GATE_HP_FULL} hp（v10 由 6 壓到 ${GATE_HP_FULL}：實測規則 AI 只有 0.5hp，6hp 那個天花板摸不到）`,
    why: '擊殺／傷害只獎勵「打到人」，不區分在哪裡打的。把家門口的傷害獨立計分，' +
      '「會回防」才會有自己的梯度，而不是被中場對射的數字蓋掉。' +
      'v10 同時把單位價從 5 抬到 7、封頂從 6hp 壓到 5hp：總量從 30 抬到 35，' +
      '但「滿分所需的那口氣」從摸不到的 6hp 變成量得到的 5hp，基準線（0.5hp）的占比' +
      '也從 9% 抬到 15% —— 起步階段要的是「往前一檔就有反應」，不是一張大獎。' +
      '35 這個數也是把防守本業上限（196）補到與進攻（190）同高的其中一塊：' +
      '兩席的「換上自己模型的加分」差到 4.8×，一半原因是防守那側根本沒那麼多空間可爬。',
    value: c => clamp(c.s.baseDefenseDamage || 0, 0, GATE_HP_FULL),
  },
  {
    key: 'halfDefense', label: '半場攔截', roles: [ROLES.DEFENSE], weight: W.halfDefense,
    formula: `min(${HALF_HP_FULL}, 敵車在自家半場（老鷹 56px 外）挨的傷害) × ${W.halfDefense}`,
    cap: `每局最多算 ${HALF_HP_FULL} hp（v10 由 8 壓到 ${HALF_HP_FULL}、單位價 2.5→${W.halfDefense}）`,
    why: '「打擊對方坦克也是防守的方式」：敵車一踏進自家半場就開始消耗，' +
      '等於在城門外先拆掉攻勢。家門口那段已算在上一項，兩區間互斥、不重複計價；' +
      '離家愈遠，同樣的傷害對保命愈間接，所以單位價較低。' +
      'v10 的 2.5→4／8hp→6hp 與上一項同一個理由：把滿分搬到量得到的距離上。',
    value: c => clamp(c.s.halfDefenseDamage || 0, 0, HALF_HP_FULL),
  },
  {
    key: 'denial', label: '拒止（把敵人擋在外面）', roles: [ROLES.DEFENSE], weight: W.denial,
    formula: `min(1, max(0, (${DENIAL_ZERO} - 敵隊壓進自家半場的占比) / ${(DENIAL_ZERO - DENIAL_FULL).toFixed(2)}))` +
      ` × min(1, 自家半場攔截 hp / ${DENIAL_PROOF_HP}) × ${W.denial}`,
    cap: `敵隊 ${(DENIAL_ZERO * 100).toFixed(0)}% 在場幀在自家半場 ⇒ 0 分；壓到 ${(DENIAL_FULL * 100).toFixed(0)}% 以下 ⇒ 上限；` +
      `自己沒在自家半場攔到 ${DENIAL_PROOF_HP}hp 之前，這一項最多只給到那個比例`,
    why: 'v10 新增，補掉 defense／halfDefense 的共同漏洞：那兩項都要「敵人在我家門口挨打」' +
      '才發分，藍隊不進來的話紅隊就算守得滴水不漏也是 0 分 —— 探針實測防守尺的本業占比只有 0.7%，' +
      '紅隊因此跑出去打架（44.8% 的幀在對方半場）。這一項量的是「對方進來多少」，' +
      '直接對應使用者要的「各自防守」，而且每一局都有數值、不靠稀有事件。' +
      '計量沿用 ai/arena.js 的 foeHalfFrames（藍隊視角），所以紅隊不需要新的逐幀計數。' +
      '⚠ 但它天生有免單問題：分數來自對手的弱，不是自己的行為 —— 第一版實測 rand·rand 的' +
      '防守席直接拿滿 25（藍隊隨機按鍵 48 場壓進紅半場的占比中位 0.000，根本沒想過要進來）。' +
      '所以乘上「自家攔截實績」這個閘：要這個「他們進不來」算成紅隊的功，紅隊至少得在半場內' +
      `打掉 ${DENIAL_PROOF_HP} hp；否則那是藍隊不會開車，不是紅隊擋得住。`,
    value: c => clamp((DENIAL_ZERO - c.foePenetrationShare) / (DENIAL_ZERO - DENIAL_FULL), 0, 1) *
      clamp(c.interceptions / DENIAL_PROOF_HP, 0, 1),
  },

  /* v10 原本在這裡還有一項 screenHold（門前在場 20 分），落地量測後刪掉了，
     記錄留在這裡：把 screenFrames 改成「只算老鷹靠敵那一側」之後，
     rand·rand 的門前占比中位 0.280、rule·rule 只有 0.148、換上 v9 防守冠軍更掉到
     0.074 —— 愈會玩反而愈低。這代表「在門口待多久」本質上是用「存在」當分數，
     隨機亂晃（被牆與老鷹圈困住）就能吃滿，方向還跟紀律項相反。
     占比這個訊號並沒有丟：holdGate 仍拿它一半權重（贏了才算，
     所以「在家門口混時間」換不到分），denial 則改吃攔截實績。 */

  /* ══ 兩套標準都保留的戰鬥項目 ═══════════════════════════ */
  {
    key: 'teamwork', label: '協同壓制', roles: both, weight: W.teamwork,
    formula: 'min(1, max(0, (兩台以上友車壓同一台敵車的幀占比 - 0.10) / 0.15)) × 6',
    cap: '10% 起算、25% 滿',
    why: '一台一台單打也能贏，但「兩台壓同一個目標」是這遊戲裡唯一可穩定觀測的合作行為。' +
      '規則 AI 互打的 baseline 約 3%～13%，10% 以下不給分，避免把「路過同框」算成合作。' +
      '這是加分項，懲罰不了喜歡單打的個體。v10 從 10 降到 6：它是兩邊都算的通用項，' +
      '不該比席位本業還貴。',
    value: c => clamp(((c.s.supportFrames || 0) / Math.max(1, c.s.fieldFrames) - 0.10) / 0.15, 0, 1),
  },
  {
    key: 'killPer1k', label: '擊殺效率', roles: both, weight: W.killPer1k,
    formula: `min(24, 擊殺數 / 在場幀 × 1000) × ${W.killPer1k}`,
    cap: '每 1000 在場幀 24 殺封頂',
    why: '流量型計量一律逐幀歸一化：短局長局才可比，也不會因為活得久而刷分。' +
      'v10 把這條的天花板從 360 壓到 108（4.5 × 24）：實測 rule·rule 的進攻尺有 608 分' +
      '來自「在哪邊都能做的事」，而 breach 只有 70 —— 只學到「亂開槍也能高分」的族群' +
      '沒有理由去壓老鷹。v12 再壓到 72（3.0 × 24）：這一次不是它太貴，是它跟新加的 ' +
      'annihilation（每場總擊殺，封頂 48）是同一件事的兩種量法，' +
      '而流量那一種有已證實的漏洞 —— 把一局縮到 9 秒，分子分母一起縮小，比例照樣拿滿。' +
      '所以「打死人」的錢改由總量項發，流量項留著當早期的密集梯度（不是刪掉）。',
    value: c => clamp(c.per1k(c.s.kills), 0, 24),
  },
  {
    key: 'annihilation', label: '殲滅（每場打死幾台）', roles: both, weight: W.annihilation,
    formula: `min(${ANNIHILATION_CAP}, 擊殺數) × ${W.annihilation}`,
    cap: `每局最多算 ${ANNIHILATION_CAP} 台（v14：8→6，單價 6→8，總量仍是 48）`,
    why: 'v12 新增，補的是 killPer1k／damagePer1k 共同的洞：那兩項是「每 1000 在場幀」的流量計量，' +
      '把一局打得愈短、分子分母就一起縮小，比例照樣漂亮 —— ' +
      '實測雙冠軍對打 9.7 秒收場、每場 5.9 殺，同一份考題的規則 AI 打 25.6 秒、每場 12.8 殺，' +
      '但舊尺看不出這個差別。使用者要的是「激烈」，而激烈的定義是「場上有人在死」，' +
      '不是「每秒死很多但整局沒死幾個」。這一項不隨時長打折：收了幾台就是幾台。' +
      '封在 8 台跟 duelKill（封 4）、foeWall（封 8）同一個理由：不封頂會開出' +
      '「只清人不推進」的刷分路線，而且 8 台之後讓 breach(70) 繼續當進攻席最大的單項 —— ' +
      'v12 要改的是「早收場 vs 打死人」的相對價，不是把勝負項換掉。' +
      '⚠ 這一項是「換掉」不是「加在上面」：同時把 killPer1k 4.5→3.0（−36）、' +
      'damagePer1k 1.5→1.0（−12），通用交戰軸的天花板總量維持在 v11 的 242 分，' +
      '否則尺的總量會自己長出 48 分，v10 那條「本業佔天花板 ≥40%」的驗收被新增項稀釋掉，' +
      '而那是起步平衡度的來源（ai/balance.js --mode ceiling 每一版都要重新對一次）。' +
      'v14 動的是同一筆預算內的分配（封頂 8→6、單價 6→8，48 不變）：`node measure-termsigma.js` 量到' +
      '族群每隊只打 3.4 台，封在 8 時每台的邊際價只有 6 分、且離封頂很遠（踩滿率 17%）——' +
      '把封頂收到 6（正好是 breach 的實績門檻）讓「多殺一台」在真正住著的區間值 8 分而不是 6 分。' +
      '⚠ 先否掉一個看起來更自由的錯動法：封頂 8→12、單價 6→4（同樣 48 不變）在 0～6 殺那段把梯度**變緩**，' +
      '等於什麼都沒換到；要抬梯度只能往封頂低於現況的方向收。',
    value: c => clamp(c.s.kills || 0, 0, ANNIHILATION_CAP),
  },
  {
    key: 'duelKill', label: '貼身殲滅', roles: both, weight: W.duelKill,
    formula: 'min(4, 在貼身距離（中心距 < AI_DUEL_RADIUS）內打掉的敵車數) × 6',
    cap: '每局最多算 4 台',
    why: '使用者規則（v7）：紅藍的坦克太接近時，目標要先變成「解決對方坦克」。' +
      '規則 AI 那一層已經硬性改掉了（js/ai.js 的 _goal 把它排在第一優先），' +
      '但網路不會因為規則改寫就自己懂 —— 它只認適應度。把「近身接戰還收掉人」' +
      '從普通擊殺裡單獨拎出來，否則遠距離偷一槍和貼身解決一台敵車同分，' +
      '沒有理由靠近。封在 4 台：一局總擊殺常常不到 8 台，不封頂會讓單項吃滿整張表。',
    value: c => clamp(c.s.duelKills || 0, 0, 4),
  },
  {
    key: 'damagePer1k', label: '傷害輸出', roles: both, weight: W.damagePer1k,
    formula: `min(24, 造成傷害 / 在場幀 × 1000) × ${W.damagePer1k}`,
    why: '對重型車（4 hp）與磚牆的消耗都算實質貢獻，權重比直接擊殺低。' +
      'v10 的天花板由 100 壓到 36，理由同擊殺效率：通用項不能比本業貴。' +
      'v12 再壓到 24（1.5→1.0）—— 跟 killPer1k 同一個理由（流量會被短局稀釋），' +
      '也同一個目的：給 annihilation 那 48 分騰出預算，' +
      '「不問角色的戰鬥項」合計天花板維持在 v11 的 242，不要因為加了新項就把本業比例稀释掉。',
    value: c => clamp(c.per1k(c.s.damageDone), 0, 24),
  },
  {
    key: 'accuracy', label: '射擊效率（每 1 殺發數）', roles: both, weight: W.accuracy,
    formula: `每 1 殺發數從 ${ACCURACY_SPK_ZERO}（＝0 分）到 ${ACCURACY_SPK_FULL}（＝滿分）的線性斜坡 × ${W.accuracy}`,
    cap: `${ACCURACY_SPK_ZERO} 發以上不給分、${ACCURACY_SPK_FULL} 發以下給滿（滿分 ${ACCURACY_MONEY}，與 v12 的 0.8hp×10 同額）`,
    why: '反刷分的第一道閘：狂按射擊不會增加這一項，只會稀釋它。' +
      '⚠ v14 換的是**口徑**，不是單價：v12 那版寫的是「min(0.8hp, 造成傷害／開火數) × 10」，' +
      '而 `node measure-termsigma.js 24` 在段邊界那格量到它每場只發到 0.82（藍）／0.75（紅）分、σ 0.39／0.36、踩滿率 0% —— ' +
      '原因是 0.8hp/發那道封頂要「每發推掉五分之一台車」才摸得到，而現任冠軍 15～17 發才換一台，' +
      '所有人都貼著 0；**大家都 0 的項在選擇上等於沒有項**（跟「大家都踩滿」同罪，v13 驗收那節記著）。' +
      '新口徑直接讀「每 1 殺發數」：' + ACCURACY_SPK_ZERO + ' 發＝0、' + ACCURACY_SPK_FULL + ' 發＝滿，' +
      '斜坡正好蓋住現況（17.2）與驗收線（≤8），所以「把每殺耗彈壓下來」這一次是有梯度的。' +
      '權重 10→8 是為了守住「改值不改頂」：滿分金額維持 ' + ACCURACY_MONEY + ' 分，通用交戰軸的 242 一分不動。' +
      '⚠ 一開槍都沒有（shots＝0）算 0 分，不能讓「不打」被當成「打得準」。',
    value: c => {
      const shots = c.s.shots || 0, kills = c.s.kills || 0;
      if (shots <= 0) return 0;
      const spk = shots / Math.max(1, kills);
      return clamp((ACCURACY_SPK_ZERO - spk) / (ACCURACY_SPK_ZERO - ACCURACY_SPK_FULL), 0, 1);
    },
  },
  {
    key: 'powerup', label: '撿到道具', roles: both, weight: W.powerup,
    formula: 'min(12, 道具數 / 在場幀 × 1000) × 2',
    why: '肯移動去吃場上資源的個體，比守在角落的好；分給小一點即可。',
    value: c => clamp(c.per1k(c.s.powerups), 0, 12),
  },
  {
    key: 'firepowerUp', label: '升到火力 L3/L4', roles: both, weight: W.firepowerUp,
    formula: 'min(12, 升級次數 / 在場幀 × 1000) × 3',
    why: '比「撿到道具」更值錢：要持續交戰才拿得到，也直接換到輸出能力。',
    value: c => clamp(c.per1k(c.s.firepowerUp), 0, 12),
  },
  {
    key: 'death', label: '損失一台車', roles: both, weight: W.death,
    formula: '陣亡數 ×（-4）',
    why: '送頭要扣，但一輪 20 台本來就會打完，所以扣得比擊殺分小（-4 vs +4.5/每 1000 幀 1 殺）。',
    value: c => c.s.deaths || 0,
  },
  {
    key: 'ownBaseCellLost', label: '自家要塞牆被削', roles: both, weight: W.ownBaseCellLost,
    formula: '自家老鷹周圍磚環少了幾格 ×（-3）',
    why: '家門口破了但老鷹還活著時也要扣分，否則「僥倖守住」跟「完好守住」同分。',
    value: c => c.s.ownBaseCellsLost || 0,
  },
  {
    key: 'selfBaseShot', label: '開槍打到自己要塞', roles: both, weight: W.selfBaseShot,
    formula: '開火當下彈道會命中自家老鷹或自家要塞牆的子彈數 ×（-7）',
    why: '使用者規則：自己人要避開對自己要塞的開火 —— 除非算過彈道確定碰不到要塞與要塞牆。' +
      '這一項用「開火的當下」判定（不是結算時的牆面缺口，那個大半是敵人造成的），' +
      '反射層已經會攔掉這種槍，留著負分是要網路自己也知道那不是好選擇。',
    value: c => c.s.selfBaseShots || 0,
  },
  {
    key: 'ownEagleBySelf', label: '自己打爆自家老鷹', roles: both, weight: W.ownEagleBySelf,
    formula: '自家老鷹是被自己人打爆的（是＝1／否＝0）×（-80）',
    why: '使用者規則（v7）：「自己人把自己的老鷹打死，要記錄，然後列入訓練標準」。' +
      'selfBaseShot 罰的是「開槍時彈道指向自家要塞」這個念頭，這一款罰的是真的把家打爆這件事。' +
      '兩項都要：前者讓網路學會收手，後者保證就算收手失敗（流彈、隊友失手）' +
      '這種個體也永遠選不上 —— 權重刻意比 breach（70）還大，' +
      '因為「把自家打爆」對這遊戲的勝負是決定性的，跟拆掉敵鷹同等嚴重，只差符號。' +
      '兇手只在 js/map.js 明確記下（base.killedBy）時才算自破；推測的一律不算。',
    value: c => (c.s.ownBaseKilledBySelf ? 1 : 0),
  },
  {
    key: 'wallPin', label: '卡牆比例過高', roles: both, weight: W.wallPin,
    formula: 'min(1, max(0, (卡牆幀比例 - 0.20) / 0.40)) ×（-40）',
    cap: '>20% 起扣、60% 扣滿',
    gate: '只對「真的由網路開車」的隊伍生效',
    why: '第 50 代冠軍的教訓：勝率 75%、控制權 100%，但 55% 的在場幀頂在牆上動不了。' +
      '只看結論的適應度對這種退化完全無感。',
    value: c => (c.hasPolicy ? clamp((c.blockedShare - 0.20) / 0.40, 0, 1) : 0),
  },
  {
    key: 'monotony', label: '動作單一', roles: both, weight: W.monotony,
    formula: 'min(1, max(0, (最常用的動作佔比 - 0.60) / 0.40)) ×（-35）',
    cap: '>60% 起扣、100% 扣滿',
    gate: '只對「真的由網路開車」的隊伍生效',
    why: '同一個鍵打天下（實測過 92% 決策是射擊）沒有學到機動，必須計負分。',
    value: c => (c.hasPolicy ? clamp(((c.s.dominance || 0) - 0.60) / 0.40, 0, 1) : 0),
  },
  {
    key: 'spray', label: '大量無效彈', roles: both, weight: W.spray,
    formula: `開火 >${SPRAY_SHOTS_MIN} 發時，每 1 殺發數從 ${ACCURACY_SPK_ZERO}（＝不罰）到 ${SPRAY_SPK_MAX}（＝罰滿）的線性斜坡 × ${W.spray}`,
    gate: '只對「真的由網路開車」、且開火超過 ' + SPRAY_SHOTS_MIN + ' 發的隊伍生效',
    why: '彈雨即使偶爾命中也不該被獎勵；這一項跟 accuracy 一起把「一直按射鍵」壓住。' +
      '⚠ v14 動的是**門檻的口徑**：舊寫法是「每場 >30 發且每發 <0.25hp ⇒ 直接罰滿」，' +
      '而 `node measure-termsigma.js 24`（段邊界那格）量到防守席每場開火 105～118 發，' +
      '每一局都越過 30 這道檻、每一局都踩在 −28.75／−30 的頂上（踩滿率 96%、σ 6.0）—— ' +
      '**每局都罰滿的懲罰項跟根本沒有這一項是一樣的**，它不再挑出任何東西，只是把所有防守個體一起往下搬。' +
      '新寫法把它接在 accuracy 那條斜坡的右邊：每 1 殺 ' + ACCURACY_SPK_ZERO + ' 發起罰、' +
      SPRAY_SPK_MAX + ' 發罰滿（−30 單價不變，所以天花板跟 v12 同形），' +
      '兩段接起來不重疊：6～20 發那段由 accuracy 給「獎勵」，20 發以上那段由 spray 給「罰」，' +
      '同一局不會因為同一件事被處兩次。' +
      '30 發那道「樣本要夠大才判」的老規矩保留（v6 以來就是它，跟 SPK 口徑不衝突）。' +
      'v12 那一版把單價從 -12 抬到 ' + W.spray + ' 是必要的：舊價下「一直按射鍵」幾乎是免費的' +
      '（-12 相對 breach 的 70 只是零頭），觀眾看到的「不激烈」就是螢幕上全是子彈、場上沒人倒下。',
    value: c => {
      if (!c.hasPolicy || !(c.s.shots > SPRAY_SHOTS_MIN)) return 0;
      const spk = c.s.shots / Math.max(1, c.s.kills || 0);
      return clamp((spk - ACCURACY_SPK_ZERO) / (SPRAY_SPK_MAX - ACCURACY_SPK_ZERO), 0, 1);
    },
  },
];

/** 某個角色實際要用的項次（履歷網頁與訓練端讀同一份） */
function termsFor(role) { return TERMS.filter(t => t.roles.includes(role)); }
function weightOf(t, role) { return typeof t.weight === 'object' ? t.weight[role] : t.weight; }
function formulaOf(t, role) { return typeof t.formula === 'object' ? t.formula[role] : t.formula; }

/** 一隊 + 一局 → 逐項明細（分數與說明出自同一支碼） */
function scoreOf(s, rep, teamId, cfg = {}) {
  const role = cfg.role || roleOfTeam(teamId);
  const maxFrames = cfg.maxFrames || 2400;      // v6：一局規則上最多 1890 幀
  const per1k = v => (v / Math.max(1, s.fieldFrames)) * 1000;
  const blockedShare = s.fieldFrames ? (s.blockedFrames || 0) / s.fieldFrames : 0;
  const hasPolicy = (s.actN || 0) > 0;          // 純規則 AI 的隊伍不該被過程懲罰誤傷
  const ctx = {
    s, rep, teamId, role, maxFrames, per1k, blockedShare, hasPolicy,
    won: rep.winner === teamId,
    // v7：犯錯／得利判定（計量來自 ai/arena.js 讀 js/map.js 記的 base.killedBy）
    ownGoal: !!s.ownBaseKilledBySelf,
    // 對手自己把家打爆 → 規則上我們贏了，但這個勝利不是我們打出來的。
    // 勝負那幾項一律改讀 winByMerit，否則「等對方自破」會變成兩邊共同的最低努力解。
    winByMerit: rep.winner === teamId && !s.foeBaseOwnGoal,
    foeOwnGoal: !!s.foeBaseOwnGoal,
    foeHalfShare: s.fieldFrames ? (s.foeHalfFrames || 0) / s.fieldFrames : 0,
    // v10：三項新本業項要讀的三個占比（全部由 ai/arena.js 逐幀計量，不看結論）。
    //   penetrationShare    ＝ penetration 那一項的 0..1 值；timeoutFail 用它把罰款打折。
    //   screenShare         ＝ 自家車在自己要塞門口的在場幀占比（防守本業）。
    //   foePenetrationShare ＝ 對手壓進「我家」半場的占比（拒止看的正是這個）。
    penetrationShare: s.foeBaseMinDist === null || s.foeBaseMinDist === Infinity ? 0
      : clamp((HALF_FIELD_PX - s.foeBaseMinDist) / HALF_FIELD_PX, 0, 1),
    screenShare: s.fieldFrames ? (s.screenFrames || 0) / s.fieldFrames : 0,
    foePenetrationShare: (() => {
      const opp = rep && rep.teams ? rep.teams[1 - teamId] : null;
      return opp && opp.fieldFrames ? (opp.foeHalfFrames || 0) / opp.fieldFrames : 0;
    })(),
    // 攔截總量：家門口 + 半場。防守方的「消極門檻」與地板規則都讀它。
    interceptions: (s.baseDefenseDamage || 0) + (s.halfDefenseDamage || 0),
  };

  const rows = termsFor(role).map(t => {
    const value = t.value(ctx);
    const weight = weightOf(t, role);
    return {
      key: t.key, label: t.label, weight, roles: t.roles,
      formula: formulaOf(t, role), cap: t.cap || null, gate: t.gate || null, why: t.why,
      value, contribution: value * weight,
    };
  });

  const out = {
    role, roleLabel: ROLE_LABEL[role],
    won: ctx.won, hasPolicy, blockedShare, maxFrames,
    ownGoal: ctx.ownGoal, foeOwnGoal: ctx.foeOwnGoal, winByMerit: ctx.winByMerit,
    rows, sum: rows.reduce((a, r) => a + r.contribution, 0),
    floors: [],
  };

  let f = out.sum;

  // 完全沒動靜（整局躺平）直接歸零，不給「守著不做事」的局部最優
  const idle = s.fieldFrames < 60 ||
    (s.dominance !== null && s.dominance > 0.985 && s.kills === 0) ||
    (hasPolicy && blockedShare > 0.60 && s.kills === 0);
  if (idle) { out.floors.push({ label: '整局躺平 → 分數封頂 0', from: f, to: Math.min(f, 0) }); f = Math.min(f, 0); }

  // 自家老鷹被毀 = 這局輸了（兩個角色的終局條件都含這一條），
  // 它的分數永遠不準高於「守住老鷹」的固定分 —— 封頂而不是歸零：
  // 早期基因組個個被拆家，全部變 0 分就沒有選壓、演化停滯。
  if (!s.ownBaseAlive) {
    const aliveWeight = weightOf(TERMS.find(t => t.key === 'ownBaseAlive'), role);
    const cap = aliveWeight - 4;
    if (f > cap) { out.floors.push({ label: `自家老鷹被毀 → 封頂 ${cap}（守住老鷹的固定分之下）`, from: f, to: cap }); f = cap; }
  }

  if (f < 0) out.floors.push({ label: '負分不記錄 → 下限 0', from: f, to: 0 });
  out.final = Math.max(0, f);
  // v7 最後一道地板：把自己家老鷹打爆的個體，這局一律記 0 分。
  // 使用者要的是「避免自己殺自己」，而 0 分在選擇時等於淘汰。
  // 之所以放在加總之後（而不是只靠 ownEagleBySelf 那 −80）：其它項有可能把它蓋過去 ——
  // 例如同一局還順帶破網成功（+70）加上早結束（+speed），淨值又變正的，
  // 那種「打爆自己家但順便贏了」的個體如果還有分，等於告訴網路這件事可以接受。
  if (ctx.ownGoal) {
    out.floors.push({ label: '自己打爆自家老鷹 → 本局分數歸 0（使用者規則）', from: f, to: 0 });
    out.final = 0;
  }
  return out;
}

/** 履歷／網頁用的逐項拆解（跟 teamFitness 同一支碼，不會各說各話） */
function explainFitness(s, rep, teamId, cfg) {
  const out = scoreOf(s, rep, teamId, cfg);
  return {
    total: out.final, sum: out.sum, won: out.won, role: out.role, roleLabel: out.roleLabel,
    hasPolicy: out.hasPolicy, blockedShare: out.blockedShare,
    ownGoal: out.ownGoal, foeOwnGoal: out.foeOwnGoal, winByMerit: out.winByMerit,
    items: out.rows.filter(r => r.contribution !== 0),
    allItems: out.rows,
    floors: out.floors,
  };
}

/**
 * 單座位評估：一個基因組只坐它自己的角色席，對手是另一個角色目前的冠軍。
 * ═══════════════════════════════════════════════════════════
 * v5 以前是「同一個 policy 藍紅各坐一次取平均」，用來消掉殘留的座位偏置。
 * v6 起座位有意義了：藍＝進攻、紅＝防守，同一隻網路不可能同時是兩種角色，
 * 取平均等於用另一種工作的成績稀釋本工作的成績 ——
 * 一個滿分防守者會被「它進攻時很爛」拉低，反之亦然。
 * 所以改成固定席位，偏置的風險交給「考題＝多地圖 × 多種子」分攤，
 * 兩個模型也各自有各自的族群與 checkpoint（見 ai/evolve.js --role）。
 */
function evaluatePolicy(arena, policy, o) {
  const role = o.role || roleOfTeam(o.team ?? ATTACK_TEAM);
  const cfg = { maxFrames: o.maxFrames || 2400, role };
  const opp = o.opponent === undefined ? 'rule' : o.opponent;
  const isAttack = role === ROLES.ATTACK;
  const teamId = isAttack ? 0 : 1;
  const rep = arena.run({
    stage: o.stage, seed: o.seed,
    blue: isAttack ? policy : opp,
    red: isAttack ? opp : policy,
  });
  // 一局回傳兩個數：score 是「地板之後」的成績（訓練與看板顯示用的那把尺），
  // raw 是地板之前的加總。raw 只拿來當「同分時的排序次鍵」，不進任何分數畫面。
  //   為什麼需要它：早期基因組動不動被「躺平 → 0」或「負分 → 0」壓成同一個 0，
  //   0 和 0 之間沒有順序，選擇就變成抽籤 —— 探針量到藍族 8 場考題有 50% 是 0 分，
  //   等於一半的世代對進攻族完全沒有壓力。留著 raw 才能在「都還沒開分」的世代裡
  //   繼續認得出「誰離開分比較近」，而完全不用動 final 的語意（不升版、不需重評）。
  const out = scoreOf(rep.teams[teamId], rep, teamId, cfg);
  return {
    score: out.final,
    raw: out.sum,
    rep, role, teamId,
  };
}

function teamFitness(s, rep, teamId, cfg) { return scoreOf(s, rep, teamId, cfg).final; }

module.exports = {
  teamFitness, evaluatePolicy, explainFitness, scoreOf,
  TERMS, termsFor, weightOf, formulaOf, WEIGHTS: W,
  ROLES, ROLE_LABEL, roleOfTeam, ATTACK_TEAM, SCORING_VERSION, SCORING_VERSION_NOTE,
  HALF_FIELD_PX, BESIEGE_FULL, GATE_HOLD_FULL, DENIAL_ZERO, DENIAL_FULL, DENIAL_PROOF_HP,
  GATE_HP_FULL, HALF_HP_FULL,
  // v11 拆牆的兩個尺：顯示端（ai/ledger.js、ledger.html）與測試要把算式寫成同一個數，
  // 不能在別處再打一次 8／0.25 —— 改了這裡卻沒改那邊，履歷就跟實際計分對不上。
  WALL_CELL_CAP, WALL_FAR_SHARE,
  // v12 激烈度的尺＋v14 的兩把新尺，同一個理由從這裡出口（測試與看板都讀它，不各打一份）。
  // ⚠ v14 起 ACCURACY_HP_CAP／SPRAY_HP_MAX 這兩把「每發平均傷害」的尺已經拿掉了：
  //   它們在族群裡各退化成「大家都 0」與「大家都踩滿」，詳見 SCORING_VERSION_NOTE 與 §5.10.7。
  ANNIHILATION_CAP, SPEED_KILL_PROOF, SPRAY_SHOTS_MIN,
  ACCURACY_SPK_ZERO, ACCURACY_SPK_FULL, ACCURACY_MONEY, SPRAY_SPK_MAX,
  // v13（批次七）：破局的殲滅實績門檻，同一條紀律 —— 測試與履歷都從這裡取 6。
  BREACH_KILL_PROOF,
};
