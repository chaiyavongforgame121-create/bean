# 🌱 Bean Garden — ราคาจริง · เทรดกระดาษ

Bean Garden เป็นเกมฟาร์มบนเกาะลอยฟ้าแบบ 3 มิติ (three.js) ที่สร้างขึ้นใหม่ตามแบบ **"Bean Garden" ของ brood**
ทั้งตัวเกมและ backend ในตัว ต้นไม้แต่ละต้นคือ bot เทรดกระดาษหนึ่งตัวที่ใช้**ราคาจริง**จากตลาด Hyperliquid

- สัญญาของงานฝั่ง 3 มิติคือ [`GAME-DESIGN.md`](GAME-DESIGN.md) (ชนะ SPEC ในทุกเรื่องที่ระบุไว้)
- สัญญาของ backend และ API เดิมคือ [`SPEC.md`](SPEC.md) (เอกสารศึกษาระบบต้นฉบับเก็บไว้ในเครื่องผู้พัฒนาเท่านั้น
  ไม่อยู่ใน repo สาธารณะนี้)
- สัญญาของการอัปเกรดแพลตฟอร์ม (บัญชีผู้เล่น, หลายผู้เล่น, order บน Hyperliquid **TESTNET**) คือ [`PLATFORM.md`](PLATFORM.md)
  ซึ่งชนะเอกสารอื่นในทุกเรื่องที่ระบุไว้
- โค้ดทั้งหมดเขียนใหม่ ไม่ได้คัดลอกโค้ดของต้นฉบับ ส่วนชื่อ op, พารามิเตอร์ และรูปร่างของ response ใช้ตามแบบ brood
  เฉพาะส่วนที่ garden ต้องใช้

