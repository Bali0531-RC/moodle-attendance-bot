# 🤖 Moodle Attendance Bot (Messenger QR & 6-Char Code Auto-Submitter)

Valós idejű, **Playwright + Chromium CDP + ZXing-WASM + GitHub Copilot AI** alapú jelenlét-rögzítő bot egyetemi Moodle rendszerekhez (pl. Pannon Egyetem `moodle.uni-pannon.hu` Microsoft KCA SSO-val).

A bot a háttérben figyeli a megadott **Messenger csoportot**, és:
1. **📸 QR-kódos kép érkezésekor (< 15 mp lejáratú dinamikus QR):**
   - `MutationObserver`-rel azonnal (< 50 ms) elkapja a képet a DOM-ból.
   - Memóriában dekódolja a **ZXing-C++ WebAssembly** (`zxing-wasm`) ipari olvasóval (~50–120 ms), így a ferdén fotózott, kékes, projektoros vetítővászonról készült képeket is hibátlanul olvassa.
   - A már beléptetett Moodle fülön azonnal megnyitja a linket, ellenőrzi a választ, és ha szükséges, kitölti a **Present / Jelen** űrlapot.
2. **🔤 6-karakteres kód érkezésekor (óra végéig érvényes):**
   - **3-lépcsős AI spóroló szűrő:**
     1. Csak a `config.json`-ban megadott **aktív órarendi idősávokban** (`active_schedule`) figyel.
     2. Ha sima kódot küldenek (`X7B9K2` vagy `kód: ab12cd`), **0 ms alatt Regex-szel** kiszedi, AI hívás nélkül. Ha nincs az üzenetben 6 karakteres szó, nem hív AI-t.
     3. Ha mondatba ágyazva jön 6 betűs szó (pl. *"srácok a táblára felírták hogy m8p4k1 siessetek"*), a **GitHub Copilot (`gpt-4o-mini`)** kontextus-elemzéssel eldönti, hogy jelenléti kód-e vagy sima beszélgetés.
   - **Automatikus keresés + `-10 perces` óra előtti buffer:** Végigfut a `config.json`-ban felsorolt tárgyaid Attendance linkjein, megkeresi az aktív **"Submit attendance" / "Jelenlét rögzítése"** gombot, beírja a 6-jegyű kódot, bepipálja a **"Present" / "Jelen"** rádiógombot, és elmenti. Ha a tanár óra előtt 10 perccel írta fel a kódot a táblára és a Moodle-ben még nincs nyitva a gomb, a bot 20 másodpercenként újrapróbálja, amíg ki nem nyílik!
3. **🔑 Virtuális FIDO2 Passkey (`WebAuthn` CDP) + Microsoft KCA Auto-Login:**
   - A bot egy saját **virtuális hardveres FIDO2 Passkey chipet** emulál (`passkey.js`). Regisztrálhatsz neki egy saját Facebook/Meta Passkey-t (`.passkeys.json`), így ha a Facebook/Messenger bármikor 2FA Passkey-t kér egy headless Linux szerveren, a bot **0 ms alatt, emberi beavatkozás nélkül kriptográfiailag aláírja**!
   - A Moodle fülön 10 percenként frissít (`keep-alive`), és ha a Moodle mégis kidobna, egyetlen kattintással automatikusan visszaléptet a **Microsoft KCA / Entra ID SSO**-n keresztül.

---

## 🛠️ 1. Telepítés (Helyi gépen az első belépéshez)

A legelső bejelentkezést (Messenger + Moodle KCA + Passkey regisztráció) érdemes a saját gépeden, ablakos (`headless: false`) módban megcsinálni, majd egyetlen paranccsal kimenteni és felrakni a szerverre.

### Előfeltételek
- **Node.js** (v20+) és **pnpm** (vagy npm)
- Linuxon opcionálisan `zbar-tools` (`sudo apt install zbar-tools` / `sudo pacman -S zbar`)

```bash
git clone https://github.com/Bali0531-RC/moodle-attendance-bot.git
cd moodle-attendance-bot

pnpm install
pnpm exec playwright install chromium

cp config.example.json config.json
cp .env.example .env
```

---

## ⚙️ 2. Konfiguráció (`config.json` és `.env`)

Szerkeszd a **`config.json`** fájlt:

