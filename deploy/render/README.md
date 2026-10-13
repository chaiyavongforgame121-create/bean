# Bean Garden บน Render (ฟรี) + Supabase Storage — ไม่ใช้คอมของคุณเลย

เกมรันบน **Render** (แพ็กเกจฟรี) ส่วนฐานข้อมูลและสถานะของเกมถูกเก็บถาวรไว้ใน **bucket ส่วนตัวของ Supabase Storage**
คอมของคุณไม่ต้องเปิดทิ้งไว้ ไม่ต้องรันอะไร ทุกขั้นตอนข้างล่างทำผ่านหน้าเว็บ (Render, Supabase, GitHub) จากเบราว์เซอร์ไหนก็ได้

| รายการ | ค่า |
|---|---|
| โหมด | หลายผู้เล่น (accounts) · ราคาจริงจาก Hyperliquid (อ่านอย่างเดียว) · เทรดกระดาษ · testnet ปิด · ปิดรับสมัคร |
| URL | `https://bean-garden.onrender.com` (ถ้า Render ตั้งชื่ออื่นให้ ดูข้อ 3.4) |
| ไฟล์ตั้งค่า | `render.yaml` (Blueprint) ที่ root ของ repo |
| ที่เก็บข้อมูลถาวร | Supabase project `fshntnizfqnwsrllxmtz` → Storage → bucket `bean-garden` (**private**) |

---

## 1. ภาพรวม

```
 ผู้เล่น ──https──► Render edge (TLS) ──► คอนเทนเนอร์ Bean Garden (1 instance, ดิสก์ชั่วคราว)
                                              │  ตอนบูต: ดาวน์โหลด DB + state จาก bucket (ถ้าดิสก์ว่าง)
                                              │  ทุก 1 นาที: อัปโหลด DB (เฉพาะเมื่อมีการเปลี่ยนแปลง) + ต่ออายุ lease
                                              │  ทุก 2 ชั่วโมง: อัปโหลด state ของตลาด (ไฟล์ใหญ่สุด ~2.3 MB)
                                              │  ทุกชั่วโมง: สำเนาลง history/ (คัดลอกภายใน Supabase ไม่กินโควตา)
                                              │  ตอนถูกสั่งปิด (SIGTERM): อัปโหลดรอบสุดท้าย
                                              ▼
                                 Supabase Storage  bucket "bean-garden" (private)
                                   db/bean.db.gz · state/state-real.json.gz · history/YYYYMMDDHH/ (48 ชม.)
                                   lease.json · admin/admin-bootstrap.txt (เฉพาะตอนยังไม่มี admin)

 Supabase pg_cron ──ทุก 10 นาที──► GET https://bean-garden.onrender.com/healthz   (กัน Render ฟรีหลับ)
                  ──ทุก 10 นาที──► เขียนแถวเดียวในตาราง bean_keepalive           (กัน Supabase ฟรีถูก pause)
```

- **ดิสก์ของ Render ฟรีเป็นแบบชั่วคราว** หายทุกครั้งที่รีสตาร์ตหรือ deploy ใหม่ เซิร์ฟเวอร์จึงดึงข้อมูลกลับจาก bucket ก่อนเปิด
  ฐานข้อมูลทุกครั้ง ถ้าดาวน์โหลดไม่สำเร็จ (ที่ไม่ใช่ "ยังไม่มีไฟล์") **จะไม่ยอมเริ่มทำงาน** (exit 4) เพื่อไม่ให้เริ่มจากว่างเปล่า
  แล้วไปเขียนทับข้อมูลดีในคลาวด์ และถ้า bucket **เคยมีข้อมูลแล้ว** (มี `lease.json` ที่บอกว่าเคย sync, มี `history/` หรือมีไฟล์อีกตัว)
  แต่ Supabase ตอบว่า "ไม่พบ" `db/` หรือ `state/` ก็ไม่ยอมเริ่มเช่นกัน (กันคำตอบผิดพลาดชั่วคราวลบข้อมูลทิ้ง ดูข้อ 5 และ 8)
- **ไฟล์ในคลาวด์ถูกบีบอัด (gzip)** ฐานข้อมูลถูกคัดลอกด้วย online backup ของ SQLite (ได้สำเนาที่สอดคล้องกันเสมอ ไม่ใช่ไฟล์ที่กำลังเขียน)
  สำเนารายชั่วโมงใน `history/` ใช้คำสั่ง copy ของ Supabase เอง จึงไม่กินโควตาอัปโหลดของ Render
- **lease.json** กำหนดว่า instance ไหนมีสิทธิ์อัปโหลด: instance ใหม่ยึด lease หลังเปิดรับ request ได้ และต่ออายุทุกนาที
  instance เก่าเห็นว่าไม่ใช่ของตัวเองก็หยุดอัปโหลดและ "รอสำรอง" (standby) ถ้าเจ้าของ lease เงียบไปนาน (ไม่ต่ออายุ 3 รอบ + 1 นาที เช่น
  deploy ใหม่ล่มกลางทาง) ตัวที่ยังรับผู้เล่นอยู่จะ**ยึดกลับเอง**แล้วอัปโหลดข้อมูลของตัวเองทั้งชุด จึงไม่มีทางที่ instance ที่ยังทำงานอยู่จะเลิก sync ไปเฉย ๆ
