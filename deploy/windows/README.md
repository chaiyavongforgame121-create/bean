# Deploy ฟรีบนเครื่อง Windows นี้ + Tailscale Funnel

เซิร์ฟเวอร์รันอยู่บนเครื่องนี้ (โหมดหลายผู้เล่น · ราคาจริง · เทรดกระดาษ · testnet ปิด · ปิดรับสมัคร) และเปิดให้คนนอกเข้าผ่าน
**Tailscale Funnel** ซึ่งฟรี ไม่ต้องใช้บัตร และไม่ต้องซื้อโดเมน

| รายการ | ค่า |
|---|---|
| URL สาธารณะ (หลังเปิด Funnel) | `https://bean-garden.taild4129d.ts.net` |
| เซิร์ฟเวอร์ในเครื่อง | `http://127.0.0.1:8420` (ฟังเฉพาะ localhost เข้าจากเน็ตได้ทางเดียวคือ Funnel) |
| ข้อมูล | `data-prod\` (SQLite + state, ถูก gitignore) · log: `data-prod\logs\server.log` |
| การรันเบื้องหลัง | Scheduled Task ชื่อ `BeanGarden` เริ่มเองทุกครั้งที่ล็อกอิน Windows และรีสตาร์ตเองถ้าล่ม |

## 1. เปิดให้คนนอกเข้า (ทำเองครั้งเดียว)

```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' funnel --bg 8420
```

ครั้งแรก Tailscale จะให้ลิงก์ไปกด **Enable Funnel** ในหน้าเว็บ (ล็อกอินบัญชีเดิม) กดแล้วรันคำสั่งเดิมอีกครั้ง
ตรวจสถานะด้วย `tailscale funnel status` และหยุดเผยแพร่ได้ทุกเมื่อด้วย `tailscale funnel reset`

## 2. สร้างบัญชี admin คนแรก

เปิด `data-prod\admin-bootstrap.txt` คัดลอกโค้ด แล้วไปที่ URL สาธารณะ → "สร้างสวนใหม่" → ใส่ชื่อผู้ใช้และรหัสผ่านของคุณ
และวางโค้ดในช่อง "รหัสตั้งค่าของผู้ดูแลระบบ" ไฟล์จะถูกลบทันทีหลังสร้าง admin สำเร็จ

ตอนนี้ปิดรับสมัคร (`SIGNUP_MODE=closed` ใน `start-bean.ps1`) จะให้เพื่อนสมัครได้ให้แก้เป็น `open` แล้วรีสตาร์ต task

## 3. ดูแลประจำ

| งาน | คำสั่ง |
|---|---|
| ดู log ล่าสุด | `Get-Content D:\Projects\bean\data-prod\logs\server.log -Tail 30 -Encoding UTF8` |
| รีสตาร์ตเซิร์ฟเวอร์ | `Stop-ScheduledTask BeanGarden; Start-ScheduledTask BeanGarden` |
| ถอนการติดตั้งทั้งหมด | `powershell -ExecutionPolicy Bypass -File D:\Projects\bean\deploy\windows\uninstall.ps1` (ข้อมูลยังอยู่) |
| ติดตั้งใหม่ | `powershell -ExecutionPolicy Bypass -File D:\Projects\bean\deploy\windows\install.ps1` |

## ข้อควรรู้

- เว็บเข้าได้เฉพาะตอน**เครื่องเปิดและไม่หลับ** ตั้งค่าเองที่ Settings → System → Power → Sleep = Never (ตอนเสียบปลั๊ก)
- Funnel ของแผน Personal ฟรี ใช้ได้แบบไม่ใช่เชิงพาณิชย์ ยังเป็น beta และมีเพดาน bandwidth ที่ไม่เปิดเผย เหมาะกับกลุ่มเล็ก
- สำรองข้อมูล: เซิร์ฟเวอร์ backup DB เองใน `data-prod\backups\` ควรคัดลอกโฟลเดอร์นี้ไปเก็บที่อื่นเป็นระยะ
- Funnel เปิดเฉพาะพอร์ต 8420 ของแอปนี้ ไม่ได้เปิดทั้งเครื่อง
