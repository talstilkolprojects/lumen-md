---
title: אירוח עצמי עם Docker
description: להריץ את Lumen על התשתית שלכם עם חבילת ה-docker-compose.
---

> ‏Lumen היא עורך **מקומי קודם** — כברירת מחדל הכול רץ בתוך הדפדפן, בלי
> שרתים. המדריך הזה לצוותים שרוצים להחזיק את שכבת ההתמדה (שיתוף, חיוב, יומן
> ביקורת) על התשתית שלהם.

## מה יש בחבילה

`docker-compose.yml` מעלה חמישה שירותים על מכונה וירטואלית אחת:

| שירות | פורט | מה |
|---|---|---|
| `lumen-web` | 80 | ‏nginx שמגיש את אפליקציית ה-React עם CSP מחמיר |
| `lumen-signal` | 4444 | איתות y-webrtc — עמיתים מוצאים זה את זה |
| `lumen-collab` | 4445 | ‏y-websocket מתמשך (LevelDB על הכרך `collab-data`; בריאות: `/healthz`) |
| `lumen-billing` | 4446 | מטפל ב-webhook של Stripe (אופציונלי) |
| `postgres` | 5432 | הרשאות מסלול + יומן ביקורת (השיתוף **לא** כותב לכאן — ארכיון צילומים ב-Postgres לא מומש) |

כרך LevelDB ‏(`collab-data`) וכרך Postgres ‏(`postgres-data`) נשמרים מחוץ
למחזור החיים של הקונטיינרים.

## דרישות

- מכונת Linux עם **2 vCPU ו-4 GB RAM** ‏(Hetzner CX22,‏ DigitalOcean basic-2,
  ‏AWS t4g.medium — כולם בסדר)
- **Docker 24+** ו-**Docker Compose v2**
- דומיין שמצביע על המכונה (בהמשך נשתמש ב-`lumen.example.com`)

## התקנה ב-5 דקות

```bash
# 1. משכפלים את Lumen
git clone https://github.com/talstilkol/lumen-md.git
cd lumen-md

# 2. מעתיקים ועורכים את תבנית הסביבה
cp .env.onprem.example .env.onprem
$EDITOR .env.onprem
#   מגדירים ל-LUMEN_PG_PASSWORD ערך חזק
#   מגדירים את LUMEN_BASE_URL לדומיין שלכם
#   משאירים את LUMEN_COLLAB_TOKEN ריק בינתיים (ראו ההערה בהמשך)
#   משאירים את Stripe / Sentry / WorkOS ריקים בינתיים

# 3. בונים ומפעילים
make onprem-up
```

אחרי כ-60 שניות של בניית אימג׳ים והפעלת קונטיינרים, נכנסים ל-`http://<vm-ip>`
ואמור להופיע העורך של Lumen.

:::caution[`LUMEN_COLLAB_TOKEN` בחבילה הזו]
החבילה מעבירה את `LUMEN_COLLAB_TOKEN` לשרת השיתוף, אבל לא לאפליקציה שהיא
בונה (ב-`docker/Dockerfile.web` אין ארגומנט `VITE_YJS_WEBSOCKET_TOKEN`),
ובאפליקציה עדיין אין מסך להזנת טוקן. כשמוגדר טוקן, שרת השיתוף דוחה את
הלקוחות של האפליקציה עצמה. השאירו אותו ריק, או בנו את אימג׳ הרשת בעצמכם עם
`VITE_YJS_WEBSOCKET_TOKEN` (ראו [חדרים מתמשכים](/he/collab/persistent/)).
חדרים חדשים מוצפנים מקצה לקצה בכל מקרה.
:::

## הגדרת DNS (מומלץ)

מכוונים את תת-הדומיינים האלה למכונה:

```
lumen.example.com    A    <vm-ip>
signal.example.com   A    <vm-ip>   # או דרך proxy של lumen-web
collab.example.com   A    <vm-ip>
```

ואז שמים מסיים TLS מלפנים (Caddy, ‏Cloudflare Tunnel, או ה-nginx הקיים
שלכם). ה-nginx שבחבילה מגיש HTTP בלבד; הפורטים ממופים 1:1 כך ש-reverse
proxy יכול לסיים SSL לפניו.

מגישים את Lumen משורש של (תת-)דומיין משלה, כמו למעלה. כותרות האבטחה שמגיעות
עם האפליקציה (הגדרות ה-nginx שבחבילה, `public/_headers` ו-`vercel.json`)
תואמות נתיבי שורש. אם בונים עם `base` של תת-נתיב כמו `/app/`, מוסיפים את
התחילית לנתיבים האלה בעצמכם, כולל הכללים של ה-Web Playground ‏(`/playground-runner.html`,
‏`/assets/*` ו-`/playground/*`). בלעדיהם התצוגה המקדימה של ה-playground נחסמת.