- **ตลาดย้อนหลังไม่ทำให้เกิดเทรดผี:** state ของตลาดในคลาวด์อาจเก่ากว่าฐานข้อมูลได้ถึง ~2 ชั่วโมง ตอนบูตเกมเติมแท่งราคาที่ขาดจาก
  Hyperliquid เอง และ bot ของผู้เล่น**ข้ามแท่งที่เคยเทรดไปแล้ว** (บันทึก `[live] garden N: skipped K replayed bar(s) …`) ไม่มีการเทรดซ้ำ
- **รหัสลับไม่เคยลง log** (ทั้ง service key และโค้ด admin) และ bucket ต้องเป็น private เสมอ ถ้าเป็น public เซิร์ฟเวอร์ไม่ยอมเริ่ม
  และถ้าถูกเปลี่ยนเป็น public ระหว่างทำงาน (ตรวจทุกชั่วโมง) จะหยุดอัปโหลดทันทีพร้อม ALERT
- เซิร์ฟเวอร์ติดต่อออกไปได้แค่ Hyperliquid `/info` และ `<SUPABASE_URL>/storage/v1/…` เท่านั้น (egress guard) path อื่นของ
  Supabase เช่น `/rest/v1`, `/auth/v1` ถูกบล็อก

## 2. ข้อจำกัดที่ควรรู้

| เรื่อง | รายละเอียด |
|---|---|
| ชั่วโมงฟรีของ Render | 750 ชม./เดือน ต่อ workspace ≈ บริการเดียวรัน 24/7 (เดือนละ 720–744 ชม.) อย่าเปิดบริการฟรีตัวอื่นพร้อมกัน |
| **ปริมาณข้อมูลขาออกของ Render** | workspace ฟรี (Hobby) ได้ **5 GB/เดือน** นับ**ทุกอย่าง**ที่ออกจาก Render: หน้าเว็บและ stream ราคาที่ส่งให้ผู้เล่น + การอัปโหลดไป Supabase ถ้าเกิน**และไม่ได้ผูกบัตร Render จะปิดบริการทั้ง workspace จนถึงต้นเดือนถัดไป** (ถ้าผูกบัตร ส่วนเกินคิดเงินตามราคาในหน้า Billing แทน) |
| งบอัปโหลดของเกม | การ sync ใช้ราว 2.2 GB/เดือน (จำลอง 24 ชม.: state ~2.4 MB ทุก 2 ชม. + DB ~24 KB ทุกนาทีที่มีคนเล่น) และ**คุมตัวเองไม่ให้เกิน `CLOUD_EGRESS_BUDGET_MB` (3072 MB/เดือน)** ถ้าเร็วกว่ากำหนดจะเว้นระยะอัปโหลด DB ห่างขึ้น (log `ALERT egress … behind` ถ้าห่างเกิน 15 นาที) ที่เหลือ (~2–2.8 GB) เป็นของผู้เล่น ดูยอดได้ที่ Render → Billing → Usage (Outbound bandwidth) และ `admin_status` → `cloud.month_bytes` / `month_projected_bytes` ถ้าผู้เล่นใช้เยอะ ให้ลด `CLOUD_EGRESS_BUDGET_MB` (เช่น 2048) ใน `render.yaml` |
| เครื่อง | RAM 512 MB, CPU 0.1 (วัดบนพีซีด้วยราคาจริง 3000 beans ใช้ RAM ราว 70 MB) การสมัคร/ล็อกอิน (scrypt) และการบูตจะช้ากว่าบนพีซี (บูตราว 10–15 วินาที) |
| หลับเมื่อไม่มีคนเข้า | Render ฟรีหลับหลัง 15 นาทีที่ไม่มี request เข้า → ตั้ง pg_cron ข้อ 3.5 ถ้าหลับไปแล้ว คนแรกที่เข้าจะรอ ~1 นาที |
| IP ขาออกใช้ร่วมกัน | Render ฟรีใช้ IP ขาออกร่วมกับบริการอื่น อาจโดน rate limit ของ Hyperliquid บ้าง (ป้ายราคาจะบอกสถานะ) ถ้าโดนตอนบูตครั้งแรกจนดึงราคาย้อนหลังไม่ได้ เซิร์ฟเวอร์จะ exit 1 ให้ Render ลองใหม่ (ไม่สลับไปใช้ราคาจำลอง เพราะบัญชีผู้เล่นจะไปอยู่คนละไฟล์) |
| ข้อมูลหายได้แค่ไหน: เครื่องล่ม | การกระทำของผู้เล่น ≤ 1 นาทีล่าสุด (นานกว่านั้นเฉพาะตอนที่ระบบเว้นระยะเพราะงบอัปโหลด) state ของตลาดอาจเก่าถึง ~2 ชม. แต่ไม่เสียหาย (ข้อ 1) |
| ข้อมูลหายได้แค่ไหน: deploy | ทุก commit ที่แก้ `server/`, `web/`, `package*.json`, `Dockerfile` หรือ `render.yaml` จะ deploy ใหม่ (แก้แค่เอกสาร/เทสต์ไม่ deploy) สิ่งที่ผู้เล่นทำบนตัวเก่าระหว่างที่ตัวใหม่กำลังบูต (ปกติ 1–3 นาที) จะหาย ควร push ตอนคนน้อย |
| Supabase ฟรี | Storage 1 GB (เราใช้ราว 100–150 MB รวม history 48 ชม.) · โปรเจกต์ที่ไม่มี**การใช้งานฐานข้อมูล** 7 วันจะถูก pause — งาน pg_cron ข้อ 3.5 เขียนตารางทุก 10 นาทีเพื่อกันเรื่องนี้ แต่ถ้า Supabase ส่งอีเมลเตือนให้กด restore ทันที (ถ้าถูก pause เซิร์ฟเวอร์จะบูตไม่ได้: exit 4) |
| instance เดียวเท่านั้น | ห้ามเพิ่ม instance และห้ามมีบริการที่สองใช้ bucket เดียวกัน (เกม, SQLite และ lease ออกแบบมาสำหรับ process เดียว) |

