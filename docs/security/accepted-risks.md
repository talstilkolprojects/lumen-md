# Accepted risks: low and info findings from reviews 6–34 (plan W9.5)

[עברית למטה](#סיכונים-מקובלים-ממצאים-נמוכים-ומידע-מביקורות-634-תוכנית-w95)

Every low or info finding that reviews 6–34 left open is either fixed, with a
test, or listed here with the reason it is accepted and what limits it. A
finding that is forgotten comes back, so this page is the one place that says
which residues the project carries on purpose. The table of every finding and
what was done with it is in the W9.5 pull request.

`src/__tests__/acceptedRisks.test.ts` checks that each id below appears in
both the English and the Hebrew part.

Each entry gives the finding's id and review, what remains, why it is
accepted, and what mitigates it.

## Inherent

These can't be removed by any client-side change.

- **rr7-4(a) / G4** (review 7, info). *What remains:* a pairing answer or code
  that was already handed out can't be taken back from this device; the
  other device only talks to the storage. *Why:* a snapshot given out can't
  be revoked by the one who gave it. *Mitigation:* since the pairing
  comparison (W8.5, #544) a pairing commits only after the users compare five
  symbols on both devices and press *They match* on both; the device already
  in use confirms last and keeps its hold for the new device's whole window,
  through a cancel too (S13-1), with the window under the comparison's MAC and
  bounded (S27-1, S27-2). Cancelling before *They match* stops it; the
  `e2ee.pair.cancelled` text says not to use that answer or code.
- **rr9-1(c) / H2** (review 9, low). *What remains:* a device being removed
  that still has the storage login can rewrite the device list on every try,
  so the removal never commits. *Why:* anyone who holds the epoch's keys and
  can write the storage can win every compare-and-swap. *Mitigation:* after
  the second loss Lumen says `RevocationContestedError` (counted only for a
  rewrite sealed with the epoch's keys, K6-2), and the keys page's steps for
  a lost device start with changing the storage password or token.
- **rr9-2(b) / H4** (review 9, info). *What remains:* a device re-enrolled
  while offline, then removed, can be shown an old genuine "dropped" notice by
  the storage, so it reads "pair it again" instead of "removed". *Why:* the
  notice lives outside the signed digest so the storage can carry it, and the
  device still holds only the epoch before. *Mitigation:* only the message
  changes; enrolling the same id or key again is refused.
- **RR6-469-3** (review 6, info). *What remains:* the committed room name lets
  anyone who sees it test a guess of a typed room password offline, at the
  cost of 200,000 PBKDF2 iterations a guess. *Why:* any commitment the server
  can check gives the same test to anyone who sees it. *Mitigation:* the
  default room password is 128-bit random; only a password the user types is
  exposed; Workers Logs stay off.
- **V2** (review 15, info). *What remains:* a note whose new content has the
  same modification time and the same size as before keeps the old text in
  the saved index until it changes again. *Why:* no backend lists a content
  hash, and hashing every note on open would undo the snapshot. *Mitigation:*
  the time and the size must both match (S3, V1); the next edit, a vault
  switch or a conversion re-reads it.

## Accepted decisions

- **RR18-469-2** (review 18, low). *What remains:* on the free relay, each
  IPv4 address counts as another person, so holding the store with protected
  rooms takes about 200 owner values returning every 14 days; a creator who
  comes back over its own IPv6 counts as someone else. *Why:* the free relay
  has no accounts, by decision. *Mitigation:* caps per address, per /48 and
  per owner value in bytes; eviction takes over-cap owners first; private
  servers use `COLLAB_ACCESS_KEY`.
- **M2** (review 21, low). *What remains:* without `--client`, the MCP server
  takes the client's name from what the client reports. *Why:* the app that
  starts the server chooses `--client` anyway, so no name proves anything.
  *Mitigation:* grants keep apart the apps the user set up; every write waits
  for the user's approval; the MCP page (en, he) says so.
- **B1r** (review 24, low). *What remains:* the approval command's terminal
  check can be scripted (`script`, `expect`). *Why:* an agent with a shell
  can edit the note directly, so the command line was never a boundary
  against it. *Mitigation:* no tool answer names an approval command; there
  is no `--all`; every diff is shown and needs a typed yes; the code's
  comments say the check stops accidents, not an agent.
- **R12-15** (reviews 4 and 6, low). *What remains:* the relay checks each
  Yjs update of an end-to-end encrypted room (`checkE2eeUpdate`), which costs
  work per update. *Why:* the check is what keeps plaintext out of an
  encrypted room. *Mitigation:* a room holds at most `MAX_ROOM_BYTES`
  (4,000,000), and a room is limited to 50 sockets.
- **RR2-483-5** (reviews 2, 6 and 8, low). *What remains:* once the vault
  relay's total cap is filled, writes that grow a space get 507 until spaces
  expire. *Why:* the relay is one the user or the school runs; a global cap is
  the operator's limit. *Mitigation:* new spaces per address and per /48 a
  day, per-space caps and retention; the operator sets
  `VAULT_RELAY_MAX_TOTAL` and can clear the store.
- **RR8-469-5** (review 8, info). *What remains:* 50 sockets that never send
  the room token fill a room whose name is known. *Why:* the name is a
  128-bit value in the invitation; whoever has it was invited. *Mitigation:*
  the client says "room full"; nothing stored is lost; eviction never counts
  a socket that didn't authenticate as in use (RR8-469-2).
- **Standard.site language** (W7.19, info). *What remains:* a published
  `site.standard.document` carries no language or direction. *Why:* the
  lexicon has no such field, and Lumen doesn't invent one. *Mitigation:*
  Hebrew text carries its own direction; the site's pages set `lang` and
  `dir` (`docs/src/content/docs/sync/standard-site.md`).
- **RR20-596-3, RR20-596-4, RR20-596-5** (review 20, low and info). *What
  remains:* #596 keeps the App Password, uses `*.bsky.network`. *Why:* #596
  is in no train; review 20 recommended keeping #587 instead, which keeps
  tokens in memory and allows only `*.host.bsky.network`. *Mitigation:* if
  #596 is ever revived, these and its high finding are fixed first.

## Latent or narrow, with a guard

- **X6 / RR11-451-2** (reviews 11, 14, 18 and 32, info). *What remains:* a
  frame inside a closed declarative shadow root (`setHTMLUnsafe`,
  `parseHTMLUnsafe`) is out of airplane mode's reach. *Why:* such a root is
  never handed to the page's code. *Mitigation:* no app file builds one
  (`airplaneDeclarativeShadow.test.ts`), the sanitizers drop `template`, and
  the certificate says it is out of reach.
- **RR6-451-2 E7** (reviews 11 and 32, trade-off). *What remains:* a window an
  embed opened before the switch keeps loading. *Why:* a page can't close a
  window another site opened. *Mitigation:* it is counted, from the moment
  the frame was made, and the certificate says it isn't closed.
- **Z3** (review 22, info). *What remains:* a change that raises no event,
  such as another tab writing the same OPFS vault, keeps the old text in the
  index until the next revalidation. *Why:* OPFS has no change events.
  *Mitigation:* the index revalidates every 30 s (`REVALIDATE_MS`), and the
  check's own timeout bounds the kept listing.
- **S2** (reviews 9 and 10, info). *What remains:* a whole older sealed
  snapshot of the same vault is accepted. *Why:* by design, a rollback only
  costs re-reading. *Mitigation:* every note is checked against the listing
  before a query answers.
- **S4 / T6** (reviews 9, 10 and 12, info). *What remains:* deleting an
  IndexedDB record does not erase its bytes on disk, and a plain save that
  was in flight during a conversion exists between its write and its
  deletion. *Why:* a browser can't erase disk blocks. *Mitigation:* the save
  checks the mode again and drops a record that no longer fits; the text was
  plain in the vault moments before; disk encryption is the system's.
- **Z2, Z4, Q3, R4** (reviews 22 and 29, info). *What remains:* a copied
  folder shares the plain saved index (checked note by note); a `vault-id`
  that isn't a UUID is replaced, and is never used as a path; a reconnect of
  the same vault is a false drop (one rebuild); a retried build waits for an
  unlock or a switch. *Why:* each fails safe. *Mitigation:* an encrypted vault
  opens only its own sealed index; the docs say so.
- **H5** (review 9, info). *What remains:* when the pre-commit pairing
  recheck fires, it leaves this device's own freeze, so rounds wait out the
  freeze; and a state from before the remembered removals could miss one
  fork. *Why:* every writer of the hold runs under the same lock, so the
  recheck only fires in a forced test, and the second case is pre-release
  state only. *Mitigation:* the device lock across tabs (H3, K6-1); the keys
  page says a removed device is paired again as a new device.
- **K6-4 and review 34's notes** (reviews 16 and 34, info). *What remains:* a
  storage call that never answers holds the device lock until the tab
  closes; without Web Locks the in-page lock is named per state store; a
  storage can hide or replay the "contested" hint. *Why:* there is no request
  timeout for every provider, and every supported browser has Web Locks.
  *Mitigation:* a key change waits at most 8 s for another tab's round, then
  says "busy" (K34-1); the hint only changes a message.
- **Review 7's notes** (info). *What remains:* pre-release builds of the
  older pairing format can still reflect among themselves; a pre-W1.7 build
  can't open an Argon2id upgrade; the dropped notice is unauthenticated at
  unlock; a device that missed a removal can be forked by the removed device
  together with the storage. *Why:* the first two are pre-release only; the
  last is spec §9 ("a removal is only as current as the other devices'
  view"). *Mitigation:* the notice only changes a message; nothing acts on it.
- **RR8-473-3** (reviews 8, 11 and 26, info). *What remains:* the offline
  fuzz ran with `micromark-extension-directive` 4.0.0, while the lockfile
  pins 3.0.2. *Why:* only 4.0.0 is installed offline. *Mitigation:* trains
  refuse a `node_modules` other than the lockfile's (W8.9), so the build runs
  3.0.2; owed: one fuzz run after `npm ci`.
- **C1, C2, C4 residues** (review 24, info). *What remains:* tool and property
  names reach the model; the MCP fetch binding holds only for a transport
  built on `ctx.fetch`; `resource` at the token endpoint and keeping tokens in
  the secret store are owed. *Why:* there is no production transport or
  OAuth flow yet. *Mitigation:* offering MCP tools taints the run; these
  become required when the flow is wired.
- **D1 residue** (review 24, info). *What remains:* a vault in a subfolder of a
  repository, or a synced folder without `.git`, counts as the user's own.
  *Why:* there is no reliable sign of where a folder came from. *Mitigation:*
  each version of a vault skill asks once on this device.
- **RR30 notes** (review 30, info). *What remains:* `notes/CON.md` (a Windows
  device name) is allowed; `A: plan.md` is refused as a drive prefix. *Why:*
  neither is an agent control file. *Mitigation:* a write to a device name
  fails on Windows, and the Windows vault refuses `:` on its own.
- **RR25 notes** (review 25, info). *What remains:* a dataset refresh reads the
  old snapshot without its hash (to compute the diff only); Ben-Yehuda works
  rely on the commit pin and TLS, with no hash per work; a response without a
  stream body is read whole before the size check. *Why:* each is bounded by
  the path rule, the pin or the engine. *Mitigation:* the catalogue is hashed
  on every load; the index lists only pinned ids.
- **RR20 Knesset host and RR23-587-3** (reviews 20 and 23, info). *What
  remains:* the ledger names `main.knesset.gov.il`, which the CSP doesn't
  allow; a published record carries the note's vault path. *Why:* the first
  is harmless; the second is what the static site already publishes.
  *Mitigation:* publishing is one note at a time, after a confirmation that
  says the record is public.
- **T5-1 note** (review 16, UI). *What remains:* locking while a plain vault
  is open, with another encrypted vault unlocked, can show the unlock screen
  over the plain vault. *Why:* UI only; no key or text is exposed.
  *Mitigation:* every session's keys are forgotten on lock (T5).

## Closed without a change

Observations that needed no code: RR11-473-1 (the reviewers' oracle),
RR14-469-3 (re-scaled tests, review 18), RR18-469-3 (a label in a lane's
scratch test, not in the repository), S13-3, S27-3, S27-4 and the #545 UI
(checks that hold), S13-4 (the usability script has the line), N3 (closed by
L1's binding).

---

# סיכונים מקובלים: ממצאים נמוכים ומידע מביקורות 6–34 (תוכנית W9.5)

כל ממצא נמוך או מידע שביקורות 6–34 השאירו פתוח תוקן, עם בדיקה, או רשום כאן עם
הסיבה שהוא מקובל ומה מגביל אותו. ממצא שנשכח חוזר, ולכן זה המקום האחד שאומר אילו
שאריות הפרויקט נושא בכוונה. הטבלה של כל ממצא ומה נעשה איתו נמצאת בבקשת המיזוג
של W9.5.

`src/__tests__/acceptedRisks.test.ts` בודק שכל מזהה כאן מופיע גם בחלק האנגלי וגם
בחלק העברי.

לכל רשומה: מזהה הממצא והביקורת, מה נשאר, למה זה מקובל, ומה מצמצם את זה.

## מובנים

אי אפשר להסיר אותם בשום שינוי בצד הלקוח.

- **rr7-4(a) / G4** (ביקורת 7, מידע). *מה נשאר:* תשובת צימוד או קוד שכבר נמסרו
  אי אפשר לקחת בחזרה מהמכשיר הזה; המכשיר השני מדבר רק עם האחסון. *למה:* מי
  שמסר תמונת מצב לא יכול לבטל אותה. *מה מצמצם:* מאז השוואת הצימוד (W8.5, ‏#544)
  צימוד נקבע רק אחרי שהמשתמשים משווים חמישה סמלים בשני המכשירים ולוחצים *הם
  זהים* בשניהם; המכשיר שכבר בשימוש מאשר אחרון ושומר את ההחזקה לכל חלון המכשיר
  החדש, גם אחרי ביטול (S13-1), והחלון מוגן ב-MAC של ההשוואה ותחום (S27-1,
  ‏S27-2). ביטול לפני *הם זהים* עוצר את הצימוד; הטקסט `e2ee.pair.cancelled` אומר
  לא להשתמש בתשובה או בקוד.
- **rr9-1(c) / H2** (ביקורת 9, נמוך). *מה נשאר:* מכשיר שמסירים ועדיין יש לו את
  פרטי הכניסה לאחסון יכול לכתוב מחדש את רשימת המכשירים בכל ניסיון, כך שההסרה
  לא נקבעת. *למה:* מי שמחזיק את מפתחות התקופה ויכול לכתוב לאחסון מנצח כל
  השוואה־והחלפה. *מה מצמצם:* מההפסד השני Lumen מציגה `RevocationContestedError`
  (נספר רק לכתיבה חתומה במפתחות התקופה, K6-2), ודף המפתחות פותח את הצעדים
  למכשיר שאבד בהחלפת הסיסמה או הטוקן של האחסון.
- **rr9-2(b) / H4** (ביקורת 9, מידע). *מה נשאר:* למכשיר שצורף מחדש בלי חיבור
  ואחר כך הוסר, האחסון יכול להציג הודעת "הוצא" ישנה ואמיתית, והוא קורא "צמדו
  אותו שוב" במקום "הוסר". *למה:* ההודעה נמצאת מחוץ לתקציר החתום כדי שהאחסון
  יוכל לשאת אותה, והמכשיר מחזיק רק את התקופה הקודמת. *מה מצמצם:* רק ההודעה
  משתנה; צירוף מחדש של אותו מזהה או מפתח נדחה.
- **RR6-469-3** (ביקורת 6, מידע). *מה נשאר:* שם החדר המחויב מאפשר לכל מי שרואה
  אותו לבדוק ניחוש של סיסמת חדר שהוקלדה, בלי חיבור, במחיר 200,000 סבבי PBKDF2
  לניחוש. *למה:* כל התחייבות שהשרת יכול לבדוק נותנת את אותה בדיקה לכל מי שרואה
  אותה. *מה מצמצם:* סיסמת החדר כברירת מחדל אקראית ב-128 ביט; חשופה רק סיסמה
  שהמשתמש מקליד; Workers Logs כבויים.
- **V2** (ביקורת 15, מידע). *מה נשאר:* פתק שתוכנו החדש באותו זמן שינוי ובאותו
  גודל שומר את הטקסט הישן באינדקס השמור עד שישתנה שוב. *למה:* אף מקור אחסון לא
  מציג hash של התוכן, וחישוב hash לכל פתק בפתיחה היה מבטל את תמונת המצב. *מה
  מצמצם:* גם הזמן וגם הגודל צריכים להתאים (S3, ‏V1); העריכה הבאה, החלפת כספת או
  המרה קוראות אותו מחדש.

## החלטות מקובלות

- **RR18-469-2** (ביקורת 18, נמוך). *מה נשאר:* בממסר החינמי כל כתובת IPv4 נספרת
  כאדם אחר, כך שהחזקת האחסון בחדרים מוגנים דורשת כ-200 ערכי בעלים שחוזרים כל 14
  יום; יוצר שחוזר דרך ה-IPv6 שלו נספר כמישהו אחר. *למה:* לממסר החינמי אין
  חשבונות, בהחלטה. *מה מצמצם:* מכסות לכתובת, ל-/48 ולערך בעלים בבתים; הפינוי
  מתחיל בבעלים שחרגו; שרתים פרטיים משתמשים ב-`COLLAB_ACCESS_KEY`.
- **M2** (ביקורת 21, נמוך). *מה נשאר:* בלי `--client`, שרת ה-MCP לוקח את שם
  הלקוח ממה שהלקוח מדווח. *למה:* האפליקציה שמפעילה את השרת בוחרת את `--client`
  בכל מקרה, כך ששום שם לא מוכיח דבר. *מה מצמצם:* ההרשאות מפרידות בין האפליקציות
  שהמשתמש הגדיר; כל כתיבה מחכה לאישור המשתמש; דף ה-MCP (אנגלית ועברית) אומר
  זאת.
- **B1r** (ביקורת 24, נמוך). *מה נשאר:* בדיקת המסוף של פקודת האישור ניתנת
  לתסריט (`script`, ‏`expect`). *למה:* סוכן עם shell יכול לערוך את הפתק ישירות,
  כך ששורת הפקודה מעולם לא הייתה גבול מולו. *מה מצמצם:* שום תשובת כלי לא נוקבת
  בפקודת אישור; אין `--all`; כל הבדל מוצג ודורש yes מוקלד; ההערות בקוד אומרות
  שהבדיקה עוצרת טעויות, לא סוכן.
- **R12-15** (ביקורות 4 ו-6, נמוך). *מה נשאר:* הממסר בודק כל עדכון Yjs של חדר
  מוצפן מקצה לקצה (`checkE2eeUpdate`), וזה עולה עבודה לכל עדכון. *למה:* הבדיקה
  היא מה ששומר טקסט גלוי מחוץ לחדר מוצפן. *מה מצמצם:* חדר מחזיק לכל היותר
  `MAX_ROOM_BYTES` (4,000,000), ובחדר עד 50 שקעים.
- **RR2-483-5** (ביקורות 2, 6 ו-8, נמוך). *מה נשאר:* כשהמכסה הכוללת של ממסר
  הכספות מתמלאת, כתיבות שמגדילות מרחב מקבלות 507 עד שמרחבים פגים. *למה:* הממסר
  הוא של המשתמש או של בית הספר; המכסה הכוללת היא הגבול של המפעיל. *מה מצמצם:*
  מרחבים חדשים ביום לכתובת ול-/48, מכסה לכל מרחב ותוקף; המפעיל קובע את
  `VAULT_RELAY_MAX_TOTAL` ויכול לנקות את האחסון.
- **RR8-469-5** (ביקורת 8, מידע). *מה נשאר:* 50 שקעים שלא שולחים את טוקן החדר
  ממלאים חדר ששמו ידוע. *למה:* השם הוא ערך של 128 ביט בהזמנה; מי שמחזיק אותו
  הוזמן. *מה מצמצם:* הלקוח אומר "החדר מלא"; שום דבר שמור לא אובד; הפינוי לא
  סופר שקע שלא הזדהה כשקע בשימוש (RR8-469-2).
- **שפה ב-Standard.site** (W7.19, מידע). *מה נשאר:* רשומת
  `site.standard.document` שמתפרסמת לא נושאת שפה או כיוון. *למה:* ללקסיקון אין
  שדה כזה, ו-Lumen לא ממציאה אחד. *מה מצמצם:* טקסט עברי נושא את הכיוון שלו;
  עמודי האתר קובעים `lang` ו-`dir` (`docs/src/content/docs/sync/standard-site.md`).
- **RR20-596-3, ‏RR20-596-4, ‏RR20-596-5** (ביקורת 20, נמוך ומידע). *מה נשאר:*
  ‏#596 שומרת את סיסמת האפליקציה ומשתמשת ב-`*.bsky.network`. *למה:* ‏#596 לא
  נמצאת באף רכבת; ביקורת 20 המליצה להשאיר את #587 במקומה, שמחזיקה טוקנים בזיכרון
  בלבד ומתירה רק `*.host.bsky.network`. *מה מצמצם:* אם #596 תחזור, הממצאים האלה
  והממצא הגבוה שלה יתוקנו קודם.

## רדומים או צרים, עם שמירה

- **X6 / RR11-451-2** (ביקורות 11, 14, 18 ו-32, מידע). *מה נשאר:* מסגרת בתוך
  shadow root הצהרתי סגור (`setHTMLUnsafe`, ‏`parseHTMLUnsafe`) מחוץ להישג של מצב
  טיסה. *למה:* שורש כזה אף פעם לא נמסר לקוד של הדף. *מה מצמצם:* אף קובץ של
  האפליקציה לא בונה כזה (`airplaneDeclarativeShadow.test.ts`), המנקים מסירים
  `template`, והתעודה אומרת שהוא מחוץ להישג.
- **RR6-451-2 E7** (ביקורות 11 ו-32, פשרה). *מה נשאר:* חלון שהטמעה פתחה לפני
  ההפעלה ממשיך להיטען. *למה:* דף לא יכול לסגור חלון שאתר אחר פתח. *מה מצמצם:*
  הוא נספר, מהרגע שהמסגרת נוצרה, והתעודה אומרת שהוא לא נסגר.
- **Z3** (ביקורת 22, מידע). *מה נשאר:* שינוי שלא מעלה אירוע, כמו לשונית אחרת
  שכותבת לאותה כספת OPFS, משאיר את הטקסט הישן באינדקס עד הבדיקה החוזרת הבאה.
  *למה:* ל-OPFS אין אירועי שינוי. *מה מצמצם:* האינדקס נבדק מחדש כל 30 שניות
  (`REVALIDATE_MS`), ומגבלת הזמן של הבדיקה תוחמת את הרשימה השמורה.
- **S2** (ביקורות 9 ו-10, מידע). *מה נשאר:* תמונת מצב חתומה ישנה שלמה של אותה
  כספת מתקבלת. *למה:* בכוונה: חזרה לאחור עולה רק קריאה מחדש. *מה מצמצם:* כל
  פתק נבדק מול הרשימה לפני ששאילתה עונה.
- **S4 / T6** (ביקורות 9, 10 ו-12, מידע). *מה נשאר:* מחיקת רשומה ב-IndexedDB לא
  מוחקת את הבתים שלה מהדיסק, ושמירה גלויה שהייתה בדרך בזמן המרה קיימת בין
  הכתיבה שלה למחיקה. *למה:* דפדפן לא יכול למחוק בלוקים בדיסק. *מה מצמצם:*
  השמירה בודקת שוב את המצב ומוחקת רשומה שכבר לא מתאימה; הטקסט היה גלוי בכספת
  רגע לפני; הצפנת הדיסק היא של המערכת.
- **Z2, ‏Z4, ‏Q3, ‏R4** (ביקורות 22 ו-29, מידע). *מה נשאר:* תיקייה מועתקת חולקת
  את האינדקס השמור הגלוי (נבדק פתק אחר פתק); `vault-id` שאינו UUID מוחלף ולעולם
  לא משמש כנתיב; חיבור מחדש של אותה כספת הוא השלכה מיותרת (בנייה אחת); בנייה
  חוזרת מחכה לפתיחה או להחלפה. *למה:* כל אחד נכשל בצד הבטוח. *מה מצמצם:* כספת
  מוצפנת פותחת רק את האינדקס החתום שלה; התיעוד אומר זאת.
- **H5** (ביקורת 9, מידע). *מה נשאר:* כשהבדיקה החוזרת של הצימוד לפני ההתחייבות
  נדלקת, היא משאירה את ההקפאה של המכשיר עצמו, והסבבים מחכים לסופה; ומצב מלפני
  ההסרות הנזכרות עלול לפספס פיצול אחד. *למה:* כל כותב של ההחזקה רץ תחת אותה
  נעילה, כך שהבדיקה נדלקת רק בבדיקה מאולצת, והמקרה השני הוא מצב מלפני ההשקה
  בלבד. *מה מצמצם:* נעילת המכשיר בין לשוניות (H3, ‏K6-1); דף המפתחות אומר שמכשיר
  שהוסר מצומד שוב כמכשיר חדש.
- **K6-4 וההערות של ביקורת 34** (ביקורות 16 ו-34, מידע). *מה נשאר:* קריאה
  לאחסון שלא עונה מחזיקה את נעילת המכשיר עד שהלשונית נסגרת; בלי Web Locks
  הנעילה בתוך הדף נקראת לפי מאגר המצב; האחסון יכול להסתיר או להשמיע מחדש את
  הרמז "מתמודד". *למה:* אין מגבלת זמן לבקשה בכל ספק, ובכל דפדפן נתמך יש Web
  Locks. *מה מצמצם:* החלפת מפתחות מחכה לכל היותר 8 שניות לסבב של לשונית אחרת,
  ואז אומרת "עסוק" (K34-1); הרמז משנה רק הודעה.
- **ההערות של ביקורת 7** (מידע). *מה נשאר:* גרסאות טרום־השקה של פורמט הצימוד
  הישן עדיין יכולות להשתקף ביניהן; גרסה מלפני W1.7 לא פותחת שדרוג Argon2id;
  הודעת ההוצאה לא מאומתת בפתיחה; מכשיר שפספס הסרה יכול להתפצל על ידי המכשיר
  שהוסר יחד עם האחסון. *למה:* השניים הראשונים הם טרום־השקה בלבד; האחרון הוא
  סעיף 9 במפרט ("הסרה עדכנית רק כמו התצוגה של המכשירים האחרים"). *מה מצמצם:*
  ההודעה משנה רק טקסט; שום דבר לא פועל לפיה.
- **RR8-473-3** (ביקורות 8, 11 ו-26, מידע). *מה נשאר:* ה-fuzz בלי חיבור רץ עם
  `micromark-extension-directive` 4.0.0, בעוד קובץ הנעילה קובע 3.0.2. *למה:* רק
  4.0.0 מותקנת בלי חיבור. *מה מצמצם:* הרכבות דוחות `node_modules` שאינו של קובץ
  הנעילה (W8.9), כך שהבנייה רצה עם 3.0.2; חייבים: הרצת fuzz אחת אחרי `npm ci`.
- **שאריות C1, ‏C2, ‏C4** (ביקורת 24, מידע). *מה נשאר:* שמות כלים ומאפיינים
  מגיעים למודל; הקישור של ה-fetch של MCP מחזיק רק לתעבורה שבנויה על `ctx.fetch`;
  `resource` בנקודת הטוקן ושמירת טוקנים במאגר הסודות עדיין חייבים. *למה:* אין
  עדיין תעבורה או זרימת OAuth בייצור. *מה מצמצם:* הצעת כלי MCP מסמנת את הריצה
  כלא־מהימנה; אלה נעשים חובה כשהזרימה מחוברת.
- **שארית D1** (ביקורת 24, מידע). *מה נשאר:* כספת בתת־תיקייה של מאגר, או תיקייה
  מסונכרנת בלי `.git`, נחשבת של המשתמש. *למה:* אין סימן אמין למקור של תיקייה.
  *מה מצמצם:* כל גרסה של מיומנות מהכספת שואלת פעם אחת במכשיר הזה.
- **ההערות של RR30** (ביקורת 30, מידע). *מה נשאר:* `notes/CON.md` (שם התקן
  ב-Windows) מותר; `A: plan.md` נדחה כקידומת כונן. *למה:* אף אחד מהם אינו קובץ
  בקרה של סוכן. *מה מצמצם:* כתיבה לשם התקן נכשלת ב-Windows, והכספת ב-Windows
  דוחה `:` בעצמה.
- **ההערות של RR25** (ביקורת 25, מידע). *מה נשאר:* רענון מאגר נתונים קורא את
  תמונת המצב הישנה בלי ה-hash שלה (רק לחישוב ההבדל); יצירות בן־יהודה סומכות על
  נעיצת הקומיט ועל TLS, בלי hash ליצירה; תשובה בלי גוף זורם נקראת שלמה לפני
  בדיקת הגודל. *למה:* כל אחד תחום בכלל הנתיב, בנעיצה או במנוע. *מה מצמצם:*
  הקטלוג עובר hash בכל טעינה; האינדקס מציג רק מזהים נעוצים.
- **מארח הכנסת ו-RR23-587-3** (ביקורות 20 ו-23, מידע). *מה נשאר:* היומן נוקב
  ב-`main.knesset.gov.il`, שה-CSP לא מתיר; רשומה שמתפרסמת נושאת את נתיב הפתק
  בכספת. *למה:* הראשון לא מזיק; השני הוא מה שהאתר הסטטי כבר מפרסם. *מה מצמצם:*
  פרסום הוא פתק אחד בכל פעם, אחרי אישור שאומר שהרשומה ציבורית.
- **הערת T5-1** (ביקורת 16, ממשק). *מה נשאר:* נעילה כשכספת גלויה פתוחה, וכספת
  מוצפנת אחרת פתוחה, יכולה להציג את מסך הפתיחה מעל הכספת הגלויה. *למה:* ממשק
  בלבד; שום מפתח או טקסט לא נחשפים. *מה מצמצם:* המפתחות של כל ההפעלות נשכחים
  בנעילה (T5).

## נסגרו בלי שינוי

הערות שלא דרשו קוד: RR11-473-1 (האורקל של הסוקרים), RR14-469-3 (בדיקות שהותאמו
לקנה מידה, ביקורת 18), RR18-469-3 (תווית בבדיקת טיוטה של מסלול, לא במאגר),
S13-3, ‏S27-3, ‏S27-4 והממשק של #545 (בדיקות שמחזיקות), S13-4 (בתסריט השמישות יש
את השורה), N3 (נסגר בקישור של L1).