```json
{
  "messenger_group_url": "https://www.messenger.com/t/CSOPORT_THREAD_ID",
  "moodle_base_url": "https://moodle.uni-pannon.hu",
  "headless": false,
  "keep_alive_minutes": 10,
  "retry_if_not_open_seconds": 20,
  "retry_max_attempts": 35,
  "timezone": "Europe/Budapest",
  "active_schedule": {
    "Monday": [
      { "start": "09:30", "end": "12:00" }
    ],
    "Tuesday": [
      { "start": "07:30", "end": "14:00" }
    ],
    "Wednesday": [
      { "start": "07:30", "end": "12:00" }
    ],
    "Thursday": [
      { "start": "09:30", "end": "16:00" }
    ],
    "Friday": [],
    "Saturday": [],
    "Sunday": []
  },
  "attendance_urls": [
    "https://moodle.uni-pannon.hu/mod/attendance/view.php?id=111111",
    "https://moodle.uni-pannon.hu/mod/attendance/view.php?id=222222"
  ],
  "course_schedules": {
    "https://moodle.uni-pannon.hu/mod/attendance/view.php?id=222222": {
      "name": "Programozás 1 gyakorlat (Csak a saját csoportom sávja!)",
      "buffer_before_minutes": 10,
      "windows": [
        { "day": "Wednesday", "start": "08:00", "end": "10:00" }
      ]
    }
  }
}
```
- **`active_schedule`**: Naponként megadhatod, mettől meddig figyeljen a bot (akár több idősávot is megadhatsz egy napon belül). Idősávon kívül **Alvó módba** kapcsol (nem hív AI-t és nem nyit meg semmit). Ha menet közben átírod a `config.json`-t, a bot újraindítás nélkül azonnal újratölti!
- **`attendance_urls`**: A felvett tárgyaid Moodle Jelenlét (`.../mod/attendance/view.php?id=...`) linkjei.
- **`course_schedules` (Opcionális, több gyakorlati csoportos tárgyakhoz!):** Ha egy tárgyból több gyakorlati csoport van a héten és más csoportok is beküldik a közös Messengerbe a QR-kódjukat, itt megadhatod a tárgy `view.php?id=...` linkjéhez a **saját csoportod** pontos idősávját (`buffer_before_minutes: 10` perces óra előtti tűréssel).
  - Amikor bejön egy QR-kód (`...attendance.php?qrpass=...&sessid=5303`), a bot először **levágja róla a `qrpass`-t**, és ~100ms alatt megnézi, melyik tárgyhoz tartozik a `sessid=5303`. Ha a tárgy szerepel a `course_schedules`-ben, és épp nincs (és 10 percen belül sem lesz) belőle órád, **nem küldi be a jelenlétet** (`🛑 [QR SKIPPELVE - MÁS CSOPORT ÓRÁJA!]`)!
  - Ugyanerre a `sessid`-re érkező további QR fotókat automatikusan deduplikálja (`⏭️ [QR DEDUPE]`), és a QR-kódok mindig elsőbbséget élveznek a 6-jegyű kód kereséssel szemben.

Szerkeszd a **`.env`** fájlt:
```ini
AI_PROVIDER=copilot
AI_MODEL=gpt-4o-mini

# Opcionális: Facebook auto-relogin (ha a Messenger bármikor kidobná a sessiont a szerveren)
FB_EMAIL=pelda@gmail.com
FB_PASS=Jelszo123
MESSENGER_PIN=123456
```

---

## 🔐 3. Első indítás, Virtuális Passkey (2FA) és GitHub Copilot összekötés

Indítsd el a botot a saját gépeden:
```bash
pnpm start
```

Megnyílik egy Chromium ablak két füllel:
1. **1. fül (Messenger):** Lépj be a Facebook/Messenger fiókodba (és ha kéri a 6-jegyű E2EE titkosítási PIN-t, írd be).
2. **2. fül (Moodle):** Lépj be a KCA / Microsoft SSO-val, és nyomj **Igen**-t a *"Bejelentkezve marad? (Stay signed in?)"* kérdésre!

### A) Virtuális FIDO2 Passkey regisztrálása (Hogy a szerveren sose akadjon el 2FA-n!)
A Facebook már nem támogatja az új TOTP (Authenticator) kódokat sok fióknál, és belépéskor Passkey-t kér. A botunk a Chromium CDP `WebAuthn` protokolljával egy **virtuális hardveres biztonsági kulcsot** emulál:

1. Miután beléptél a Messengerbe, írd be a futó bot termináljába:
   ```text
   passkey-register
   ```