## 3. ตั้งค่าครั้งเดียว

### 3.1 Supabase: เอา service key

1. เข้า <https://supabase.com/dashboard> → เลือกโปรเจกต์ `fshntnizfqnwsrllxmtz`
2. **Project Settings → API Keys** แล้วเลือกอย่างใดอย่างหนึ่ง
   - แท็บ **Secret keys**: กด **Create new secret key** (ชื่อเช่น `bean-garden-render`) แล้วคัดลอก (`sb_secret_…`) — **แนะนำ**
     เพราะเปลี่ยน/ลบทีละตัวได้ (ข้อ 6)
   - หรือแท็บ **Legacy API Keys** → `service_role` → Reveal → คัดลอก (ขึ้นต้นด้วย `eyJ…`)
3. **ห้ามใช้** `anon` / `publishable` key และ**ห้ามวาง service key ลงในไฟล์ใด ๆ ของ repo** (repo เป็น public) key นี้มีสิทธิ์เต็มต่อโปรเจกต์
4. bucket `bean-garden` **ไม่ต้องสร้างเอง** เซิร์ฟเวอร์สร้างให้แบบ private ตอนบูตครั้งแรก (ถ้าอยากสร้างเอง: Storage → New bucket →
   ชื่อ `bean-garden` → **ปิด** Public bucket)
5. **ตรวจ policy ของ Storage (สำคัญ):** bucket แบบ private ยังเปิดให้คนนอกอ่านได้ถ้าโปรเจกต์มี policy ที่ให้สิทธิ์ `anon` หรือ
   `authenticated` อ่าน `storage.objects` แบบไม่จำกัด bucket (มักติดมาจากตัวอย่างใน tutorial หรือแอปอื่นในโปรเจกต์เดียวกัน)
   ไปที่ **Storage → Policies** แล้วดูว่า**ไม่มี** policy ใดที่ไม่ได้ระบุ `bucket_id` หรือที่ครอบคลุม `bean-garden` สำหรับ `anon` /
   `authenticated` ถ้ามีให้ลบหรือแก้ให้ระบุ bucket อื่นเท่านั้น (เกมไม่ต้องการ policy ใดเลย เพราะใช้ service key) ถ้าโปรเจกต์นี้ใช้กับแอปอื่นด้วย
   ทางที่ปลอดภัยที่สุดคือแยกโปรเจกต์ Supabase ให้เกมโดยเฉพาะ

### 3.2 GitHub: ส่งโค้ดขึ้น repo

repo เป็น **public** `.gitignore` กันไฟล์เหล่านี้ไว้แล้ว: `reference/`, `BROOD-STUDY.md` (เอกสารศึกษาของเกมต้นฉบับ),
`data*/` และไฟล์ข้อมูลทุกที่ (`*.db`, `state*.json`, `journal*.jsonl`, `admin-bootstrap.txt`, `backups/`), `secrets/`, `.env*`,
`node_modules/` ก่อน push ครั้งแรกให้เช็กใน GitHub Desktop / หน้า commit ว่า**ไม่มี**ไฟล์พวกนี้อยู่ในรายการ ส่วน `render.yaml`
มีแต่ค่าที่ไม่ใช่ความลับ (URL ของ Supabase ไม่ใช่ความลับ ต้องมี key ถึงจะอ่าน bucket ได้)

### 3.3 Render: สร้างบริการจาก Blueprint

1. เข้า <https://dashboard.render.com> → **New → Blueprint**
2. เชื่อมบัญชี GitHub แล้วเลือก repo ของ Bean Garden (branch หลัก) Render จะอ่าน `render.yaml` และแสดงบริการ `bean-garden`
   (Docker · Free · Singapore · health check `/healthz` · auto-deploy เมื่อ commit ที่แก้โค้ด)
3. Render จะถามค่าลับ 2 ตัว (ห้ามเว้นว่าง — ค่าว่างทำให้เซิร์ฟเวอร์ไม่ยอมเริ่ม):
   - `SUPABASE_SERVICE_ROLE_KEY` = key จากข้อ 3.1
   - `ADMIN_BOOTSTRAP_CODE` = รหัสสำหรับสมัคร admin คนแรกที่**คุณตั้งเอง** ยาว 12–128 ตัว ไม่มีช่องว่าง เช่น `BeanAdmin-7Q4kZ9-2026`
     (ระบบไม่สนตัวพิมพ์เล็ก/ใหญ่และขีด `-`) จดไว้ในที่ปลอดภัย
