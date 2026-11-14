# دليل مراجعة الترجمة العربية في Lumen · Arabic reviewer brief (W6.32)

*(English below.)*

## ما هو Lumen؟

‏Lumen محرّر ملاحظات بصيغة Markdown، مفتوح المصدر (رخصة MIT)، يعمل على الجهاز نفسه: تبقى الملاحظات على حاسوبك أو هاتفك، ويعمل التطبيق دون إنترنت. صُمّم أولًا للعبرية، ويدعم العربية والكتابة من اليمين إلى اليسار دعمًا كاملًا.

تُرجمت واجهة التطبيق إلى العربية **ترجمةً آلية**، ولم يراجعها حتى الآن أيّ متحدّث بالعربية، ولذلك تظهر العربية في التطبيق بعلامة «تجريبي». نبحث عن متحدّثين بالعربية من إسرائيل لمراجعة النصوص، لأن الترجمة الآلية دون مراجعة تُضعف ثقة المستخدمين.

## ماذا نطلب منك؟

1. ادخل إلى ‏Hosted Weblate ‏(hosted.weblate.org)، ويمكنك استخدام حساب GitHub.
2. افتح مشروع **Lumen** واختر **العربية**.
3. ابدأ بالمكوّنات بهذا الترتيب: `cmd` ثم `common` ثم `ai` ثم `files` ثم `editor` ثم `settings` ثم `toast` ثم `canvas`. هذه هي «نصوص بدء التشغيل»، أي ما يراه المستخدم قبل فتح أيّ شاشة أخرى، وعددها 1651 نصًّا.
4. في كل نص: **وافِق** عليه إن كان مكتوبًا كما يكتبه متحدّث أصلي، أو **صحّحه**.

لا يُطلب منك إنهاء كل شيء دفعةً واحدة. نصف ساعة من المراجعة مفيدة جدًّا.

## قواعد الأسلوب

- **العربية الفصحى المعاصرة** الواضحة والبسيطة، كما في التطبيقات المعروفة. تجنّب العامية والأسلوب الأدبي المتكلّف.
- **خاطِب المستخدم مباشرةً** بصيغة الأمر في الأزرار والأوامر («احفظ»، «افتح الملف»)، وبجمل قصيرة في الرسائل.
- **حافظ على الرموز بين الأقواس المعقوفة كما هي تمامًا**: `{name}` و`{count}` و`{error}`. لا تترجمها ولا تحذفها ولا تضف رموزًا جديدة. يتحقّق ‏Weblate من ذلك أيضًا.
- **الأرقام**: استخدم الأرقام الغربية (1، 2، 3)، كما في الأصل.
- **المصطلحات التقنية**: اترك أسماء مثل Markdown وGit وGitHub وPDF كما هي. ترجم المصطلحات الشائعة: note = ملاحظة، vault = خزنة الملاحظات، plugin = إضافة، sync = مزامنة، tag = وسم، backlink = رابط عكسي.
- **علامات الترقيم العربية**: الفاصلة «،» وعلامة الاستفهام «؟» وعلامتا التنصيص «» بدل "".
- **الاتجاه**: إن احتوى النص على كلمة إنجليزية أو مسار ملف، فتأكّد أن الجملة تُقرأ بشكل صحيح من اليمين إلى اليسار. إن لم تكن متأكدًا، اترك تعليقًا على النص في Weblate.
- **لا تترجم حرفيًّا**: إن كان المعنى أوضح بصياغة أخرى، فاكتبها كما يقولها متحدّث أصلي.
- **الطول**: حاول ألّا يزيد النص كثيرًا عن الأصل، خاصةً في الأزرار.

## إن لم تكن متأكدًا

- اكتب **اقتراحًا** بدل الموافقة، أو اترك **تعليقًا** على النص في Weblate.
- لرؤية النص داخل التطبيق: افتح https://lumen-md.vercel.app، ثم اختر من «الإعدادات ← عام ← اللغة» العربية.
- يمكنك أيضًا اقتراح تحسين من داخل التطبيق: لوحة الأوامر ← «اقترح ترجمة أفضل».

## متى تخرج العربية من «التجريبي»؟

حين يُراجَع **100٪ من نصوص بدء التشغيل** (1651 نصًّا) على يد متحدّث بالعربية. عندها تُزال علامة «تجريبي»، ويُذكر اسمك في صفحة المساهمين في الترجمة، إن رغبت في ذلك.

شكرًا لك.

---

## English

**Lumen** is an open-source (MIT), local-first Markdown note editor. Notes stay on your device, and the app works offline. It is Hebrew-first and fully supports Arabic and right-to-left writing.

Its Arabic interface was **translated by machine** and no Arabic speaker has reviewed it yet, so Lumen marks Arabic as **beta**. We are looking for Arabic speakers in Israel to review it.

**What we ask**
1. Sign in to Hosted Weblate (a GitHub account works), open **Lumen**, and choose **Arabic**.
2. Go through the components in this order: `cmd`, `common`, `ai`, `files`, `editor`, `settings`, `toast`, `canvas`. These are the **1,651 startup strings**, the interface before any other screen opens.
3. For each string, **approve** it or **fix** it. Half an hour already helps.

**Style**
- Clear Modern Standard Arabic, as in well-known apps. No dialect, no literary flourishes.
- Imperatives on buttons and commands; short sentences in messages.
- Keep every `{placeholder}` exactly as it is.
- Use Western digits.
- Keep product names (Markdown, Git, PDF) as they are. Use the glossary: note = ملاحظة, vault = خزنة الملاحظات, plugin = إضافة, sync = مزامنة, tag = وسم, backlink = رابط عكسي.
- Use Arabic punctuation (، ؟ «»).
- Check that mixed-direction strings read correctly right to left.
- Don't translate word for word, and keep buttons short.

**When unsure**, leave a suggestion or a comment in Weblate, or see the string in the app (https://lumen-md.vercel.app, Settings → General → Language → العربية).

**Arabic leaves beta** when 100 % of the startup strings have been reviewed by a speaker. Reviewers are credited if they wish.

**For the maintainers:** progress is per component in Weblate (strings approved). `npm run i18n:weblate -- --queue ar` prints the order and counts. When the startup set is at 100 %, change `ar` to `"reviewed"` in `src/i18n/review.ts`.