ב-Netlify התצוגה המקדימה של ה-Web Playground לא נטענת: פורמט ה-`_headers`
של Netlify לא יכול להסיר מעמוד ה-runner את כותרות ה-frame וה-CSP של כל
האפליקציה. ‏Cloudflare Pages,‏ Vercel והאימג׳ הזה של Docker נתמכים.

## אופציונלי: חיוב

אם רוצים לנעול תכונות Pro (שיתוף מתמשך, חיפוש סמנטי, fine-tune של AI) מאחורי
תשלום, מוסיפים פרטי Stripe ומעלים מחדש עם הפרופיל `billing`:

```bash
# ב-.env.onprem
STRIPE_SECRET_KEY=sk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx

# מעלים עם שירות החיוב
docker compose --env-file .env.onprem --profile billing up -d
```

ה-worker של החיוב מריץ `wrangler local-mode`, כך שאותו קוד שמפעיל את הפריסה
ב-Cloudflare רץ גם במכונה שלכם.

## אופציונלי: טלמטריה של Sentry

מגדירים `SENTRY_DSN=https://…@sentry.io/…` ב-`.env.onprem` כדי להפעיל דיווח
שגיאות בהסכמה. המשתמשים עדיין רואים מתג בהגדרות לכיבוי; אתם שולטים באיזה DSN.

## אופציונלי: SSO עם WorkOS

מגדירים `WORKOS_API_KEY=…` ו-`WORKOS_CLIENT_ID=…` כדי להפעיל התחברות ב-SAML /
OIDC. מנהל סביבת העבודה מדביק את כתובת המטא-נתונים של ספק הזהויות בהגדרות ←
ארגון; ‏WorkOS מטפל בפרוטוקול.

## תפעול יומיומי

| מה | פקודה |
|---|---|
| מעקב אחרי לוגים | `make onprem-logs` |
| הפעלה מחדש של הכול | `make onprem-down && make onprem-up` |
| בדיקת Postgres | `docker compose exec postgres psql -U lumen` |
| איפוס מלא (מוחק את כל הנתונים) | `make onprem-reset` |

## גיבוי

שני כרכי ה-Docker הם המצב היחיד ש-Lumen מחזיקה:

```bash
# dump של Postgres
docker compose exec postgres pg_dump -U lumen lumen | gzip > lumen-pg-$(date +%F).sql.gz

# צילומי השיתוף ב-LevelDB
docker run --rm -v lumen_collab-data:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/lumen-collab-$(date +%F).tar.gz -C /data .
```

המסמכים של המשתמשים עצמם לעולם לא יוצאים מהדפדפן — הם חיים ב-OPFS ‏(Origin
Private File System) לכל דפדפן ולכל מקור. עודדו את המשתמשים לגבות את התוכן
המקומי שלהם עם `⌘K → Export the whole vault…` (ראו
[ייצוא וייבוא](/he/workspace/export-import/)).

## עדכון Lumen

```bash
git pull
make onprem-up   # בונה מחדש אימג׳ים ומפעיל מחדש קונטיינרים
```

מיגרציות של מסד הנתונים רצות אוטומטית בהפעלת הקונטיינר
(`docker/postgres-init.sql` אידמפוטנטי).

## גודל לפי עומס

מכונה אחת עם 2 vCPU / 4 GB מטפלת ב:

- עד כ-50 חדרי שיתוף בו-זמנית (מטמון חם של LevelDB)
- כ-1,000 קריאות הרשאה בשנייה
- עלות לינארית בנפח הביקורת — כל שינוי כותב שורה אחת

לפריסות גדולות יותר מפצלים:

- `lumen-web` + `lumen-signal` על מכונה אחת (בלי מצב, ניתנים להרחבה אופקית)
- `lumen-collab` על מכונה ייעודית עם כרך EBS / Block-Storage מתמשך
- ‏Postgres על RDS / Cloud SQL מנוהל

## פתרון בעיות

| תסמין | סיבה סבירה |
|---|---|
| ‏502 מ-`lumen.example.com` | ה-reverse proxy לא מגיע ל-`lumen-web:80` |
| העורך נטען אבל השיתוף נכשל בשקט | `lumen-signal` לא זמין; בדקו את כללי שדרוג ה-WS ב-proxy |
| תכונות Pro נשארות נעולות | `lumen-billing` לא בפרופיל ה-compose, או סוד חתימת ה-webhook שגוי |
| `pg_isready` נכשל | ‏`LUMEN_PG_PASSWORD` לא תואם בין `.env.onprem` לכרך |

אם משהו אחר נשבר, `make onprem-logs` הוא החבר שלכם — התחילית לכל שירות
מקלה לזהות את האשם.