4. กด **Apply** แล้วรอ build + deploy ครั้งแรก (ราว 3–8 นาที) ดูความคืบหน้าที่แท็บ **Logs**
   ถ้า deploy ครั้งแรกล้มเหลว ให้ดูสาเหตุใน Logs (ตารางข้อ 8) แก้แล้วกด **Manual Deploy → Deploy latest commit**

> **กฎสำคัญ:** ค่าที่อยู่ใน `render.yaml` ให้แก้**ในไฟล์นั้น**เสมอ (แก้ผ่านหน้าเว็บ GitHub ได้เลย: เปิดไฟล์ → ไอคอนดินสอ → Commit)
> ถ้าแก้แค่ในหน้า Environment ของ Render ค่าจะถูก `render.yaml` เขียนทับในการ sync Blueprint ครั้งถัดไป
> (ยกเว้นค่าลับ 2 ตัวข้างบน ซึ่งอยู่ใน Render เท่านั้น)

### 3.4 ตรวจชื่อ URL

ถ้า URL ที่ Render ให้มา**ไม่ใช่** `https://bean-garden.onrender.com` (เช่นชื่อซ้ำแล้วได้ `bean-garden-xxxx.onrender.com`)
ใน Logs จะมีบรรทัด `[config] ALERT PUBLIC_ORIGIN … differs from this Render service URL …` และหน้าเว็บจะได้ `421 misdirected`
(ส่วน `/healthz` ยังตอบปกติ บริการจึงขึ้นว่า Live) วิธีแก้: GitHub → `render.yaml` → แก้ค่า `PUBLIC_ORIGIN` เป็น URL จริง
(ไม่มี `/` ท้าย) → Commit (deploy ใหม่เอง) และแก้ URL ในงาน pg_cron ข้อ 3.5 ด้วย

### 3.5 Supabase: ping กันหลับ + กัน pause (pg_cron ทุก 10 นาที)

Supabase → **SQL Editor** → New query → วางทั้งหมดแล้วกด Run (แก้ URL ถ้าข้อ 3.4 ไม่ตรง):

```sql
-- ส่วนขยายตามรูปแบบในเอกสารของ Supabase
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- ตารางแถวเดียวสำหรับ "การใช้งานฐานข้อมูล" (เปิด RLS ไว้ คนนอกอ่าน/เขียนผ่าน API ไม่ได้)
create table if not exists public.bean_keepalive (id int primary key, t timestamptz not null);
alter table public.bean_keepalive enable row level security;

-- 1) ปลุก Render ทุก 10 นาที
select cron.schedule(
  'bean-garden-keepalive',
  '*/10 * * * *',
  $$ select net.http_get(url := 'https://bean-garden.onrender.com/healthz', timeout_milliseconds := 60000) $$
);

-- 2) เขียนฐานข้อมูลของ Supabase ทุก 10 นาที (แถวเดิมแถวเดียว ไม่โตขึ้น)
select cron.schedule(
  'bean-garden-db-heartbeat',
  '*/10 * * * *',
  $$ insert into public.bean_keepalive (id, t) values (1, now()) on conflict (id) do update set t = excluded.t $$
);
```

ตรวจว่าทำงาน: `select jobname, status, start_time from cron.job_run_details join cron.job using (jobid) order by start_time desc limit 6;`
(status `succeeded`) และ `select status_code, created from net._http_response order by created desc limit 5;` (ควรเป็น `200`)
และ `select t from public.bean_keepalive;` (เวลาล่าสุด) · ยกเลิก: `select cron.unschedule('bean-garden-keepalive');` และ
`select cron.unschedule('bean-garden-db-heartbeat');`

### 3.6 สร้าง admin คนแรก

1. เปิด URL ของเกม → **สร้างสวนใหม่** → ตั้งชื่อผู้ใช้ (a–z, 0–9, _ ยาว 3–24) และรหัสผ่าน (≥ 10 ตัว)
2. กด **ฉันมีรหัสตั้งค่าจากผู้ดูแลระบบ** แล้ววาง `ADMIN_BOOTSTRAP_CODE` ที่ตั้งไว้ในข้อ 3.3 → สร้าง
   (การสมัครปิดอยู่ แต่รหัสนี้ใช้สร้าง admin คนแรกได้เสมอ และใช้ไม่ได้อีกเมื่อมี admin แล้ว)
3. หลังมี admin แล้วจะลบ `ADMIN_BOOTSTRAP_CODE` ออกจาก Environment ของ Render ก็ได้ (ไม่บังคับ)

ถ้าไม่ได้ตั้ง `ADMIN_BOOTSTRAP_CODE` (ลบออกจาก Environment ไปแล้ว) เซิร์ฟเวอร์จะสุ่มโค้ดให้และเก็บไว้ใน bucket ส่วนตัวที่
`admin/admin-bootstrap.txt` (Supabase → Storage → `bean-garden` → `admin` → ดาวน์โหลด) ไฟล์นี้ถูกลบจาก bucket อัตโนมัติเมื่อมี admin