2. A bot megnyitja a `https://accountscenter.facebook.com/password_and_security/passkeys` oldalt.
3. *(Ha a Meta először biztonsági ellenőrzést kér egy QR-kódos ablakkal, hogy te vagy-e az, nyomj a **Cancel -> Próbálkozás másik módszerrel** gombra és írd be a jelszavadat, vagy olvasd le a telefonoddal).*
4. Ezután a Passkeys menüben kattints a **"Create passkey / Jelkulcs létrehozása"** gombra!
5. A bot virtuális FIDO2 chipje a háttérben azonnal elkapja a kulcsot, és kiírja a terminálba:
   ```text
   🎉 [PASSKEY REGISZTRÁLVA!] Új Passkey sikeresen elkapva és elmentve a .passkeys.json fájlba!
   ```
   *(Ellenőrizheted a `passkey-list` paranccsal).*

### B) GitHub Copilot AI összekötése (`copilot-login`)
- Ha a gépeden már be vagy lépve az OpenCode-ba (`~/.local/share/opencode/auth.json`), a bot **automatikusan** átveszi és lementi a tokenedet a `.copilot-token.json` fájlba!
- Ha külön szeretnél belépni egy GitHub Copilot (Pro / Business / Student) fiókkal, írd be a bot termináljába:
  ```text
  copilot-login
  ```
  Nyisd meg a `https://github.com/login/device` oldalt, írd be a kapott 8 karakteres kódot, és a bot elmenti a `.copilot-token.json` fájlt.

### C) Állapot ellenőrzése és mentés (`status` & `save`)
Írd be a terminálba:
```text
status
```
Ha azt látod, hogy `📌 Messenger Session: 🟢 BELÉPVE (c_user & xs OK)` és a Passkey is megvan, írd be:
```text
save
exit
```
Ez létrehozza a hordozható **`auth.json`** (sütik + IndexedDB), **`.passkeys.json`** (FIDO2 privát kulcs) és **`.copilot-token.json`** fájlokat.

---

## 🧪 4. Interaktív tesztelés a terminálban

Amikor a bot fut, a terminálba bármikor beírhatsz teszt parancsokat (a kézi terminálos teszt automatikusan figyelmen kívül hagyja az alvó módot, így este/hétvégén is tesztelhető):

| Parancs a terminálban | Mit csinál? |
| :--- | :--- |
| `qr /eleresi/ut/kep.jpg` | Dekódolja a megadott képfájlt (~50ms) és azonnal megnyitja a QR linket a Moodle fülön |
| `kód: AB12CD` *(vagy bármilyen szöveg)* | Szimulál egy Messenger üzenetet -> lefuttatja a Copilot AI / Regex kinyerőt -> végigfut a Moodle linkeken |
| `status` | Kiírja a Messenger session (`c_user`), a Passkey-ek, a Moodle URL és az órarend állapotát |
| `passkey-register` | Megnyitja a Facebook Passkey regisztrációt a virtuális FIDO2 chippel |
| `passkey-list` | Kilistázza a `.passkeys.json`-ba mentett kulcsokat |
| `copilot-login` | GitHub Copilot Device Flow bejelentkezés |
| `save` | Kimenti a teljes böngésző állapotot az `auth.json` és `.passkeys.json` fájlokba |
| `exit` | Mentés és tiszta leállás |

Automata önteszt (Mock Moodle szerverrel + QR generálással + Copilot AI teszttel):
```bash
pnpm test
```

---

## 🚀 5. Szerverre költöztetés (Docker Compose 0-24 Headless módban)

Miután a helyi gépeden beléptél és futtattál egy `save` + `exit` parancsot:

### 1. Másold fel a mappát (a titkos session fájlokkal együtt) a szerveredre:
```bash
rsync -avz --exclude 'node_modules' --exclude '.browser-profile/Singleton*' \
  ./ root@SZERVER_IP:~/moodle-attendance-bot/
```
*(Fontos, hogy a `config.json`, `.env`, `auth.json`, `.passkeys.json`, `.copilot-token.json` és `.browser-profile/` is felkerüljön a szerverre!)*

### 2. Indítsd el a szerveren Docker Compose-zal:
```bash
cd ~/moodle-attendance-bot
docker compose up -d --build
```

### 3. Élő logok követése a szerveren:
```bash
docker compose logs -f
```
A konténer `restart: unless-stopped` beállítással fut, `Europe/Budapest` időzónával, és a `config.json` / `auth.json` / `.passkeys.json` fájlokat közvetlenül csatolja (volume mount), így bármikor szerkesztheted a `config.json`-t a szerveren újraindítás nélkül.