> **ราคาจริง · เทรดกระดาษ — ไม่มีเงินจริง**
> - ราคามาจาก Hyperliquid public info API แบบ**อ่านอย่างเดียว** (`POST https://api.hyperliquid.xyz/info`:
>   `allMids`, `metaAndAssetCtxs`, `candleSnapshot`) ไม่มี key ไม่มีการเซ็น ไม่มี endpoint ส่ง order และไม่มีโค้ดที่ส่ง order ได้
> - การเทรดทั้งหมดเป็น **paper fill** ใน exchange จำลองของเราเอง (`mode: "sim"`) ที่ราคาจริงล่าสุด
> - ป้าย **REAL PRICES · PAPER TRADES** อยู่บนจอตลอดเวลาและซ่อนไม่ได้ ถ้าใช้ราคาจำลอง (`--feed sim`) ป้ายจะเป็น
>   **SIMULATED PRICES · PAPER TRADES** สีม่วง
> - ถ้า Hyperliquid ไม่ตอบ ระบบ**ไม่สร้างราคาขึ้นเอง**: bar และการเทรดจะรอ แล้วเล่นนาทีที่พลาดย้อนให้เมื่อราคากลับมา
> - **โหมดผู้เล่นหลายคน (`--auth accounts`)** เปิดให้สมัครและเข้าสู่ระบบได้ ผู้เล่นแต่ละคนมีสวนส่วนตัว และ (ถ้าเปิดไว้)
>   เชื่อม API wallet ของ **Hyperliquid TESTNET** เพื่อส่ง order จริง**บน testnet** ได้ ซึ่งใช้**เงินทดสอบ (test funds)
>   ไม่ใช่เงินจริง**: เงินทดสอบมาจาก faucet ของ Hyperliquid ที่จ่ายให้**เฉพาะ address ที่เคยฝากเงินบน mainnet ด้วย address
>   เดียวกัน**เท่านั้น (ดู[เงินทดสอบ](#เงินทดสอบ-test-funds-และ-testnet)) testnet จึงเป็นทางเลือก เกมกระดาษเล่นได้ครบโดยไม่ต้องใช้
> - **ส่ง order บน mainnet ไม่ได้โดยโครงสร้าง:** ในโค้ดมี URL `/exchange` เพียงตัวเดียวคือของ testnet ที่ถูกตรึงไว้,
>   ตัวเซ็นเซ็นได้เฉพาะ testnet และ egress guard ของ process อนุญาตเฉพาะ 3 URL (`/info` ของ mainnet และ testnet,
>   `/exchange` ของ testnet) โหมด `--auth none` (ค่าเริ่มต้น) ไม่มีบัญชี ไม่มี testnet และทำงานเหมือนเดิมทุกอย่าง

วิธีเล่นโดยสรุป:

- ในระบบมี **bean** 3000 ตัว เป็นกลยุทธ์เทรดกระดาษ แต่ละตัวมีเงินตั้งต้น $1000 และตัดสินใจทุก bar 1 นาที
- ผู้เล่นเลือก "ซองเมล็ด" (bean ที่ผลงานดีจากแผงเมล็ด) แล้ว "ปลูก" ลงกระบะ ระบบจะสร้าง **bot** ที่ mirror สถานะของ bean
- "น้ำ" คือทุนจำลองที่ใส่ให้ bot ต้นไม้จะโต ออกดอก ออกผล หรือเหี่ยว ตามกำไรขาดทุนของ bot (สูตรเดิมของเกม 2D)
- ผู้เล่นกางร่ม (พัก), เก็บเกี่ยว (ปิดเมื่อกำไร), ถอน (ปิดเมื่อขาดทุน) หรือเผาไร่ทั้งแปลงเพื่อหยุดทุกอย่าง
- ตัวเลขเงินทุกตัวบนจอคือตัวเลขของ server พร้อมอายุของตัวเลข ค่าประมาณขึ้นต้นด้วย `≈` เสมอ

---

## เริ่มใช้งานเร็ว

ต้องใช้ **Node.js ≥ 22.16** (`node:sqlite` และ online backup ของโหมด accounts) และรัน **`npm install` ครั้งเดียว**
dependency ทั้งหมดถูก pin เวอร์ชันตายตัว: `three@0.169.0` (ส่งให้เบราว์เซอร์ที่ `/vendor/three/*` เท่านั้น server ไม่ได้ import three)
และ `@noble/curves@1.6.0`, `@noble/hashes@1.5.0`, `@msgpack/msgpack@2.8.0` ที่ใช้เฉพาะตัวเซ็น order ของ testnet (`server/hl/`)

```sh
npm install          # ครั้งเดียว
npm start            # ราคาจริงจาก Hyperliquid (ต้องมีอินเทอร์เน็ต)
npm run sim          # ราคาจำลอง ไม่ต้องใช้เครือข่าย
# แล้วเปิด http://127.0.0.1:8420
```

- ครั้งแรกระบบจะ **warm up** ย้อนหลัง 2880 bar ก่อนเปิดให้เข้าใช้
  - `--feed hyperliquid`: ดึง candle 1 นาทีจริงของ 16 coin (ราว 1 นาทีของ rate budget) แล้ว bar ถัดไปจะปิดตามนาทีจริงของนาฬิกา
  - `--feed sim`: จำลองตลาด GBM ใช้เวลาราว 0.6 วินาที แล้วเดิน 1 tick ทุก 5 วินาที (เร็วกว่าเวลาจริง 12 เท่า)
- ถ้าเริ่มแบบราคาจริงครั้งแรกแล้ว warm up ไม่ได้ (เช่น ไม่มีเครือข่าย) ระบบจะเปิดด้วยราคาจำลองแทน ป้ายจะบอกเหตุผล
  และเมื่อราคาจริงกลับมา หน้าเว็บจะแนะนำให้ restart (ระบบไม่สลับ feed เองระหว่างทำงาน)

| สคริปต์ | คำสั่ง | ใช้เมื่อ |
|---|---|---|
| `npm start` | `node server/main.js` | ราคาจริง (ค่าเริ่มต้น) ถ้ามี state ที่บันทึกไว้จะทำต่อจากเดิมและเล่นนาทีที่พลาดย้อนให้ |
| `npm run sim` | `node server/main.js --feed sim` | ราคาจำลอง |
| `npm run dev` | `node server/main.js --feed sim --tick-ms 2000` | ราคาจำลองที่เดินเร็วขึ้น สำหรับพัฒนา |
| `npm run fresh` | `node server/main.js --fresh` | ทิ้ง state เดิมของ feed นั้นแล้วเริ่มใหม่ |
| `npm run accounts` | `node server/main.js --auth accounts --public-origin http://localhost:8420` | โหมดผู้เล่นหลายคน ราคาจริง (ดู[โหมด accounts](#โหมดผู้เล่นหลายคน---auth-accounts)) |
| `npm run accounts:sim` | `… --auth accounts --public-origin http://localhost:8420 --feed sim` | โหมดผู้เล่นหลายคน ราคาจำลอง (ไม่มี testnet) |
| `npm run accounts:double` | `… --auth accounts --public-origin http://localhost:8420 --testnet-double` | พัฒนาหน้า testnet กับ testnet จำลองในเครื่อง (ไม่มี network ไป testnet) |
| `npm run keygen` | สุ่ม 32 byte แบบ base64 | สร้าง master key สำหรับ `BEAN_MASTER_KEY_FILE` |
| `npm run admin -- status` | `node server/admin-cli.js …` | คำสั่งของผู้ดูแล (ใช้ `ADMIN_TOKEN_FILE` เรียก server ในเครื่องเดียวกัน) |
| `npm test` | `node --test "test/*.test.js"` | รันเทสต์ทั้งหมด (ไม่ใช้เครือข่าย) |

### หน้าเว็บ

| URL | หน้า |
|---|---|
| `/` | สวน 3 มิติ (ต้องมี WebGL2) |
| `/classic.html` | สวน 2D แบบเดิม (canvas) ใช้ API ชุดเดียวกัน |
| `/?classic=1` | ไปหน้า classic ทันที |
| `/?debug=1` | แผง debug: fps, เวลาต่อเฟรม, draw call, triangle, tier, ขั้นของ governor, อายุของราคา, เวลาสร้างฉาก |
| `/?nostream=1` | ไม่ใช้ SSE: poll อย่างเดียว และดึงราคาจาก `market` ทุก 10 วินาที (ตัวเลข P&L ระหว่างนั้นเป็น `≈`) |
| `?api=<url>` / `?token=<T>` | ชี้ไป backend อื่น / ตั้ง command token (ถูกลบออกจาก address bar ทันที) |

ถ้าเบราว์เซอร์ไม่มี WebGL2 หรือ server ไม่มีไฟล์ของ three (ยังไม่ได้ `npm install`) หน้า `/` จะบอกเหตุผลแล้วพาไป
`/classic.html` ภายใน 2 วินาที โดยไม่พก `?token=` ไปด้วย

### CLI flags

| flag | env | ค่าเริ่มต้น | ความหมาย |
|---|---|---|---|
| `--port N` | `PORT` | `8420` | พอร์ต HTTP |
| `--host H` | – | `127.0.0.1` | interface ที่ bind ปกติฟังเฉพาะเครื่องตัวเอง |
| `--token T` | `BEAN_API_TOKEN` | ไม่มี | token สำหรับ command ต้องเป็นอักขระ ASCII ที่มองเห็นได้ ไม่มีช่องว่าง และยาวอย่างน้อย 16 ตัว (ดู[โมเดลความปลอดภัย](#โมเดลความปลอดภัย)) |
| `--no-loopback-commands` | – | – | บังคับใช้ token กับทุก command แม้มาจากเครื่องตัวเอง ใช้เมื่อเปิดพอร์ตผ่าน tunnel หรือ port-forward (ต้องมี `--token`) |
| `--feed hyperliquid\|sim` | – | `hyperliquid` | แหล่งราคา: `hyperliquid` = ราคาจริงแบบอ่านอย่างเดียว (1 bar ต่อ 1 นาทีจริง, ราคาล่าสุดทุก ~5 วินาที), `sim` = ราคาสังเคราะห์ |
| `--seed N` | – | `42` | seed ของการจำลอง ค่า seed เดียวกันให้ผลเหมือนเดิมทุกครั้ง |
| `--beans N` | – | `3000` | จำนวน bean ระบบย่อหรือขยายจำนวนต่อ archetype ตามสัดส่วนให้เอง |
| `--warmup N` | – | `2880` | จำนวน bar ก่อนเปิดให้ใช้ (เฉพาะตอนเริ่มใหม่) กับ `hyperliquid` ได้ไม่เกิน 5000 เพราะ Hyperliquid เก็บ candle ไว้แค่นั้น |
| `--tick-ms N` | – | `5000` | **เฉพาะ `--feed sim`**: มิลลิวินาทีจริงต่อ 1 tick (ราคาจริงเดินตามนาทีจริงเสมอ ใส่ flag นี้กับ `hyperliquid` จะ error) |
| `--data DIR` | – | `./data` | โฟลเดอร์เก็บ state (นับจาก root ของโปรเจกต์) |
| `--fresh` | – | – | ไม่โหลด state เดิมและเริ่มใหม่ |
| `--account USD` | – | `10000` | ขนาดบัญชีจำลอง |
| `--max-bots N` | – | `10` | จำนวน bot ที่เปิดได้พร้อมกันสูงสุด |
| `--max-bot-capital USD` | – | `1000` | ทุนสูงสุดต่อ bot |
| `-h, --help` | – | – | แสดงวิธีใช้ |

ถ้าใส่ argument ผิด โปรแกรมจะจบด้วย exit code 2 และพิมพ์วิธีใช้ออกมา

### การบันทึก state

- **แต่ละ feed มีไฟล์ของตัวเอง** สลับ feed ไปมาได้โดยไม่ทำลายสวนอีกแบบ:

  | feed | state | journal |
  |---|---|---|
  | `sim` (ชื่อเดิม สวนเก่ายังใช้ได้) | `data/state.json` | `data/journal.jsonl` |
  | `hyperliquid` | `data/state-real.json` | `data/journal-real.jsonl` |

- ไฟล์ state เขียนแบบ atomic (เขียนลงไฟล์ tmp แล้ว rename ทับ) บันทึกหลัง warm-up, เป็นระยะ (ทุก 30 tick ของ sim /
  ทุก bar ของราคาจริง), ไม่นานหลัง command ของ bot และเมื่อได้รับ `SIGINT` (Ctrl+C), `SIGTERM` หรือ `SIGBREAK`
- journal เก็บ event ทุกตัวต่อท้ายไฟล์ไปเรื่อย ๆ และ rotate เมื่อใหญ่เกิน 64 MB
- ถ้าเริ่มด้วย `--fresh` หรือ state เดิมใช้ไม่ได้ (เช่น seed, จำนวน bean หรือ feed ไม่ตรง) ระบบจะเก็บไฟล์เก่าไว้เป็น
  `*.prev.*` ก่อนเริ่มใหม่
- **ราคาจริงกับการปิดเครื่อง:** เมื่อเปิดใหม่ ระบบดึง candle ของนาทีที่หายไปแล้วเล่นย้อนให้ (ไม่เกิน 2880 นาที)
  ถ้าหายนานกว่านั้นจะ warm up ตลาดใหม่ทั้งหมด (re-warm) โดย**เก็บ bot และ journal ไว้**
- บน Windows ให้หยุดด้วย **Ctrl+C** ในหน้าต่าง console ระบบจะบันทึกก่อนออก

---

## โหมดผู้เล่นหลายคน (`--auth accounts`)

โหมดนี้ใช้เมื่อจะเปิดสวนให้หลายคนเล่นผ่านอินเทอร์เน็ต (สัญญาฉบับเต็ม: [`PLATFORM.md`](PLATFORM.md))
- เครื่องยนต์ (ราคา, ตลาด, ประชากร bean ~3000 ตัว) มีชุดเดียวและเป็น**สาธารณะ**: bean, ราคา และตลาดใช้ร่วมกันทุกคน
- **สวนเป็นของส่วนตัว**: bot, บัญชีกระดาษ, เพดาน, การเผาไร่, บันทึก (diary), event และ SSE ของใครของมัน คนอื่นมองไม่เห็น
- คนที่ยังไม่เข้าสู่ระบบ (spectator) เห็นเกาะ ตลาด และแผงเมล็ด แต่แปลงว่าง และการปลูกจะพาไปหน้าสมัคร
- ทั้ง server เป็น **process เดียว** (SQLite ไฟล์เดียว, engine ที่มี state) ขยายได้ด้วยเครื่องที่แรงขึ้นเท่านั้น

### เริ่มบนเครื่องตัวเอง

```powershell
npm install
npm run accounts:sim          # ราคาจำลอง, เปิด http://localhost:8420
```

- ต้องเปิดหน้าเว็บด้วย host เดียวกับ `--public-origin` เป๊ะ ๆ (เช่น `http://localhost:8420`) host อื่นได้ `421 misdirected`
  เพื่อกัน DNS rebinding
- คุกกี้ของเบราว์เซอร์แยกตาม **host ไม่แยกตาม port**: ถ้ารัน server โหมด accounts สองตัวบน host เดียวกันคนละ port
  ในเบราว์เซอร์เดียวกัน ทั้งสองจะใช้คุกกี้ `bean_sid` ตัวเดียวกันและล้างของกันและกัน (เข้าสู่ระบบแล้วหลุดเอง)
  ให้ใช้คนละ host (เช่น `localhost` กับ `127.0.0.1`) หรือคนละโปรไฟล์ของเบราว์เซอร์
- **admin คนแรก:** server สร้างโค้ดสุ่มไว้ใน `data/admin-bootstrap.txt` (สิทธิ์ 0600 และ**ไม่พิมพ์ลง log**) ให้อ่านไฟล์นั้น
  แล้วสมัครพร้อมกรอกโค้ดในช่อง "Operator setup code" บัญชีนั้นจะเป็น admin และไฟล์จะถูกลบทันที
  (หรือกำหนดโค้ดเองด้วย `ADMIN_BOOTSTRAP_CODE_FILE`) ชื่อใน `ADMIN_USERNAMES` แค่เลื่อนผู้ใช้ที่มีอยู่แล้วขึ้นเป็น admin ตอนบูต
- ผู้เล่นทั่วไปสมัครด้วย username (a–z, 0–9, _ ยาว 3–24) และรหัสผ่านอย่างน้อย 10 ตัวอักษร แล้วได้เงินกระดาษ $10,000 ทันที
- **ไม่มีอีเมลและไม่มีการรีเซ็ตรหัสผ่านด้วยตัวเอง:** ผู้ดูแลออกโค้ดรีเซ็ตแบบใช้ครั้งเดียวให้ได้ (`admin_user reset_password`)
  ซึ่ง**ลบ API wallet ของ testnet ของผู้เล่นคนนั้นก่อนเสมอ** ผู้ดูแลจึงเอาโค้ดรีเซ็ตไปเข้าถึง key ของ testnet ไม่ได้
- คำสั่งผู้ดูแลจากในเครื่องเดียวกัน: ตั้ง `ADMIN_TOKEN_FILE` แล้วใช้ `npm run admin -- status`, `kill on "เหตุผล"`, `users`
  (token นี้ใช้ได้เฉพาะ op ของผู้ดูแล และรับเฉพาะ request ที่มาจาก loopback ตรง ๆ ที่ไม่มี proxy header)
- การ deploy บนอินเทอร์เน็ต (Docker + Caddy, Fly.io ฯลฯ, backup, health check, checklist ความปลอดภัยก่อนเปิดลิงก์) อยู่ใน
  PLATFORM §10
- **ขึ้นคลาวด์ฟรีโดยไม่ใช้คอมของคุณ:** Render (แพ็กเกจฟรี, `render.yaml`) รันเกม และ bucket ส่วนตัวของ Supabase Storage
  เก็บฐานข้อมูล (sync ทุกนาที) + state ของตลาด (ทุก 2 ชั่วโมง) พร้อมสำเนารายชั่วโมง 48 ชม. โดยคุมปริมาณอัปโหลดให้อยู่ในโควตา
  5 GB/เดือนของ Render ขั้นตอนทั้งหมดอยู่ใน [`deploy/render/README.md`](deploy/render/README.md)

### เงินทดสอบ (test funds) และ testnet

> **เงินทดสอบ (test USDC) มาจาก faucet ของ Hyperliquid ที่ `https://app.hyperliquid-testnet.xyz/drip` (ครั้งละ 1,000 mock
> USDC) และ faucet นี้จ่ายให้เฉพาะ address ที่เคยฝากเงินบน mainnet ด้วย address เดียวกันเท่านั้น** การล็อกอินด้วยอีเมล
> (Privy) ได้ address คนละตัวบน mainnet กับ testnet ถ้าไม่มี address ที่เคยฝากบน mainnet จะเติมเงิน testnet เองไม่ได้
> ซึ่งไม่เป็นไร: **เกมกระดาษเล่นได้ครบทุกอย่างโดยไม่ต้องใช้ testnet** (ขั้นตอนเติมเงินทั้งสองแบบอยู่ใน PLATFORM §11.4)

- เปิด testnet บน server: `BEAN_MASTER_KEY_FILE` (32 byte สุ่ม จาก `npm run keygen`) + `TESTNET_ENABLED=1` + ราคาจริง
  (`--feed hyperliquid`) ถ้าไม่ตั้ง testnet จะปิดอยู่และผู้เล่นใช้ได้แค่กระดาษ
- ผู้เล่นเชื่อมที่ Settings → Testnet: วาง **account address** และ **private key ของ API wallet** (agent) ที่สร้างเองที่
  `https://app.hyperliquid-testnet.xyz/API` (แนะนำให้ตั้งชื่อ เช่น `bean-garden`)
  - **ห้ามวาง key หลักของกระเป๋าหรือ seed phrase:** ระบบตรวจรูปแบบและปฏิเสธ seed phrase, key หลัก (master), key ที่ไม่ใช่ agent
    ของ account นั้น และ **key ที่มีตัวตนอยู่บน mainnet** (ถ้าเช็ก mainnet ไม่ได้ ระบบไม่เก็บอะไรเลย: fail-closed)
  - API wallet ส่ง order ได้แต่**ถอนเงินไม่ได้** key ถูกเก็บแบบเข้ารหัส AES-256-GCM ด้วย master key ที่อยู่นอกฐานข้อมูล
    และไม่เคยถูกส่งกลับมาใน API, SSE หรือ log
  - วางกระเป๋าใหม่ของ account เดิมได้ทันที (Replace API wallet) โดย bot ไม่ถูกปิด
- bot ที่ปลูกแบบ **Testnet** ส่ง order IOC จริงบน testnet, กระทบยอดกับ exchange ทุก bar และตัวเลขทุกตัวติดป้าย testnet
  ตัวเลขที่เราคำนวณเองระหว่างกระทบยอดขึ้นต้นด้วย `≈` ราคา testnet อาจต่างจากราคาจริงมาก ผลของ bot testnet จึงไม่เท่ากับผลของ bean
- ผู้ดูแลมี kill switch ที่ปิดและ flatten bot testnet ของทุกคนทันที ส่วน bot กระดาษไม่โดนผลกระทบ
- `npm run accounts:double`: ใช้ testnet จำลองในตัว process (สำหรับพัฒนาเท่านั้น) ไม่มี request ใดไปถึง testnet จริง
  ผู้ดูแลสร้างบัญชีจำลองและใส่ความผิดพลาดต่าง ๆ ได้ด้วย op `dev_double` (ปฏิเสธเมื่อ `NODE_ENV=production`)

### ตัวแปรสภาพแวดล้อมหลักของโหมด accounts

| ตัวแปร / flag | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `BEAN_AUTH` / `--auth` | `none` | `none` หรือ `accounts` เท่านั้น (ค่าว่างหรือค่าอื่น → exit 2) |
| `PUBLIC_ORIGIN` / `--public-origin` | – (บน Render: `RENDER_EXTERNAL_URL`) | **จำเป็น** เช่น `https://bean.example.com` (http ได้เฉพาะ localhost) ใช้ตรวจ Origin/Host และเลือกคุกกี้ `__Host-` |
| `TRUST_PROXY`, `TRUSTED_PROXY_CIDRS`, `CLIENT_IP_HEADER` | 0 | เชื่อ IP จาก proxy เฉพาะเมื่อ peer อยู่ใน CIDR ที่ไว้ใจ (Caddy: `TRUST_PROXY=1`, Fly: `CLIENT_IP_HEADER=fly-client-ip`) |
| `BEAN_MASTER_KEY_FILE` | – | master key ของการเข้ารหัส (จำเป็นเมื่อเปิด testnet) **ห้าม** backup ไว้คู่กับข้อมูล |
| `TESTNET_ENABLED` | 0 | 1 = เปิด venue testnet (ต้องมี master key และราคาจริง) |
| `ADMIN_TOKEN_FILE` | – | token ของผู้ดูแล (≥ 32 ตัว) ใช้กับ `admin-cli` จากในเครื่องเท่านั้น |
| `ADMIN_BOOTSTRAP_CODE_FILE` | สร้างลง `data/admin-bootstrap.txt` | โค้ดสมัคร admin คนแรก |
| `SIGNUP_MODE`, `SIGNUP_MAX_PER_HOUR` | `open`, 60 | `open` / `closed` (และ `invite` แบบ P1) และเพดานการสมัครต่อชั่วโมงทั้งระบบ |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY(_FILE)` | – | เก็บ DB + state ถาวรใน bucket ส่วนตัวของ Supabase Storage (สำหรับโฮสต์ที่ดิสก์หายเมื่อรีสตาร์ต เช่น Render ฟรี) ต้องตั้งคู่กันเสมอ ปรับได้ด้วย `CLOUD_STORE_BUCKET` (`bean-garden`), `CLOUD_STORE_PREFIX`, `CLOUD_SYNC_SECONDS` (60), `CLOUD_EGRESS_BUDGET_MB` (3072/เดือน) และ `CLOUD_ALLOW_FRESH=1` (เริ่มใหม่โดยตั้งใจ ครั้งเดียว) |

ในโหมด `none` ถ้ามีตัวแปรที่ใช้ได้เฉพาะโหมด accounts หรือ env `HOST` ที่ไม่ใช่ loopback โปรแกรมจะ exit 2 ทันที
(กันการเผลอเปิดโหมดไม่มีบัญชีขึ้นอินเทอร์เน็ต) และในโหมด accounts ห้ามใช้ `--token` / `BEAN_API_TOKEN`
ตัวแปรลับทุกตัวถูกลบออกจาก environment หลังอ่าน รายการเต็มอยู่ใน PLATFORM §10.3

### API ในโหมด accounts (สรุป)

- **ทุก request:** header ความปลอดภัย (COOP, CORP, Permissions-Policy และ HSTS เมื่อเป็น https, CSP `connect-src 'self'`)
  และตรวจ `Host` (`421 misdirected`) โดย `/healthz`, `/readyz` และ `GET /api/v1/health` ตอบที่ `127.0.0.1:<port>` ได้ด้วย
  และ `GET /healthz` (ตอบ `{ok:true}` คงที่) ตอบได้ทุก Host เพื่อให้ health check ภายในของแพลตฟอร์มอย่าง Render ผ่าน
- **command (POST):** ถ้า URL มี query string จะได้ `400 query_params_not_allowed` **ก่อนอ่าน body** (ความลับจึงไม่ไปอยู่ใน
  access log) → ต้องเป็น `Content-Type: application/json` (`415`) → `Origin` ต้องตรงกับ `PUBLIC_ORIGIN` หรือมี
  `Sec-Fetch-Site: same-origin` (`403 csrf`) → คุกกี้ session (`__Host-bean_sid`, HttpOnly, SameSite=Lax) → สิทธิ์ของ op
  (`public` / `user` → `401 auth_required` หรือ `session_expired` / `admin` → `403 forbidden`) → rate limit (`429` พร้อม
  `retry_after_s` และ `Retry-After`) → body ไม่เกิน 64 KB (op ที่เกี่ยวกับรหัสผ่านและ key: 4 KB) พารามิเตอร์อ่านจาก JSON body เท่านั้น
- **error ทุกตัวมี `code` สำหรับเครื่อง** (รายการ `ERROR_CODES` ใน `server/catalog.js`) หน้าเว็บแปลข้อความตาม `code` เป็นไทย/อังกฤษ
  error 500 ไม่เคยส่งข้อความภายในออกไป และ op ที่อ่อนไหว (รหัสผ่าน, key) ไม่ถูกเขียนพารามิเตอร์ลง log
- **op ใหม่:**

| กลุ่ม | op |
|---|---|
| บัญชี | `auth_signup`, `auth_login`, `auth_reset` (โค้ดจากผู้ดูแล), `auth_logout`, `auth_logout_all`, `me` (spectator ได้ `user: null`), `account_password`, `account_delete` (พิมพ์ `DELETE`), `sessions`, `session_revoke` |
| สวน | `garden_rearm` (พิมพ์ `REARM` หลังเผาไร่ ≥ 60 วินาที), `garden_reset` (พิมพ์ `RESET` เริ่ม**ฤดูกาลกระดาษ**ใหม่ วันละครั้ง), `bot_create` เพิ่ม `venue: "paper" | "testnet"` (testnet ต้องส่ง `confirm: "testnet"`) |
| testnet | `testnet_market`, `testnet_status`, `testnet_quote` (สามตัวนี้อ่านจาก cache เท่านั้น ไม่กินโควตาของ Hyperliquid), `testnet_connect`, `testnet_verify`, `testnet_disconnect` |
| ผู้ดูแล | `admin_status`, `admin_users`, `admin_audit`, `admin_kill_switch`, `admin_testnet_signing`, `admin_caps`, `admin_user`, `admin_backup`, `dev_double` (เฉพาะ `--testnet-double`) |

- `bots`, `bot_detail`, `live_status`, `live_fills`, `events` และคำตัดสิน `tradeable`/`bot` ของ `beans` เป็นของผู้เล่นที่เข้าสู่ระบบเท่านั้น
  ส่วน `tick` ใช้ได้เฉพาะผู้ดูแล
- **SSE:** stream ที่เปิดพร้อม session ได้ event สาธารณะ + event ของตัวเอง ส่วน spectator ได้เฉพาะ event สาธารณะ
  `mids` ของแต่ละคนแนบ bot และบัญชีของคนนั้นเท่านั้น เมื่อออกจากระบบหรือ session ถูกเพิกถอน stream ของ session นั้นจะได้
  `session_ended` แล้วปิดทันที (`resync` = ให้รีเฟรชทั้งหมด, `server_restart` = server กำลังรีสตาร์ต)
  มีเพดาน 5 stream ต่อผู้เล่น, 20 ต่อ IP, 2,000 ทั้งระบบ และ buffer ไม่เกิน 128 KB ต่อ stream
- หน้าเว็บถาม `me` ก่อนเชื่อ `session_ended`: การเปลี่ยนรหัสผ่านเพิกถอน session เก่าทั้งหมด (stream เดิมจึงได้
  `session_ended`) แต่เบราว์เซอร์ที่เปลี่ยนได้คุกกี้ใหม่แล้ว จึงแค่เปิด stream ใหม่โดยไม่เด้งกลับไปหน้าเข้าสู่ระบบ
  ส่วน 401 ของ request ที่ส่งด้วยคุกกี้เก่าระหว่างคำสั่งเปลี่ยน session (สมัคร, เข้า/ออก, รีเซ็ต, เปลี่ยนรหัส, ลบบัญชี)
  ถือว่าเก่าและไม่นับว่า "หลุดจากระบบ"

## เกม ↔ API

**ตัวเลขและสิ่งของบนเกาะ** (ตาราง mapping ฉบับเต็มอยู่ใน GAME-DESIGN §1.5)

| ในเกม | ข้อมูลจริง |
|---|---|
| **ป้าย REAL PRICES · PAPER TRADES**, ป้ายทาง, นาฬิกาแดด (มีเฉพาะราคาจำลอง) | `health` / `status.feed` (`prices`, `state: live\|delayed\|down\|sim`, `stale_coins`, `fallback`) และ SSE `feed_status` |
| แถบราคา (ticker) และกระดานราคา | `market` + SSE `mids` ทุก ~5 วินาที (ราคาเป็นหมึกกลาง ▴/▾ ไม่ใช้เขียว/แดง) |
| **แผงเมล็ด**: bean ที่ดีที่สุด 5 ตัว ตัวละ 1 coin | `GET beans?tradeable=true&distinct_coin=true&busted=false&trades_min=1&limit=5&sort=…` และ sparkline จาก `equity_curves` |
| **กระบะปลูก** 1 กระบะ = bot 1 ตัว (10 กระบะ, สูงสุด 15) | `GET bots` + ตัวเลขสดจาก `mids.bots` ที่ใหม่กว่า |
| ป้ายลูกศรขึ้น (น้ำเงิน, นกบลูเบิร์ด) / ลง (ม่วง, ตุ่น) | เครื่องหมายของ `real.szi` (LONG / SHORT) |
| หลัก `×N`, กระสอบปุ๋ย, การสั่น | `leverage` ของ bot = min(bean, venue) |
| เทอร์โมมิเตอร์ "ราคาต้องลง X% จึงถูก liquidate" | `real.liquidation_px` เทียบ `mark_px` และ `entry_px` (แถบ ok / warn / danger ไม่ใช้เขียว/แดง) |
| ยุ้งฉาง / ไซโล (เส้นทุนเริ่มต้น) | `account_state.account_value` เทียบ `account_usd` |
| บ่อน้ำ / หอเก็บน้ำ | `available_usd` (เงินสดว่าง) / `deployed_usd` (น้ำที่ลงแปลงอยู่) |
| ป้าย *Growing* / *Harvested* | `unrealized_pnl` / `realized_pnl` |
| ลังผลผลิต / กองปุ๋ยหมัก | bot ที่ปิดแล้วด้วยกำไร ≥ 0 / ขาดทุน |
| กังหันลม = นาฬิกาของ bar, ลม = ความผันผวน, ฟ้า = สภาพตลาด | `next_tick_ms`, ค่าเฉลี่ย \|`change_1h`\|, ค่าเฉลี่ย `change_24h` |
| 🌱 **ปลูก + รดน้ำ** | `POST bot_create {bean, capital_usd}` (หน้าต่างปลูกแสดง margin, ระยะ liquidation, ค่าธรรมเนียม และคำว่า paper fill) |
| ⛱ ร่ม / ☀ แดด | `POST bot_pause` / `bot_resume` |
| 🧺 เก็บเกี่ยว / 🪓 ถอน | `POST bot_close` (เก็บเกี่ยวเมื่อ realized ≥ 0 พร้อมเหรียญ, ถอนเมื่อติดลบ ไม่มีเหรียญ ไม่มีเสียงฉลอง) |
| 🔥 เผาไร่ | `POST bots_halt` ปิดทุกแปลงทีละแปลงด้วยตัวเลขจริงของแต่ละแปลง และปฏิเสธการปลูกจนกว่าจะ restart |
| ⏩ +1h (เฉพาะราคาจำลอง) | `POST tick {n: 60}` — ราคาจริงตอบ `409` เสมอ |
| ตู้จดหมาย = สมุดบันทึกสวน | SSE ทั้งหมด + `events?limit=100` |

**กติกาความซื่อตรง (Juice Contract, GAME-DESIGN §1.3)** บังคับด้วยฟังก์ชัน pure ที่มีเทสต์ (`core/rules.js`, `fx/director.js`):
ตัวเลขเงินเปลี่ยนใน DOM ทันทีที่ข้อมูลมา ไม่มีการนับขึ้นหรือ tween ตัวเลข, ไม่มีแอนิเมชันผลลัพธ์ก่อน server ยืนยัน
(HTTP 2xx หรือ SSE echo), เหรียญและประกายมีเฉพาะการปิดที่ได้กำไรจริง, เขียว/แดงหมายถึงเงินเท่านั้น
น้ำเงิน/ม่วงหมายถึงฝั่ง LONG/SHORT เท่านั้น, ราคาทุก ~5 วินาทีขยับได้แค่ "สปริง" ของต้นไม้ ไม่มีประกายหรือฝุ่นต่อราคา
และไม่มี XP, streak หรือรางวัลจากการเทรด

**โมเดลการเติบโต** (สูตรเดิม import จาก `web/js/plant.js` ไม่ได้เขียนซ้ำ) ให้ `f = (realized_pnl + real.unrealized_pnl) / capital_usd`

```
size   = clamp(0.25 + 6f + (phase === 'waiting' ? 0 : 0.1), 0.12, 1)
health = clamp(1 + 8f, 0, 1)
ผล     : f > 2% และ health > 0.6 → 1 ลูกต่อทุก 2% (สูงสุด 6 ลูก)
ดอก     : health > 0.4
caption: "dying" (health < 0.2) · "wilting" (< 0.5) · "ripe" (f > 5%) · "in the shade" (paused)
```

phase ของต้นไม้คำนวณจาก BotRow ตามลำดับนี้: `closed` → `paused` → `error` → `waiting` (bean ไม่มี position)
หรือ `entering` (bean มี position แต่ bot ยังไม่ได้ fill) → `long` / `short`

### การควบคุม (GAME-DESIGN §5.2)

| การกระทำ | เมาส์ | สัมผัส | คีย์บอร์ด (เมื่อโฟกัสอยู่ที่ฉากหรือ `<body>`) |
|---|---|---|---|
| เลื่อนกล้อง | ลากด้วยปุ่มซ้าย | ลาก 1 นิ้ว | ลูกศร (Shift = ×3) |
| หมุน / เอียง | ลากปุ่มขวา หรือ Alt + ลากซ้าย | บิด 2 นิ้ว (หมุน), ลาก 2 นิ้วขึ้นลง (เอียง) | Q / E หมุน ∓20°, PageUp / PageDown เอียง ±4° |
| ซูม | ล้อเมาส์ (ซูมเข้าหาตำแหน่งเคอร์เซอร์) | บีบนิ้ว | `+` / `−` |
| เลือกแปลง | คลิก | แตะ | `1`–`9`, `0` = แปลง 1–10, `[` / `]` แปลงก่อนหน้า/ถัดไป |
| โฟกัสและเปิดรายละเอียด | ดับเบิลคลิก | แตะสองครั้ง | Enter หรือ F |
| เมนูด่วน | – | กดค้าง 450 ms บนแปลง | – |
| ปลูกโดยลาก | ลากการ์ดเมล็ดลงกระบะ | เหมือนกัน | – |
| ย้อนกลับ | Esc | ปุ่ม ⌖ / ปุ่ม back ของ Android | Esc: ปิดแผง → ออกจากโฟกัส → ยกเลิกการเลือกเมล็ด |
| มุมกล้องเริ่มต้น | – | กดค้างปุ่ม ⌖ | Home |
| แผง | – | แถบล่าง | P เมล็ด · D บันทึก · L รายการ · B กระดานราคา · M เสียง · ? ช่วยเหลือ |

ปุ่มลัดตัวอักษรเดียวปิดได้ใน Settings (WCAG 2.1.4) และ**ไม่มีปุ่มลัดไหนใช้เงินหรือปิด position** ทุกคำสั่งทำได้ครบด้วยคีย์บอร์ด
ผ่านแถบแปลง (dock) ซึ่งเป็นคู่แฝด DOM ของเกาะสำหรับ screen reader

### เล่นรอบแรก

1. **ดูป้ายมุมซ้ายบน** — `● REAL PRICES · PAPER TRADES` (เขียว) = ราคาจริงจาก Hyperliquid, `◆ SIMULATED PRICES` (ม่วงลาย) = ราคาจำลอง
   ป้ายนี้ซ่อนไม่ได้ และคลิกเพื่ออ่านคำอธิบายได้
2. **เปิดแผงเมล็ด** (ปุ่ม Seeds, คลิกแผงขายเมล็ดบนเกาะ หรือกด `P`) — ทุกการ์ดคือ bean ที่ดีที่สุดของ coin นั้น พร้อมผลงานกระดาษ
   และฝั่งที่ถืออยู่ตอนนี้
3. **Select** = เข้าโหมดเลือกแปลง (กระบะว่างเรืองแสง) แล้วคลิกกระบะ หรือ **Plant…** = ปลูกในแปลงว่างแปลงถัดไป
4. **หน้าต่างปลูก** บอก notional, margin, ระยะ liquidation, กรณีเลวร้ายที่สุด, ค่าธรรมเนียมไป-กลับ และ funding (ข้อมูลเท่านั้น)
   leverage ≥ 25× ต้องติ๊กยอมรับก่อน และปลูกไม่ได้ถ้าราคา coin นั้นล่าช้าหรือ feed ล่ม
5. **กดปลูก** — ระหว่างรอ server จะเห็นเสียมขุดวนอยู่ ต้นกล้าและน้ำจากหอเก็บน้ำจะมา**หลัง** server ตอบสำเร็จเท่านั้น
6. **ดูแล** — เลือกแปลง (คลิก, `1`–`0` หรือการ์ดใน dock) เพื่อเปิด inspector: ราคา mark, ราคาเข้า, ขนาด, margin, ราคา liquidation
   และ P&L ทุกตัวคือตัวเลขของ server พร้อมอายุ ⛱ กางร่ม = พักและปิด position, ☀ = กลับมาทำงาน
7. **ปิดแปลง** — 🧺 เก็บเกี่ยวเมื่อรวมแล้วกำไร (เหรียญบินเข้าลังผลผลิต) หรือ 🪓 ถอนเมื่อขาดทุน (กอดินไปกองปุ๋ยหมัก ไม่มีเหรียญ)
   หน้าต่างยืนยันแสดง ≈ ตัวเลขหลังค่าธรรมเนียมและ slippage และปุ่มที่โฟกัสอยู่ก่อนคือ "Keep growing"
8. **เผาไร่** (🔥 หรือกองไฟ) ปิดทุกแปลงทันทีทีละแปลงด้วยตัวเลขจริง และห้ามปลูกจนกว่าจะ restart server
9. ราคาจำลองมีปุ่ม **⏩ +1h** (หรือคลิกนาฬิกาแดด) เดินตลาด 60 bar ทันที ราคาจริงไม่มีปุ่มนี้และ server ตอบ `409`

หน้าเว็บรองรับภาษาไทยและอังกฤษ (ข้อความทุกตัวเป็น DOM ไม่วาดลง WebGL), ใช้ได้ที่ความกว้าง 360 px,
มีชุดสีสำหรับผู้มีภาวะบกพร่องการเห็นสี และเคารพ `prefers-reduced-motion` (ไม่มีกล้องบิน ไม่มี particle ไม่มีการแกว่ง
และเรนเดอร์เฉพาะเมื่อข้อมูลหรือ input เปลี่ยน)

---

## สถาปัตยกรรม

### Backend

```
                 browser: / (3D, js/game/*) · /classic.html (2D, js/garden.js)
                  │  query()  GET /api/v1/<op>      ▲  stream()  EventSource /api/v1/events/stream
                  │  command() POST /api/v1/<op>    │  (journal events มี id: · pulse `mids` ไม่มี id:)
                  ▼                                 │
┌──────────────────────────────── server/http.js ────────────────────────────────────┐
│ static web/ · /vendor/three/{build/three.module(.min).js, LICENSE} · /docs · /api/v1 │
│ catalog.js = op catalogue → validate + index + docs · command auth: token | loopback │
└──────┬──────────────────────┬───────────────────────────┬──────────────┬──────────┘
       │ queries/commands      │ queries/commands           │ subscribe    │ subscribe
       ▼                       ▼                            ▼              ▼
┌──────────────┐ onTick  ┌──────────────┐   emit   ┌──────────────┐  ┌──────────────┐
│  engine.js   │───────▶ │   live.js    │────────▶ │  journal.js  │  │   pulse.js   │
│ bar loop:    │  hook   │ paper        │          │ seq · ring · │  │ mids ~5 s,   │
│ real minute  │         │ exchange,    │          │ jsonl        │  │ never stored │
│ +2 s / sim   │◀─────── │ marks + liq. │          └──────────────┘  └──────────────┘
└──┬────────┬──┘  venue  │ on live mids │
   ▼        ▼     hook   └──────────────┘
┌──────────┐ ┌───────────────┐
│market.js │ │ population.js │ ── strategies.js
│ bars,    │ │ 3000 beans,   │
│ live mids│ │ paper trading │      hyperliquid.js: client อ่านอย่างเดียว + rate ledger 1000/นาที (HL ให้ 1200)
└──────────┘ └───────────────┘      store.js: atomic save · main.js: CLI → wiring → restore/replay/warm-up
```

- **ราคาจริง:** `allMids` ทุก 5 วินาทีเป็น "mark" ของ bot (และเช็ก liquidation ทันที), bar ปิดที่ขอบนาทีจริง + 2 วินาที
  จาก candle จริง (ถ้า candle ยังไม่มาใช้ mid ของนาทีนั้น ถ้าไม่มีอะไรเลย coin นั้นถูก mark ว่า stale และ bot ของมันหยุดนิ่ง)
- **ถ้าทุก coin ไม่มีราคา:** ไม่ tick, สถานะเป็น `delayed` แล้ว `down` หลัง 60 วินาที และเมื่อกลับมาจะเล่นย้อนให้พร้อม
  `feed_gap` หนึ่งครั้งและ `tick_completed` หนึ่งครั้ง
- งบของ Hyperliquid ตอนทำงานปกติราว 364 weight ต่อนาที (HL ให้ 1200 ต่อ IP) ทุก request มี timeout 8 วินาที
  และ HTTP 429 ทำให้พัก 15 วินาที

### Frontend 3 มิติ (`web/js/game/`, GAME-DESIGN §9)

```
index.html ─▶ boot.js ── ?token= เก็บแล้วลบ · ?classic=1 · probe WebGL2 · HEAD /vendor/three → /classic.html
                 │
                 ▼ import('./main.js')
main.js ── store + bus + settings + data.js ── ui/* (HUD ใช้ได้ก่อนฉาก 3 มิติเสร็จ)
   │          │  polling + SSE (+ mids) + commands → store (ตัวเลขของ server เท่านั้น)
   │          ▼
   │      views = viewsOf(state)  ──▶  director (pure) ──▶ Effect[] ──▶ fx/executor ──▶ field / world / sfx
   │                                                            (ผลลัพธ์เล่นหลัง 2xx หรือ SSE echo เท่านั้น)
   ▼ import('./stage.js')   (โมดูลเดียวที่โหลด three ผ่าน shim game/three.js)
stage.js ── renderer · loop · tiers + governor · camera rig · picking · DOM labels · post (MSAA)
            world/world.js (เกาะ, landmark, ฟ้า, อากาศ) · field/field.js (กระบะ, ต้นไม้) · fx/executor.js
```

- **core/** (pure ไม่มี three ไม่มี DOM ทดสอบใน Node ได้): `store.js`, `bus.js`, `data.js`, `view.js` (`plotView`, `assignSlots`,
  `feedBadge`, `liqInfo`, `moneyView`…), `rules.js` (Juice Contract), `settings.js` และ `fx/director.js` (pure reducer)
- **ลำดับต่อเฟรม:** input → กล้อง → tween/สปริง → field → fx → บรรยากาศของ world → ป้าย DOM → ตัดสินใจเงา → render
- **โหมดของ loop:** `continuous` (ค่าเริ่มต้น มีหญ้า เมฆ กังหันลม) และ `demand` (reduced motion: เรนเดอร์เฉพาะหลังข้อมูลหรือ
  input แล้วหยุด ไม่มีเฟรมเลยเมื่อไม่มีอะไรเปลี่ยน) และหยุดเมื่อแท็บถูกซ่อน
- **Quality tier:** High / Medium / Low ตาม GAME-DESIGN §7.5 (Auto = High, Medium เมื่อเป็นจอสัมผัสหรือ `deviceMemory ≤ 4`,
  Low เมื่อ WebGL2 ได้มาจาก software renderer) และมี governor ที่ลดคุณภาพลงทีละขั้นเมื่อเวลาเฉลี่ย 3 วินาทีเกิน 1.3 เท่าของงบ
  (DPR −0.25 → ปิด post → เงา Medium → ปิดเงา → หญ้าครึ่ง → particle ครึ่ง → Low) ไม่เพิ่มคุณภาพเองระหว่างเล่น
  และไม่ตัดสินจากเฟรมของหน้าต่างที่ไม่ได้อยู่ด้านหน้า
- **กล้อง:** เขียนเอง ไม่มี OrbitControls: เลื่อนก่อนหมุน, หมุนได้ ±40°, มุมก้มผูกกับระยะซูม, โหมดโฟกัสแปลง
  และใช้ `camera.setViewOffset` ให้จุดเล็งอยู่กลาง "พื้นที่ที่มองเห็นได้จริง" ไม่โดน HUD, แผงขวา หรือ bottom sheet บัง
- **WebGL context หาย:** พักเฟรม แสดงข้อความ และสร้าง resource ใหม่เมื่อได้ context คืน ถ้าไม่คืนใน 5 วินาที
  หรือหายซ้ำใน 60 วินาที จะเสนอหน้า classic และปุ่มลองใหม่

ตัวเลขที่วัดได้บนเครื่องพัฒนาหลังรวมทุกส่วนแล้ว (Windows 11, Node 24, Intel UHD Graphics iGPU, tier High):

| รายการ | ผล | งบประมาณ |
|---|---|---|
| warm-up 2880 bar | sim ~0.5 วินาที · ราคาจริง ~2.7 วินาที (2880 candle × 16 coin) | ≤ 8 วินาที |
| 1 tick (รวม live layer) | ~0.2–2.7 ms | ≤ 50 ms |
| สร้างฉาก 3 มิติ (stage พร้อม) | ~0.4–0.5 วินาที (world 260–400 ms, field ~50 ms, executor ~10 ms) | world ≤ 300 ms (desktop) |
| JS ต่อเฟรม (update ทุกระบบ ไม่รวมการรอ GPU) | ~0.5–2 ms | ≤ 4 ms |
| draw call / triangle ต่อเฟรม (5 แปลงมีต้นไม้, 1280×800) | ~73 / ~136k | ≤ 140 / ≤ 250k |
| draw call / triangle (15 แปลงสุก, ตัวเลขจาก WP4) | ~88 / ~169k | ≤ 140 / ≤ 250k |
| JS heap | ~25–45 MB | ≤ 120 MB |
| ราคาจริง: `mids` | ทุก 4.85–5.10 วินาที (median ~5.0) | 5 ± 1 วินาที |
| ราคาจริง: bar ปิด | +2.8 วินาทีหลังขึ้นนาทีใหม่ (bar แรกหลัง cold start +12 วินาที สร้างจาก mid) | +2…+17 วินาที |

### โมเดลของตลาดและ bean (สรุปจาก SPEC §2)

- **coin** 16 ตัว (BTC, ETH, SOL, HYPE, XRP, DOGE, AVAX, LINK, SUI, NEAR, ARB, TIA, ZEC, WIF, PUMP, VVV)
  กับราคาจริง `sz_decimals` และ `max_leverage` มาจาก `universe` ของ Hyperliquid ส่วน sim เป็น GBM ราย 1 นาทีแบบ deterministic
- **archetype** มี 9 แบบใน 4 family ได้แก่ `standard`, `hyper_algo`, `degen_algo`, `swarm`, `swarm_5x` … `swarm_100x`
  (สีและวัสดุของกระบะปลูกมาจาก family)
- **strategy** มี `momentum | mean_reversion | breakout | ma_cross | rsi_reversal`
- **การเทรดกระดาษ** แต่ละ bean ใช้ isolated margin เริ่มที่ $1000 มี spread 1 bp, impact 0.5 bp และ taker fee 4.5 bp
- **liquidation** ของ bot เสีย margin เริ่มต้นทั้งหมด: 10× ถูก liquidate เมื่อราคาวิ่งสวน 9.5% จากราคาเข้า
- **busted** คือการตายแบบเดียวของ bean: ไม่มี position และ `equity × position_size × leverage < $10`
- **fitness** คำนวณแยกตาม scale ของ archetype จึง**ห้ามเทียบ fitness ข้าม archetype** หน้า garden เรียงด้วย return, 7-day หรือ Sharpe

---

## สรุป API

- ทุก op อยู่ที่ `/api/v1/<op>` query ใช้ `GET` ส่วน command ใช้ `POST` พร้อม JSON body (ส่งเป็น query string ก็ได้ ถ้าซ้ำกันค่าใน body จะชนะ)
- `GET /api/v1` คืนรายการ op ทั้งหมดจาก catalogue และ `GET /docs` คืนเอกสาร markdown ที่ generate จาก catalogue เดียวกัน
  (รวมฟิลด์ใหม่ทั้งหมดของราคาจริง) รายละเอียดฉบับเต็มอยู่ใน SPEC §4 และ GAME-DESIGN §10.5–10.7
- ตารางในส่วนนี้คือ**โหมด none** (ค่าเริ่มต้น) ซึ่งเหมือนเดิมทุกอย่าง ยกเว้นส่วนที่เพิ่มเข้ามา: `GET /api/v1` มี `auth: "none"`
  และ `testnet: {enabled: false}`, op `me` ตอบผู้เล่นในเครื่อง (`local`), op ของ testnet ตอบรูปแบบ "ปิดอยู่",
  op ที่มีเฉพาะโหมด accounts ตอบ `404` พร้อม `code: "accounts_disabled"` และ `bot_create` ที่ขอ `venue: "testnet"` ตอบ
  `409` พร้อม `code: "testnet_needs_accounts"` (โหมด accounts ดู[สรุปด้านบน](#api-ในโหมด-accounts-สรุป))
- error ทุกตัวมีรูป `{"error": "...", "status": <code>}` และใช้ HTTP status เดียวกัน:

| status | เมื่อไร |
|---|---|
| `400` | พารามิเตอร์ผิด: ไม่รู้จักชื่อ, ชนิดผิด, ไม่อยู่ใน enum, เกินช่วง, ขาดตัวที่ required หรือ JSON เสีย |
| `401` | command ไม่ผ่าน auth |
| `404` | ไม่มี op, bean หรือ bot นั้น |
| `405` | ใช้ method ผิด |
| `409` | live layer ปฏิเสธ หรือ `tick` ขณะใช้ราคาจริง |
| `413` | body ใหญ่เกิน 64 KB |

### Queries (GET, ไม่ต้องใช้ token)

| op | params | คืนค่า |
|---|---|---|
| `health` | – | `{ok, version, tick, bar_idx, beans, now_ms, market_time_ms, uptime_s, feed, prices, paper, feed_state, daemon:{running, tick_ms, aligned, next_tick_ms}}` |
| `status` | – | health + `{last_tick_duration_ms, feed:{source, coins, ok, error, stale, real, state, stale_coins, fallback, real_available, mids_ms, mids_age_ms, last_bar_close_ms, next_tick_ms, lag_bars, bar_sources, weight_60s, last_gap}, population}` |
| `meta` | – | `{archetypes, strategies, coins (รายการสดของ venue), scales, columns, sort_keys, events}` |
| `market` | – | `{market_time_ms, feed_ok, coins:[{coin, mid, px, px_ms, close, change_24h, change_1h, prev_day_px, funding_1h, mark_px, oracle_px, open_interest, day_ntl_vlm, source, bars, stale, max_leverage, sz_decimals, beans, positioned}]}` |
| `beans` | `archetype, busted, coin, strategy, in_position, tradeable, distinct_coin, trades_min, ids, sort (-fitness), limit (100, ≤1000), offset` | `{rows: BeanRow[], total, limit, offset, sort, venue:{known, network}}` |
| `bean_detail` | `id*` | `{bean, genome, describe, curve:[{h, equity}], trades (50 รายการล่าสุด)}` |
| `equity_curves` | `ids*` (≤ 50) | `{capital: 1000, curves: {"<id>": [{h, equity}]}}` |
| `bots` | `state` (`active\|paused\|closed\|open\|all`) | `{rows: BotRow[] (+ mark_px, mark_ms, price_stale), total, mode: "sim"}` |
| `bot_detail` | `id*` | `{bot, bean, fills, orders}` |
| `live_status` | – | mode/armed/halted, จำนวน bot, deployed, notional, PnL, caps, `account_state`, `universe`, `prices`, `paper`, `stale_coins` |
| `live_fills` | `bot, limit (100)` | `{rows: Fill[], total}` เรียงใหม่ไปเก่า |
| `events` | `kind, limit (100), offset` | `{rows, total}` เรียงใหม่ไปเก่า (ไม่มี `mids`) |

### Commands (POST)

| op | body | คืนค่า |
|---|---|---|
| `bot_create` | `bean*` (integer), `capital_usd*` (number), `confirm` (ไม่ใช้) | BotRow (mirror ทันทีที่ราคาล่าสุด) |
| `bot_pause` / `bot_resume` / `bot_close` | `id*` (`"bot-0000"` หรือเลข index) | BotRow |
| `bots_halt` | – | `{halted: true, closed: [ids], realized_pnl}` |
| `tick` | `n` (1..1440, ค่าเริ่มต้น 1) | tick summary ล่าสุด — **เฉพาะ `--feed sim`** ราคาจริงตอบ `409` เสมอ |

`bot_create` จะตอบ `409` เมื่อระบบ halted, bean ไม่ tradeable (เหตุผลใน `venue_reason`), มี bot ครบ `max_bots`,
เงินสดไม่พอ หรือ notional รวมจะเกินเพดาน ถ้า `capital_usd` อยู่นอกช่วง 20–1000 จะได้ `400`

### SSE: `GET /api/v1/events/stream`

- สิ่งแรกที่ส่งออกไปทันทีคือ `retry: 3000` ตามด้วย `: hello` และ `: ping` ทุก 15 วินาที
- journal record 1 ตัว = 1 message `id: <seq>` / `event: <kind>` / `data: <json>` รองรับ `Last-Event-ID` เพื่อส่งที่พลาดซ้ำ
- **`mids` เป็น event ชั่วคราว**: ส่งทุก ~5 วินาที (ราคาจริง) และหลังทุก tick (ทั้งสอง feed) **ไม่มีบรรทัด `id:`**
  ไม่ถูกบันทึกลง journal และไม่ถูกส่งซ้ำ

| kind | ฟิลด์ (นอกจาก `seq, t, kind`) |
|---|---|
| `warmup_finished` | `bars, ms` |
| `tick_completed` | `tick, bar, time_ms, dur_ms, fills, busted, exits{…}, closed_ms, next_tick_ms, source` |
| `busted` | `bean, archetype, coin, equity` |
| `bot_created` | `bot, bean, coin, capital_usd, leverage` |
| `bot_order` | `bot, coin, order_kind (mirror\|flatten), sz, px, status (filled\|skipped), reason` |
| `bot_fill` | `bot, coin, dir, sz, px, fee, closed_pnl, time_ms, tick, liquidation?` |
| `bot_paused` / `bot_resumed` | `bot, reason` (`manual`, `bean busted`, `liquidated`) / `bot` |
| `bot_closed` | `bot, realized_pnl` |
| `live_error` | `bot, error` |
| `live_halted` | `closed` |
| `daemon_started` | `pid, version` |
| `feed_status` | `state (live\|delayed\|down\|sim), prev, source, stale_coins, lag_bars, error, fallback` |
| `feed_gap` | `from_ms, to_ms, bars, mode (replay\|rewarm), reason (restart\|outage)` |
| `mids` *(ไม่มี id)* | `t, source, prices, px{coin}, stale, bar{tick, time_ms, next_tick_ms}, bots{id: {szi, entry_px, mark_px, unrealized_pnl, realized_pnl, margin_used, liquidation_px, notional_usd, price_stale, as_of_ms}}, account{…}` |

ตัวอย่างการเรียกด้วย curl:

```sh
curl -s http://127.0.0.1:8420/api/v1/health
curl -s "http://127.0.0.1:8420/api/v1/beans?tradeable=true&distinct_coin=true&busted=false&trades_min=1&limit=5&sort=-total_return"
curl -s -X POST -H "Content-Type: application/json" -d '{"bean":688,"capital_usd":100}' http://127.0.0.1:8420/api/v1/bot_create
curl -s -N http://127.0.0.1:8420/api/v1/events/stream
```

---

## โมเดลความปลอดภัย

**query เปิดให้ทุกคนเสมอ** แต่ค่าเริ่มต้นของ server bind ที่ `127.0.0.1` จึงเรียกได้เฉพาะจากเครื่องตัวเอง
ถ้าเปิด `--host 0.0.0.0` ทุกคนในเครือข่ายจะอ่านข้อมูลทั้งหมดได้ ส่วน command ยังถูกจำกัดตามกฎด้านล่าง

**command** จะผ่านเมื่อเข้ากฎข้อใดข้อหนึ่ง:

1. **มี token ที่ถูกต้อง** ส่งมาใน `Authorization: Bearer <T>` หรือ `X-Brood-Token: <T>` ผ่านได้จากทุกที่
   - token มาจาก `--token` หรือ env `BEAN_API_TOKEN` ต้องเป็น ASCII ที่มองเห็นได้ ไม่มีช่องว่าง และยาวอย่างน้อย 16 ตัว
     (เบราว์เซอร์ส่งอักขระอื่นใน header ไม่ได้) สร้างได้ด้วย `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`
   - ถ้าส่งมาทั้งสอง header ระบบจะตรวจทั้งคู่ ดังนั้น `Authorization` ที่ proxy ใส่มาเองจะไม่บัง `X-Brood-Token` ที่ถูกต้อง
   - การเทียบ token เป็นแบบ constant-time โดย hash ด้วย SHA-256 ก่อนแล้วจึงใช้ `timingSafeEqual`
2. **ถ้าไม่มี token** request ต้องผ่าน**ทุกข้อ**ต่อไปนี้:
   - remote address เป็น loopback (`127.x`, `::1`)
   - ไม่มี proxy header ใด ๆ (`X-Forwarded-For`, `CF-Connecting-IP`, `X-Real-IP`, `Forwarded`, `X-Forwarded-Host`, `X-Forwarded-Proto`)
   - header `Host` เป็น `localhost`, `127.0.0.1` หรือ `[::1]` (มีพอร์ตต่อท้ายได้) เพื่อกัน DNS rebinding
   - ไม่มี header `Origin` หรือ `Origin` ตรงกับ origin ของ request เอง เพื่อกัน CSRF
3. นอกนั้นได้ `401 {"error":"command needs a token (or a same-origin request from loopback)"}`

> **ก่อนเปิดพอร์ตผ่าน tunnel หรือ port-forward ใด ๆ (`ssh -R`, `socat`, ngrok, cloudflared …) ให้ตั้ง `--token` และ `--no-loopback-commands`**
> กฎข้อ 2 เชื่อ address ของ socket ส่วน TCP forwarder ธรรมดาทำให้ client ระยะไกลดูเหมือนมาจาก `127.0.0.1`
> และเลือก header `Host: localhost` เองได้ จึงผ่านกฎข้อ 2 โดยไม่ต้องมี token
> (cloudflared และ ngrok ยังโดนบล็อกเพราะใส่ `Cf-Connecting-Ip` หรือ `X-Forwarded-For` แต่ forwarder ทั่วไปไม่ใส่)
> `--no-loopback-commands` ปิดกฎข้อ 2 ทั้งหมด และ server จะพิมพ์คำเตือนนี้ตอนเริ่มทุกครั้งที่กฎข้อ 2 ยังเปิดอยู่

**ทำไมเข้มกว่า brood:**

- **brood มีช่อง CSRF**: ยกเว้น loopback ทั้งหมดและตอบ `Access-Control-Allow-Origin: *` เว็บไซต์ใดก็ได้ในเบราว์เซอร์ของผู้ใช้
  จึง `POST` ไปที่ `http://127.0.0.1:<port>` เพื่อเปิดหรือปิด bot ได้ ของเราตรวจ `Origin` และ `Host` ด้วย
  ส่วน client ข้าม origin ที่ถือ token ยังใช้งานได้ เพราะ preflight อนุญาต `Authorization`, `X-Brood-Token` และ `Content-Type`
- **brood รับ token ทาง `?token=T` ใน URL** แต่ server ของเรารับ token ทาง header เท่านั้น
- **ฝั่งหน้าเว็บ (`web/js/brood-api.js`, ใช้ทั้งหน้า 3D และ classic)**:
  - `?token=` ถูกเก็บลง `localStorage` แล้ว **ลบออกจาก address bar ทันที** ด้วย `history.replaceState` (หน้า 3D ทำใน `boot.js`
    ก่อนโหลดอย่างอื่น และไม่ส่งต่อตอนพาไปหน้า classic)
  - token แยก**ช่องเก็บตาม origin ของ API**: `localStorage["brood.token"]` สำหรับ server ที่ส่งหน้านี้มา และ `brood.token@<origin>` สำหรับ origin อื่น
  - ถ้าลิงก์ใส่ `?api=` ที่ชี้ไป**origin อื่น** API นั้นถือว่า "ไม่น่าไว้ใจ": token ที่บันทึกไว้ไม่ถูกส่งไป, `?token=` ในลิงก์ถูกลบแต่ไม่ถูกใช้
    และถ้าผู้ใช้พิมพ์ token เอง หน้าเว็บจะถามยืนยันพร้อมแสดง host ปลายทางก่อนบันทึก
  - `?api=` มีผลเฉพาะการโหลดหน้าครั้งนั้น รับเฉพาะ `http(s)` หรือ path บน origin เดียวกัน และปฏิเสธค่าที่มี `\`
  - ค่าที่มาจาก server ทุกค่าเข้า DOM ผ่าน `textContent` หรือ attribute เท่านั้น ไม่มี `innerHTML`, `eval` หรือ inline handler
    และตำแหน่งที่เปลี่ยนตลอดเวลา (ป้ายบนแปลง) ใช้ CSSOM (`el.style.transform`) ไม่ใช่ attribute `style`
- **static file** ทุกไฟล์ส่ง `X-Frame-Options: DENY` + `frame-ancestors 'none'`, `Content-Security-Policy` ที่อนุญาตเฉพาะ script
  และ style จากไฟล์ของเราเอง (`script-src 'self'`: ไม่มี inline, `eval` หรือ import map), `Referrer-Policy: no-referrer`
  และ `X-Content-Type-Options: nosniff`
  - three.js โหลดจาก origin เดียวกันที่ `/vendor/three/*` ผ่าน shim ไฟล์เดียว (`web/js/game/three.js`) จึงไม่ต้องแก้ CSP
  - `/vendor/three/` ส่งได้เฉพาะ 3 ไฟล์ที่กำหนด (`build/three.module.min.js`, `build/three.module.js`, `LICENSE`)
- **path traversal ถูกบล็อก** ทั้งแบบตรง ๆ, แบบ encode (`%2e%2e`, `%2f`, `%5c`), dotfile, ชื่อ drive หรือ stream ของ Windows
  และ symlink ที่ชี้ออกนอกโฟลเดอร์ (ตรวจซ้ำบน path จริงหลัง `realpath` เพราะ NTFS มีชื่อสั้นแบบ 8.3 เช่น `ENV~1`)
- body ของ command จำกัดที่ 64 KB และ server log ไม่พิมพ์ token ออกมาเด็ดขาด
- **การเชื่อมต่อ Hyperliquid mainnet** เป็นแบบอ่านอย่างเดียว: endpoint เดียว (`/info`) ไม่มี key และไม่มีโค้ดที่ส่ง order บน mainnet ได้

### เพิ่มเติมในโหมด accounts

- **คุกกี้ session** เป็น `__Host-bean_sid` (Secure, HttpOnly, SameSite=Lax, ไม่มี Domain) ฝั่ง server เก็บเพียง SHA-256 ของ token
  อายุ 30 วัน (ไม่ใช้งาน 7 วันหมดอายุ) และหมุน token ใหม่ทุก 24 ชั่วโมง ทุกการเพิกถอน (ออกจากระบบ, ออกทุกเครื่อง, เปลี่ยนรหัสผ่าน,
  รีเซ็ต, ผู้ดูแลปิดบัญชี, ลบบัญชี) ปิด SSE ของ session นั้นใน tick เดียวกัน
- **รหัสผ่าน** hash ด้วย scrypt (N=32768, r=8, p=3) ปฏิเสธรหัสที่พบบ่อยและรหัสที่มีชื่อผู้ใช้ ล็อกชื่อผู้ใช้ชั่วคราวหลังผิด 5 ครั้ง
  (อุปกรณ์ที่เคยเข้าสำเร็จได้รับยกเว้น) และชื่อที่ไม่มีอยู่จริงก็เสียเวลา scrypt เท่ากัน
- **ไม่มี CORS** สำหรับ op ของผู้เล่น, command และ SSE (เปิด `*` เฉพาะ query สาธารณะ) หน้าเว็บและ API ต้องอยู่ origin เดียวกัน
  (`?api=` ไปที่อื่นถูกเพิกเฉย และ token ของโหมด none ไม่ถูกใช้)
- **บันทึกตรวจสอบ (audit log)** เก็บการสมัคร, เข้าสู่ระบบ, การเชื่อม testnet, การกระทำของผู้ดูแล ฯลฯ โดยเก็บ IP แบบ HMAC
  และชื่อผู้ใช้ที่ไม่มีอยู่จริงแบบ HMAC (ไม่เก็บสิ่งที่พิมพ์ เพราะคนชอบพิมพ์รหัสผ่านลงช่องชื่อ)
- ผู้ดูแล**อ่าน key, เซ็นแทน, ปลูกหรือปิด bot แทน, อ่าน event หรือ fill ของผู้เล่นไม่ได้** (ไม่มี op สำหรับสิ่งเหล่านี้)
  แต่ผู้ที่คุม server (shell, env, ฐานข้อมูล) ใช้ key testnet ที่เก็บไว้เทรดบัญชี testnet นั้นได้ในทางเทคนิค
  ซึ่งรับได้เพราะเป็น testnet และ agent ถอนเงินไม่ได้ (เหตุผลที่ key ของ mainnet ถูกปฏิเสธ)

---

## โครงสร้างโปรเจกต์

```
package.json            scripts: start / sim / dev / fresh / accounts* / keygen / admin / test ; dependency 4 ตัว (pin ตายตัว)
PLATFORM.md             สัญญาของการอัปเกรดแพลตฟอร์ม (บัญชี, หลายผู้เล่น, testnet)
GAME-DESIGN.md          สัญญาของเกม 3 มิติ (ชนะ SPEC ในเรื่องที่ระบุ)
SPEC.md                 สัญญาของ backend และ API
render.yaml             Render Blueprint (โหมด accounts บนแพ็กเกจฟรี + Supabase Storage; deploy/render/README.md)
server/
  main.js               CLI: config → wiring → restore / replay / warm-up → bar loop → listen → save
  http.js               HTTP: static, /vendor/three, /api/v1 router, auth ทั้งสองโหมด, SSE (journal + pulse, แยกตามผู้เล่น),
                        /healthz /readyz, header ความปลอดภัย, /docs
  catalog.js            op catalogue: ชื่อ, ชนิด, params, สิทธิ์, คำอธิบาย, event kinds, ERROR_CODES, docsMarkdown
  config.js             flag และ env ของโหมด accounts (ตรวจแบบเข้มงวด, ตัวแปรลับแบบ *_FILE)
  auth/                 users, passwords (scrypt), sessions, csrf, ratelimit, clientip, service (ขั้นตอนสมัคร/เข้าสู่ระบบ)
  db/                   SQLite (node:sqlite): เปิดไฟล์, migration, retention, backup
  secrets.js            การเข้ารหัส key ของ testnet (AES-256-GCM), HMAC ของ audit, log sanitizer
  admin.js / admin-cli.js  บริการผู้ดูแล (kill switch, caps, audit) และ CLI ของผู้ดูแล
  hl/                   Hyperliquid TESTNET: info, market, ตัวเซ็น (testnet เท่านั้น), exchange, verify, egress guard
  garden/               Gardens (สวนของผู้เล่นทุกคน), repo, credentials, testnet venue
  engine.js             Engine: bar loop (นาทีจริง / sim), warm-up, replay, re-warm, health/status
  market.js             COINS + MarketFeed: bar, live mids, stale coin, rate ledger
  hyperliquid.js        client อ่านอย่างเดียวของ Hyperliquid info API (fetch และนาฬิกา inject ได้)
  pulse.js              broadcast ชั่วคราวสำหรับ `mids` (ไม่บันทึก ไม่มี id)
  strategies.js         signal ทั้ง 5 แบบ + series ต่อ coin
  population.js         ARCHETYPES + Population: genome, paper trading, metrics, query
  live.js               LiveLayer: exchange จำลอง, bot mirror, marks + liquidation บนราคาสด, caps
  journal.js            Journal: event bus, ring buffer, jsonl
  store.js              saveState / loadState แบบ atomic
  cloudstore.js         client ของ Supabase Storage REST (ไม่มี dependency) สำหรับโฮสต์ที่ดิสก์หาย (Render ฟรี)
  cloudsync.js          กู้คืนตอนบูต, sync DB/state, lease, ประวัติรายชั่วโมง, คุมโควตาอัปโหลดรายเดือน
deploy/render/README.md คู่มือ Render ฟรี + Supabase Storage (ภาษาไทย)
web/
  index.html            เกม 3 มิติ: HUD, ช่องต่าง ๆ, <script type="module" src="/js/game/boot.js">
  classic.html          เกม 2D เดิม (ย้ายมาจาก index.html) + ลิงก์กลับไปหน้า 3D
  css/game.css          สไตล์ทั้งหมดของหน้า 3D (token สี, responsive, ชิป, ป้ายลอย)
  css/garden.css        สไตล์ของหน้า classic
  img/icons.svg         SVG sprite ของไอคอน (รวมไอคอนพืชครบ 16 coin)
  js/brood-api.js       client contract: โหมดของ server, base URL, token, คุกกี้, query, command, stream, restream, auth
  js/format.js          esc / fmt / pct / usd / signClass / ago
  js/i18n.js            ข้อความ EN + TH
  js/plant.js           สูตรการเติบโต stage() และตัววาด canvas ของหน้า classic
  js/model.js           helper pure ที่ใช้ร่วมกันทั้งสองหน้า: shelfQuery, mirrorNote, stakeRoom, fmtPx, plantQuote, closeQuote, windOf…
  js/garden.js          logic ของหน้า classic (re-export helper จาก model.js)
  js/game/
    boot.js             ตรวจ WebGL2 + ไฟล์ engine แล้ว import main.js หรือพาไปหน้า classic
    main.js             wiring: store, data, UI, views → director → effects, input map, focus, safe area
    three.js            shim ตัวเดียวที่ import three
    stage.js            สร้าง renderer, loop, กล้อง, picking, labels แล้วโหลด world / field / executor
    core/               store, bus, data (polling + SSE + commands), view, rules, settings  — pure
    fx/                 director.js (pure reducer), executor, particles, coins, floaters
    gfx/                renderer, loop, tiers, camera, picking, labels, tween, post, materials, geom, palette
    world/              เกาะ, landmark, ฟ้า, อากาศ, ชาวนา, สัตว์
    crops/              แคตตาล็อกพืช 16 ชนิด + builder แบบ procedural 9 แบบ
    field/              กระบะปลูก, FSM ของแปลง, ป้ายและอุปกรณ์บนแปลง
    ui/                 HUD, ป้าย, ticker, dock, แผงเมล็ด, หน้าต่างปลูก, inspector, ยืนยัน, บันทึก, settings, tour…
    audio/              เสียง procedural ด้วย WebAudio (ค่าเริ่มต้นปิด)
test/
  engine.test.js        ตลาด, strategy, การเทรดกระดาษ, metric, query, determinism, ประสิทธิภาพ
  live.test.js          journal, store, live layer, marks และ liquidation บนราคาสด
  api.test.js           HTTP กับ engine, live, journal และ pulse ตัวจริง (โหมด none)
  api-accounts.test.js  HTTP โหมด accounts กับโมดูลแพลตฟอร์มตัวจริง: CSRF, Host, query string, session, การแยกผู้เล่น,
                        SSE (แยกผู้เล่น, เพดาน, buffer, session_ended), ผู้ดูแล, rate limit, testnet แบบ cache-only, การ parse --auth
  web-accounts.test.js  brood-api และ data/store ของโหมด accounts (โหมด, คุกกี้, auth:required, restream, slot ต่อผู้เล่น)
  auth / csrf / db / secrets / hl-* / mainnet-guard / multiuser / testnet-live .test.js   เทสต์ของแต่ละแพ็กเกจแพลตฟอร์ม
  feed.test.js          feed ราคาจริงแบบ offline (fetch และนาฬิกาจำลอง): bar ตามนาที, stale, down, replay, re-warm, rate ledger
  cloud.test.js         cloud persistence กับ Supabase Storage จำลองในเครื่อง: restore, lease, sync, history, egress guard,
                        replay guard, config ของ Render (ไม่ติดต่อ Supabase หรือ Render จริง)
  cloud-egress.test.js  จำลอง 24 ชม. ของ sync จริง: ปริมาณอัปโหลดต่อเดือนต้องอยู่ในงบ
  web.test.js           โมดูลของหน้า classic (format, i18n, brood-api, plant, helper ของ garden)
  game.test.js          core ของหน้า 3D: view, rules, director, model, data, settings, tween, tiers, กล้อง, labels, loop
  game-world.test.js    คณิตของโลก: ผังเกาะ, ลม, กังหันลม, ระดับน้ำ, ฟ้าผ่า, เส้นทางของชาวนา, store → world
  game-crops.test.js    แคตตาล็อกพืช 16 coin + beanstalk, ตารางสถานะ §3.5, FSM ของแปลง, ข้อความป้ายลอย,
                        สร้างพืชทั้ง 17 ชนิดแบบ headless และรัน effect ครบ 35 แบบ (ถอนไม่มีเหรียญ)
  game-ui.test.js       HTML ไม่มี inline script/style/handler, key ของ i18n ครบ, sprite ครบ, ป้ายโหมด, ข้อความเงิน
  fixtures/             ข้อมูลจริงที่บันทึกไว้ของ Hyperliquid และ payload ตัวอย่าง (เทสต์ไม่ใช้เครือข่าย)
data/                   state ตอนรัน (อยู่ใน .gitignore)
```

---

## เทสต์

```sh
npm test        # node --test "test/*.test.js"
```

> บน Node ≥ 22 คำสั่ง `node --test test/` (ส่งชื่อโฟลเดอร์ตรง ๆ) ใช้ไม่ได้ จึงต้องใช้ glob แบบใน `package.json`

ทุกเทสต์ทำงาน **offline**: feed ราคาจริงทดสอบด้วย `fetch` และนาฬิกาที่ inject เข้าไป และ fixture ใน `test/fixtures/`
ส่วนหน้า 3D ทดสอบได้ใน Node เพราะ logic ทั้งหมด (view, rules, director, data, กล้อง, tier, loop) ไม่ import three และไม่แตะ DOM ตอน import

ปัจจุบันมี **302 เทสต์ ผ่านทั้งหมด** (152 ตัวเดิม + ของใหม่):

| ไฟล์ | จำนวน | ไฟล์ | จำนวน |
|---|---|---|---|
| `api.test.js` | 47 | `game.test.js` | 45 |
| `engine.test.js` | 46 | `game-world.test.js` | 26 |
| `live.test.js` | 52 | `game-crops.test.js` | 21 (ส่วนที่สร้าง mesh ต้องใช้ Node ≥ 22.15 เพราะใช้ `module.registerHooks` ถ้าต่ำกว่านั้นจะ skip) |
| `feed.test.js` | 22 | `game-ui.test.js` | 23 |
| `web.test.js` | 20 | | |

`test/game.test.js` ครอบคลุม (GAME-DESIGN §11.4):

- `plotView` ให้ size/health/fruit/flower เท่ากับ `stage()` ของ bot ที่รวมตัวเลขล่าสุดแล้ว และใช้ mark ของ server เฉพาะเมื่อ**ใหม่กว่า**
  ไม่เช่นนั้นใช้ค่าประมาณ `≈ szi·(px − entry)` พร้อม flag
- `liqInfo`: long 10× เข้าที่ 82,410.0 → liquidate ที่ 74,581.05 และห่าง 10.12% เมื่อ mark 82,980.5 (+ กรณี short และแถบ warn/danger)
- `fmtPx` / `fmtSz`, เกณฑ์อายุตัวเลข, ตารางป้ายโหมดทั้งหมด (real, delayed, coin ล่าช้า, down, sim, offline)
- `assignSlots` คงที่เมื่อปิดแปลงและ reload, และให้แปลงที่เลือกในหน้าต่างปลูกชนะเมื่อว่าง
- `coinBurst`, `levTier`, `assertEffect` (J4/J5/J6/J11)
- director: ขาดทุน = ถอนโดยไม่มีเหรียญ, ไม่มี `plantOk` ก่อน 2xx หรือ echo, รวม fill ใน 400 ms, ตรวจจับการกลับทิศ (flip),
  fill ที่เล่นย้อนไม่มีแอนิเมชัน, เผาไร่เรียงตามแปลงห่างกัน 250 ms ด้วยตัวเลขของแต่ละแปลง, ผลที่งอกคืนใน 10 วินาทีเล่นแบบเงียบ,
  effect ตอนเข้าสถานะ (สุก, เหี่ยว, ใกล้ตาย, ใกล้ liquidate) เล่นได้ครั้งเดียวต่อแปลงใน 30 วินาที แม้ต้นไม้แกว่งไปมาข้ามเกณฑ์
- settings ตอน `localStorage` throw, data layer กับ API จำลอง (offline backoff 2 → 4 วินาที, ลำดับ cmd:pending → cmd:done,
  การรวม close เข้ากับการเผาไร่, mids และ gust), tween/สปริง, tier และ governor, คณิตของกล้องและ safe area, labels, โหมดของ loop

---

## ความต่างจาก brood ต้นฉบับ

| เรื่อง | brood | Bean Garden (โปรเจกต์นี้) |
|---|---|---|
| ภาษาและ runtime | Rust | Node.js ≥ 22, ES modules, dependency เดียวคือ three (ฝั่งเบราว์เซอร์) |
| ประชากร | 963,030 bean, 13 archetype | 3000 bean (ปรับด้วย `--beans`), 9 archetype แบบ algo |
| LLM bean | มี (`llm`/`hybrid`) | **ไม่มี LLM** ทุก bean เป็น `mode: "algo"` |
| epoch, `promote_ok`, replay, farm | มี | ไม่มี (garden ไม่ได้ใช้) |
| ราคา | perp จริงของ Hyperliquid | **ราคาจริงของ Hyperliquid แบบอ่านอย่างเดียว** (ค่าเริ่มต้น) หรือ GBM สังเคราะห์ด้วย `--feed sim` |
| bot | bot จริงบน Hyperliquid (testnet/mainnet) | **exchange จำลอง** (`mode: "sim"`) fill IOC ที่ราคาสด ± 1.5 bp และ fee 4.5 bp — ไม่มีเงินจริง; โหมด accounts เพิ่ม bot บน **testnet เท่านั้น** ด้วย API wallet ของผู้เล่น (mainnet ทำไม่ได้โดยโครงสร้าง) |
| ชื่อ event ของ SSE | หน้าเกมฟัง `bot_fill` แต่ server บันทึกเป็น `live_fill`/`live_order` | ส่ง `bot_*`/`live_*` ตามที่หน้าเกมฟังจริง + `feed_status`, `feed_gap`, `mids` |
| SSE | ไม่มี `id:` หรือ `Last-Event-ID` | flush ทันที, `retry:`, ping ทุก 15 วินาที, `id: <seq>` และ replay ตาม `Last-Event-ID` |
| auth ของ command | ยกเว้น loopback + CORS `*` ทำให้เกิด CSRF ได้ และรับ `?token=` | โหมด none: loopback ต้องเป็น same-origin, ตรวจ Host และ proxy header, รับ token ทาง header เท่านั้น; โหมด accounts: session cookie + ตรวจ Origin/Host, ไม่รับ query string ใน command |
| `tick` command | ไม่มี | `tick {n}` เดินตลาดเร็ว เฉพาะราคาจำลอง |
| หน้าเกม | ของ brood (2D) | เกาะฟาร์ม 3 มิติเขียนเองทั้งหมด (three.js, procedural ล้วน ไม่มีไฟล์ภาพ) + หน้า classic 2D, มีภาษาไทย |

---

## เรื่องที่ควรรู้และงานที่ยังเปิดอยู่

- **ราคาจริงเดินด้วยความเร็วจริง:** 1 bar ต่อ 1 นาที และราคาสดทุก ~5 วินาที ต้นไม้จึงโตช้า (ตั้งใจ) ใช้ `npm run sim` หรือ
  `npm run dev` ถ้าต้องการเห็นการเปลี่ยนแปลงเร็ว และปุ่ม ⏩ +1h มีเฉพาะราคาจำลอง
- **ตัวเลขทุกตัวมีอายุ:** ≤ 15 วินาทีถือว่าสด, 15–60 วินาทีขึ้นป้าย `delayed`, เกิน 60 วินาทีขึ้น `stale` และต้นไม้หยุดนิ่ง
  อายุคิดจากนาฬิกาของ server (ชดเชยนาฬิกาเครื่องที่คลาดด้วย `health.now_ms`)
- **coin ที่ไม่มีราคา** (stale) ทำให้ bot ของ coin นั้นหยุดนิ่ง ไม่มีการ mirror และไม่เช็ก liquidation จนกว่าราคาจะกลับมา
  การปลูก coin นั้นถูกปิดไว้ระหว่างนั้น
- **หน้า 3D ต้องการ WebGL2** (three r169) เครื่องที่ไม่มีจะถูกพาไปหน้า classic ส่วนเครื่องที่ GPU ช้าจะเริ่มที่ tier ต่ำ
  และ governor จะลดคุณภาพลงอีกเมื่อจำเป็น (แจ้งด้วย toast)
- **การจัดอันดับ `-fitness` ค่าเริ่มต้นของ `beans`** อาจดัน bean ตระกูล hyper/degen ที่ขาดทุนหนักขึ้นมาบนสุด
  เพราะ `ann_return` ให้รางวัลกับความผันผวน garden ไม่ได้รับผลกระทบเพราะเรียงด้วย return, 7-day หรือ Sharpe
- **น้ำ (`capital_usd`) คือตัวย่อขนาดตาม bean ไม่ใช่เพดานการขาดทุน** ตามพฤติกรรมของ brood
  ถ้า bean โตจน `position_size × equity > 1000` margin ของ bot จะมากกว่าน้ำ และขาดทุนได้มากกว่าน้ำ
  หน้าต่างปลูกจึงแสดง "กรณีเลวร้ายที่สุด = margin ทั้งหมด" และบอกเมื่อมันมากกว่าน้ำ
- **เพดาน notional กันเฉพาะความเสี่ยงที่เพิ่มขึ้น** ถ้า bean กลับทิศแล้วขาเปิดใหม่ติดเพดาน bot ยังปิดฝั่งเดิมทันที แล้วรอเปิดฝั่งใหม่
  (ป้าย "cap" สีแดงขึ้นที่วาล์วของหอเก็บน้ำ)
- **ผลลัพธ์ของ sim deterministic แบบ bit-exact เฉพาะบน Node build เดียวกัน** เพราะ `Math.exp`/`Math.log` อาจต่างกันเล็กน้อยระหว่างแพลตฟอร์ม
- **เวลาใน sim นำหน้านาฬิกาจริง** (warm-up เริ่มที่นาทีปัจจุบันแล้วเดินไปข้างหน้า 2880 bar) เวลาใน fill และบันทึกของ sim จึงเป็นเวลาตลาด
  ส่วนราคาจริงใช้นาฬิกาจริงเสมอ
- **ขนาด JS ของหน้า 3D ยังเกินงบ** ใน GAME-DESIGN §9.9 (≤ 350 KB แบบไม่ minify): ตอนนี้ราว 1.07 MB ใน `web/js/game/` (+ `i18n.js` 88 KB)
  เพราะมีคอมเมนต์อธิบายเยอะและไม่มีขั้น build (ตั้งใจให้ไม่มี dependency เพิ่ม) ไฟล์ทั้งหมดเป็น ES module ที่ cache ได้
- **ตัดตาม cut list (P2):** ผึ้ง และหอยทากบนขอบกระบะ ยังไม่ได้ทำ
- **testnet เป็นทางเลือก:** เงินทดสอบต้องมาจาก faucet ที่จ่ายเฉพาะ address ที่เคยฝากบน mainnet (ดูด้านบน) และราคาบน testnet
  ต่างจากราคาจริงได้มาก ทั้งสองเรื่องนี้หน้าเว็บบอกตรง ๆ ก่อนปลูก
- **โหมด accounts รันได้ process เดียว** (SSE, SQLite และ nonce ของ testnet ต้องอยู่ใน process เดียว) ตัวเลขเป้าหมายและงบหน่วยความจำอยู่ใน PLATFORM §2.2, §4.5
- **พัฒนาหลายคนพร้อมกัน:** ให้แต่ละคนรัน server ของตัวเองด้วย `--data <โฟลเดอร์ชั่วคราว> --port <พอร์ต>` และใช้ `--feed sim`
  สำหรับงานหน้าเว็บ (เปิดราคาจริงทีละ server เพื่อไม่ให้กินงบ rate limit ของ Hyperliquid)