### 3.7 ตรวจว่าทุกอย่างทำงาน (Render → Logs)

| บรรทัดใน log | ความหมาย |
|---|---|
| `[cloud] created the PRIVATE bucket "bean-garden"` | บูตครั้งแรก: สร้าง bucket แบบ private ให้แล้ว |
| `[cloud] the bucket has no saved data yet (first boot): starting fresh` | บูตครั้งแรก: ยังไม่มีข้อมูล เริ่มใหม่ |
| `[cloud] restored bean.db, state-real.json from the bucket` | บูตครั้งถัดไป: ดึงข้อมูลกลับมาแล้ว |
| `Bean Garden is growing at http://localhost:10000/` | เปิดรับ request แล้ว (port 10000 ภายใน Render) |
| `[cloud] this instance (xxxxxxxx) holds the lease (first boot): syncing bean.db every 60 s …` | บูตครั้งแรก: เริ่ม sync แล้ว |
| `[cloud] this instance (xxxxxxxx) took the lease from yyyyyyyy (deploy); first full upload in N s …` | ปกติทุกครั้งที่ deploy/รีสตาร์ต: ตัวใหม่รับช่วง แล้วอัปโหลดทั้งชุดหลัง N วินาที |
| `[cloud] instance yyyyyyyy holds the lease: this instance (xxxxxxxx) stops uploading and stands by …` | ปกติบน**ตัวเก่า**ระหว่าง deploy (ตัวเก่าจะถูกปิดในไม่กี่นาที) |
| `[live] garden N: skipped K replayed bar(s) already mirrored before the restart` | ปกติหลังรีสตาร์ต: bot ข้ามแท่งที่เคยเทรดแล้ว |
| `[cloud] history 2026101405 saved; pruned …` | สำเนารายชั่วโมง (เวลา UTC) |
| `[cloud] ALERT …` | มีอะไรผิดปกติ ดูข้อ 8 |
| `[cloud] final sync done: N upload(s)` | ตอนปิด: อัปโหลดรอบสุดท้ายสำเร็จ |

ใน Supabase → Storage → `bean-garden` ควรเห็นโฟลเดอร์ `db/`, `state/`, `history/` และไฟล์ `lease.json`
ถ้าล็อกอินเป็น admin อยู่ เปิด `https://bean-garden.onrender.com/api/v1/admin_status` จะเห็น `"cloud": {...}`
(`lease: "owned"`, `last_ok_ms`, `failures`, `last_error`, ขนาดไฟล์, `month_bytes`, `month_projected_bytes`) และ `"client_ip": {...}`

## 4. ตรวจ IP ของผู้เล่นหลัง proxy ของ Render (`TRUST_PROXY=1`)

เซิร์ฟเวอร์ใช้ IP ของผู้เล่นแยก rate limit ของการล็อกอิน/สมัครรายคน ถ้า IP ผิด (ทุกคนได้ IP ของ proxy เหมือนกัน) คนร้ายคนเดียว
ล็อกทุกคนออกจากระบบได้ Render ไม่ได้เขียนเอกสารเรื่อง header ของ proxy ไว้ชัดเจน จึง**ต้องตรวจด้วยตัวเอง**หลังมีคนเข้าเว็บครั้งแรก
จาก log (ไม่มีเลข IP ใน log) แล้วทำตามตาราง:

| สิ่งที่เห็นใน log | ความหมายและสิ่งที่ต้องทำ |
|---|---|
| `[clientip] first request through a trusted proxy: X-Forwarded-For has 1 entry; … edge headers: none` หรือ header ทุกตัวเป็น `same as the chosen address` | **ถูกต้อง** ไม่ต้องทำอะไร |
| `… X-Forwarded-For has 2 entries; … (DIFFERENT from the chosen address)` | ค่าขวาสุดเป็นเครื่อง proxy ไม่ใช่ผู้เล่น → ตั้ง `TRUST_PROXY` เป็น `"2"` |
| `… X-Forwarded-For has 2 entries; … edge headers: none` | น่าจะเป็นกรณีเดียวกัน → ตั้ง `TRUST_PROXY` เป็น `"2"` แล้ว**ต้อง**ตรวจด้วยวิธีสองเครือข่ายข้างล่าง |
| ไม่มีบรรทัด `first request through a trusted proxy` เลย แต่มี `[clientip] proxy peer not in TRUSTED_PROXY_CIDRS …` | proxy ของ Render ต่อมาจาก IP นอกช่วงที่ไว้ใจ ระบบจึงไม่เชื่อ header และทุกคนได้ IP เดียวกัน → เพิ่มตัวแปร `TRUSTED_PROXY_CIDRS` ใน `render.yaml` เป็นค่าเดิม + ช่วงของ Render เช่น `127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,100.64.0.0/10` |
| `[clientip] X-Forwarded-For from a trusted proxy had fewer than TRUST_PROXY=1 valid entries …` ตอนบูต | มาจาก health check ภายในของ Render (ไม่มี X-Forwarded-For) **ไม่เป็นปัญหา** |

ทุกการแก้ให้ทำใน `render.yaml` ผ่าน GitHub (ข้อ 3.3 "กฎสำคัญ") แล้วดู log หลัง deploy อีกครั้ง
**ตรวจซ้ำทุกครั้งที่แก้** (PLATFORM §10.7 ข้อ 9): เปิดเว็บจากสองเครือข่าย (Wi-Fi กับเน็ตมือถือ) แล้วดู `client_ip.buckets_1h` ใน
`/api/v1/admin_status` ต้องเพิ่มเป็นอย่างน้อย 2 ถ้ายังเป็น 1 แปลว่าทุกคนยังได้ IP เดียวกัน

## 5. กู้ข้อมูลจาก history (ย้อนเวลา)

bucket เก็บสำเนา**รายชั่วโมงย้อนหลัง 48 ชั่วโมง** ใน `history/YYYYMMDDHH/` (เวลา **UTC** = เวลาไทย − 7 ชม. เช่น
`2026101405` = 14 ต.ค. 2026 เวลา 12:00 น. ไทย)

1. **พักบริการ:** Render → บริการ → Settings → **Suspend Web Service** (เซิร์ฟเวอร์จะอัปโหลดรอบสุดท้ายก่อนหยุด)
2. **เก็บสำเนาปัจจุบันไว้ก่อน:** Supabase → Storage → `bean-garden` → `db/` และ `state/` → ดาวน์โหลด `bean.db.gz`
   และ `state-real.json.gz` เก็บไว้ในเครื่อง (เผื่อเปลี่ยนใจ)
3. เปิด `history/<ชั่วโมงที่ต้องการ>/` → ดาวน์โหลด `bean.db.gz` และ `state-real.json.gz`
4. ใน `db/` ลบ `bean.db.gz` เดิม แล้ว **Upload file** ไฟล์ `bean.db.gz` จาก history ทำแบบเดียวกันกับ `state/state-real.json.gz`
   - ชื่อต้องเหมือนเดิม**เป๊ะ** (ถ้าเบราว์เซอร์ตั้งชื่อเป็น `bean.db (1).gz` ให้เปลี่ยนชื่อก่อนอัปโหลด) และห้ามแตกไฟล์ .gz
   - รอจนอัปโหลดเสร็จและเห็นไฟล์ในรายการก่อนไปข้อ 5
5. **เปิดบริการ:** Render → **Resume Web Service** เซิร์ฟเวอร์จะดึงไฟล์ที่เพิ่งวางกลับมาตอนบูต (ดู log `[cloud] restored …`)

ถ้าวางไฟล์ผิดชื่อหรือยังอัปโหลดไม่เสร็จ เซิร์ฟเวอร์จะ**ไม่ยอมเริ่ม** (exit 4, `… not found although the bucket was in use …`)
แทนที่จะเริ่มจากว่างเปล่า แก้ไฟล์ให้ถูกแล้วกด Manual Deploy (หรือรอ Render ลองใหม่) ข้อมูลในคลาวด์จึงไม่หาย
ผู้เล่นจะเห็นข้อมูล ณ ชั่วโมงนั้น การเปลี่ยนแปลงหลังจากนั้นหายไป (เกมเติมราคาที่ขาดจาก Hyperliquid ให้เอง)
วิธีเดียวกันนี้ใช้ย้ายข้อมูลจากเครื่องเดิมขึ้นคลาวด์ได้ (บีบอัดไฟล์เป็น `.gz` แล้ววางใน `db/` / `state/`) แต่ปกติแนะนำให้เริ่มใหม่บนคลาวด์

**ตั้งใจเริ่มใหม่ทั้งหมด** (ลบข้อมูลผู้เล่นทุกคน):
- แบบง่าย: Suspend → ลบ `db/`, `state/`, `history/` และ `lease.json` ใน bucket → Resume (bucket ว่างจริง = บูตครั้งแรก)
- แบบเก็บ `history/` ไว้: เพิ่ม `CLOUD_ALLOW_FRESH` = `"1"` ใน `render.yaml` แล้ว Commit → รอ deploy เสร็จ → Suspend → ลบเฉพาะ
  `db/` กับ `state/` → Resume (log บอก `CLOUD_ALLOW_FRESH=1: starting without …`) → **เอา `CLOUD_ALLOW_FRESH` ออกจาก
  `render.yaml` ทันที** แล้ว Commit (ถ้าค้างไว้ ระบบจะไม่มีตัวกันข้อมูลหายตามข้อ 1)

## 6. เปลี่ยน (rotate) service key

**Secret key (`sb_secret_…`)** — ไม่มี downtime:
1. Supabase → Project Settings → API Keys → Secret keys → **Create new secret key**
2. Render → Environment → แก้ `SUPABASE_SERVICE_ROLE_KEY` เป็น key ใหม่ → **Save Changes** (ค่าลับแก้ใน Render ได้ ไม่ถูก Blueprint เขียนทับ)
3. รอ log `[cloud] … took the lease …` ของ deploy ใหม่ แล้วกลับไป Supabase → **ลบ key เก่า**

**Legacy `service_role` (`eyJ…`)** เปลี่ยนได้ด้วยการ rotate JWT secret ซึ่งทำให้ key `anon` และ session ของ Supabase ทั้งหมดเปลี่ยนด้วย
ถ้าจะเปลี่ยนแบบนี้ให้ย้ายไปใช้ Secret key ตามขั้นตอนข้างบนแทนจะง่ายกว่า

ถ้าสงสัยว่า key รั่ว: สร้าง key ใหม่ + ใส่ใน Render ทันที + ลบ key เก่า แล้วตรวจ Storage ว่า bucket ยังเป็น private และ policy ตามข้อ 3.1

## 7. ตัวแปรที่เกี่ยวข้อง (แก้ใน `render.yaml` ผ่าน GitHub · ค่าลับแก้ใน Render → Environment)

| ตัวแปร | ค่าใน render.yaml | ความหมาย |
|---|---|---|
| `PUBLIC_ORIGIN` | `https://bean-garden.onrender.com` | URL สาธารณะ ต้องตรงกับที่ Render ให้ (ถ้าลบออก เซิร์ฟเวอร์ใช้ `RENDER_EXTERNAL_URL` ที่ Render ใส่ให้เอง) |
| `PORT` | `10000` | port ภายในที่ Render ส่ง request มา (ชนะค่า 8420 ใน Dockerfile) |
| `SUPABASE_URL` | `https://fshntnizfqnwsrllxmtz.supabase.co` | โปรเจกต์ Supabase (https เท่านั้น) |
| `SUPABASE_SERVICE_ROLE_KEY` | (ลับ ใส่ใน Render) | service_role หรือ `sb_secret_` key — ต้องตั้งคู่กับ `SUPABASE_URL` เสมอ |
| `CLOUD_STORE_BUCKET` | `bean-garden` | ชื่อ bucket (private) |
| `CLOUD_STORE_PREFIX` | (ไม่ตั้ง) | โฟลเดอร์ย่อยใน bucket เช่น `prod` ถ้าจะใช้ bucket ร่วมกับอย่างอื่น |
| `CLOUD_SYNC_SECONDS` | (ไม่ตั้ง = 60) | ความถี่ sync ฐานข้อมูล (15–3600 วินาที) |
| `CLOUD_EGRESS_BUDGET_MB` | (ไม่ตั้ง = 3072) | งบอัปโหลดต่อเดือนของการ sync (ข้อ 2) |
| `CLOUD_ALLOW_FRESH` | (ไม่ตั้ง) | `"1"` = ยอมเริ่มจากว่างทั้งที่ bucket เคยมีข้อมูล ใช้ครั้งเดียวแล้วเอาออก (ข้อ 5) |
| `ADMIN_BOOTSTRAP_CODE` | (ลับ ใส่ใน Render) | รหัสสมัคร admin คนแรก |
| `SIGNUP_MODE` | `closed` | เปิดให้เพื่อนสมัคร: แก้เป็น `open` ใน `render.yaml` แล้ว Commit |
| `TESTNET_ENABLED` | `0` | testnet ปิด (เปิดต้องมี `BEAN_MASTER_KEY` ด้วย) |
| `TRUST_PROXY` / `TRUSTED_PROXY_CIDRS` | `1` / (ค่าเริ่มต้น) | ดูข้อ 4 |
| `BACKUP_KEEP` | `4` | backup บนดิสก์ชั่วคราวของ Render (ของจริงคือ `history/` ใน bucket) |

ตั้ง `SUPABASE_URL` อย่างเดียวหรือ key อย่างเดียว → เซิร์ฟเวอร์ไม่ยอมเริ่ม (exit 2) และตัวแปรพวกนี้ใช้ได้เฉพาะโหมด accounts

## 8. แก้ปัญหา

**ถ้าโปรแกรม exit ตอนบูต:** ระหว่าง**deploy** Render จะยกเลิก deploy นั้นและปล่อยเวอร์ชันเก่าทำงานต่อ → แก้สาเหตุแล้วกด
**Manual Deploy → Deploy latest commit** (deploy ครั้งแรกที่ล้มเหลวก็ทำแบบเดียวกัน) ถ้าเป็นการ**รีสตาร์ตของบริการที่ทำงานอยู่**
Render จะลองเปิดใหม่ให้เอง

| อาการใน log / หน้าเว็บ | สาเหตุและวิธีแก้ |
|---|---|
| `bean-garden: … is set but empty` (exit 2) | ค่าลับใน Render ว่าง → ใส่ค่าให้ครบ (ข้อ 3.3) |
| `cloud persistence is half configured …` (exit 2) | มี `SUPABASE_URL` แต่ไม่มี key (หรือกลับกัน) |
| `cloud restore: cannot download … HTTP 401/403` (exit 4) | key ผิด/ถูกลบ → ใส่ key ใหม่ (ข้อ 6) ถ้าใช้ `sb_secret_` แล้วยังได้ 401 ให้ลอง legacy `service_role` |
| `cloud restore: … HTTP 5xx` / `timeout` (exit 4) | Supabase ล่มหรือโปรเจกต์ถูก pause → เปิด Supabase dashboard กด restore โปรเจกต์ แล้ว Manual Deploy / รอ Render ลองใหม่ |
| `cloud restore: … not found although the bucket was in use …` (exit 4) | Supabase ตอบว่าไม่พบ `db/` หรือ `state/` ทั้งที่เคยมีข้อมูล: ถ้าเพิ่งกู้จาก history ให้ตรวจชื่อไฟล์ (ข้อ 5) ถ้าไม่ได้ทำอะไร มักเป็นอาการชั่วคราว Render จะลองใหม่ ถ้าไฟล์หายจริงให้กู้จาก `history/` ถ้าตั้งใจเริ่มใหม่ดูท้ายข้อ 5 |
| `cloud bucket bean-garden is PUBLIC` (exit 4) หรือ `[cloud] ALERT … is PUBLIC: uploads are stopped …` | Supabase → Storage → bucket → Edit → ปิด Public (การอัปโหลดกลับมาเองเมื่อเป็น private) และตรวจ policy ข้อ 3.1 |
| `cloud restore: … is not a valid gzip file / not a SQLite database` | ไฟล์ใน `db/` หรือ `state/` เสีย → กู้จาก history (ข้อ 5) |
| `bean-garden: Hyperliquid is unavailable for the first warm-up …` (exit 1) | ดึงราคาย้อนหลังจาก Hyperliquid ไม่ได้ตอนบูตครั้งแรก (มักเป็น rate limit ของ IP ที่ใช้ร่วมกัน) → รอสักครู่ Render จะลองใหม่ / Manual Deploy |
| `[cloud] ALERT sync failed (…)` | sync ไม่สำเร็จ (log ครั้งแรกและทุก 10 นาทีถ้ายังพัง) ดูข้อความต่อท้าย: 401/403 = key, 5xx/timeout = Supabase |
| `[cloud] ALERT standby for N min: instance … keeps renewing the lease …` | มี**อีกบริการหนึ่ง**ใช้ bucket เดียวกันอยู่ (เช่นสร้าง Blueprint ซ้ำ หรือรันเกมบนคอมโดยตั้ง Supabase ไว้) → ปิดตัวที่เกิน หรือใช้ `CLOUD_STORE_PREFIX` แยกกัน บรรทัด `stops uploading and stands by` ครั้งเดียวระหว่าง deploy เป็นเรื่องปกติ |
| `[cloud] lease.json was missing twice in a row: writing it again` | มีคนลบ `lease.json` ระหว่างบริการทำงาน → ระบบเขียนกลับเองแล้ว ไม่ต้องทำอะไร (อย่าลบไฟล์นี้) |
| `[cloud] ALERT egress: … the bucket copy of the database is N min behind` | อัปโหลดเร็วกว่างบรายเดือน ระบบจึงเว้นระยะ (ข้อ 2) ข้อมูลไม่หาย แค่ช่วงที่อาจหายถ้าเครื่องล่มยาวขึ้น ดูยอดใน Render → Billing |
| `[cloud] ALERT final_sync deadline_hit …` | ตอนปิด Supabase ตอบช้าจนเกินเวลา: bucket มีข้อมูลจากรอบ sync ก่อนหน้า (ไม่เกิน 1 นาที) |
| `[config] ALERT PUBLIC_ORIGIN … differs …` / หน้าเว็บ `421 misdirected` | `PUBLIC_ORIGIN` ไม่ตรงกับ URL จริง (ข้อ 3.4) |
| เว็บช้ามากครั้งแรกของวัน | บริการหลับ (pg_cron ไม่ทำงาน) → ตรวจข้อ 3.5 |
| บริการถูกปิดทั้ง workspace กลางเดือน | ใช้ข้อมูลขาออกเกิน 5 GB (ข้อ 2) → รอต้นเดือน หรือผูกบัตร แล้วลด `CLOUD_EGRESS_BUDGET_MB` |
| Deploy fail ที่ health check | ดู Logs ว่าโปรแกรม exit เพราะอะไร (ตารางนี้) `/healthz` ตอบ 200 ทันทีที่เปิด port |

## 9. ความปลอดภัย (สรุป)

- service key อยู่แค่ใน Render Environment (secret) ถูกอ่านครั้งเดียวแล้วลบจาก environment ของ process ไม่ลง log ไม่อยู่ใน error
- bucket เป็น private: ข้อมูลในนั้น (รหัสผ่านแบบ hash, session, ข้อมูลผู้เล่น) อ่านได้เฉพาะผู้มี service key ผู้เข้า dashboard ได้
  **และ**ผู้ที่ policy ของ Storage อนุญาต — จึงต้องไม่มี policy เปิดกว้างตามข้อ 3.1 ข้อ 5 ปกป้องบัญชี Supabase/Render/GitHub
  ของคุณด้วยรหัสผ่านแข็งแรง + 2FA
- โค้ด admin ที่สุ่มไว้อยู่ใน bucket เฉพาะตอนยังไม่มี admin และถูกลบทันทีเมื่อมี admin
- เซิร์ฟเวอร์ส่ง request ออกได้เฉพาะ Hyperliquid `/info` และ Storage API ของโปรเจกต์นี้ (egress guard) ไม่มีทางส่ง order บน mainnet
- รายละเอียดเชิงเทคนิค: `server/cloudsync.js`, `server/cloudstore.js`, `server/live.js` (replay guard), PLATFORM.md §10.8
