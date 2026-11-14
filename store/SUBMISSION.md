# Store submission checklist (plan 13.7)

> **The submission is Tal's**, with the store accounts (plan 15.7). Everything
> that can be prepared in the repository is ready, and this file is the
> order to do the rest in.
>
> The task closes **when a build is sent for review in at least one store**:
> a build number, a TestFlight link or an internal-track release. The store's
> approval, which takes days, is a separate milestone, recorded when it comes.

## What's ready

| What | Where | How it's checked |
|---|---|---|
| Listings in English and Hebrew: name, subtitle, keywords, promotional text, description, release notes, review notes | `store/listing.json` → `fastlane/metadata/**` | `node scripts/store.mjs check`: each store's limits, with App Store keywords in UTF-8 bytes (a Hebrew letter is 2) |
| Privacy-label answers, question by question | `store/privacy-answers.md`, from `store/privacy-labels.json` (plan W2.24) | the same check; the labels file's own test (in #395) ties it to the privacy ledger and the audits |
| Screenshots: iPhone 6.9″, iPad 13″, Android phone and desktop, in Hebrew and English | `node scripts/store-screenshots.mjs` → `store/screenshots/` | the script checks each PNG's exact pixel size |
| winget manifests and a Homebrew cask | `node scripts/store.mjs desktop …` → `store/desktop/` | filled from the release's `SHA256SUMS` (plan 13.4) |

## 0. Before any store

- [ ] Build the release from the merged train (plan W1.1), not a feature branch: `node scripts/release.mjs prepare --commit --tag`, then `build` (plan 13.4).
- [ ] Check the listing against that build: every line of the description must be true of it. The listing describes the integrated product.
- [ ] Take the screenshots from that build:
      `npm run build && npx vite preview --port 4173 &` then
      `node scripts/store-screenshots.mjs --base http://localhost:4173`.
      Look at each one: no real notes, nothing cut off, Hebrew right to left.
- [ ] Privacy policy URL works: `PRIVACY.md` on GitHub (`store/listing.json` → `urls.privacy`).
- [ ] The store build is made **without** `VITE_SENTRY_DSN`. This keeps "data not collected" true; see `store/privacy-answers.md`.

## 1. Apple: App Store and TestFlight

Account: Apple Developer Program (15.7). App ID: `com.lumen.editor`.

- [ ] App Store Connect → **My Apps → +**:
      - name: from `fastlane/metadata/en-US/name.txt`;
      - primary language: English (U.S.);
      - bundle ID: `com.lumen.editor`;
      - SKU: `lumen-ios`.
- [ ] **App Information:**
      - category: Productivity;
      - content rights: no third-party content;
      - age rating: answer *None* to every question, which gives 4+.
- [ ] **Localizations:** add **Hebrew**, then fill both from `fastlane/metadata/{en-US,he}/`. Or run `fastlane deliver --skip_binary_upload --skip_screenshots` with `fastlane/metadata` as the metadata path.
- [ ] **App Privacy:** answer from `store/privacy-answers.md` → *App Store Connect*. Privacy policy URL from `privacy_url.txt`.
- [ ] **Pricing:** Free, in all territories.
- [ ] **Export compliance:** Lumen encrypts with the system's standard algorithms (WebCrypto AES-GCM; HTTPS). Apple's guidance usually treats this as exempt. **Confirm the answer with Apple's export-compliance questions** before setting `ITSAppUsesNonExemptEncryption` in `ios/App/App/Info.plist`; it isn't set yet, so App Store Connect asks on upload.
- [ ] Xcode → Product → **Archive** → Distribute → App Store Connect (signing team from 15.7). Steps are in RELEASE.md §3.
- [ ] **TestFlight:**
      - internal testers first;
      - *What to Test* from `release_notes.txt`, in both languages;
      - beta review is needed for external testers.
- [ ] **Screenshots:** iPhone 6.9″ (`store/screenshots/iphone-6.9/{en,he}/`) and iPad 13″ (`ipad-13`), per localization.
- [ ] **App Review Information:**
      - notes from `fastlane/metadata/review_information/notes.txt`;
      - no demo account needed;
      - contact: Tal.
- [ ] **Submit for Review.** Record the build number here: ______

## 2. Google Play: internal testing first

Account: Google Play Console (15.7). Package: `com.lumen.editor`.

- [ ] Play Console → **Create app**:
      - default language: English (United States);
      - app: free;
      - accept the declarations.
- [ ] **Store listing:** English and **Hebrew (iw-IL)** from `fastlane/metadata/android/{en-US,iw-IL}/`. Or run `fastlane supply --skip_upload_apk --skip_upload_aab` with that metadata path.
- [ ] **Graphics:**
      - icon 512×512;
      - feature graphic 1024×500 (not generated: make one from `public/icons/`);
      - phone screenshots from `store/screenshots/android-phone/{en,he}/`.
- [ ] **App content:**
      - **Privacy policy:** the URL.
      - **Ads:** none.
      - **App access:** all functionality is available without special access.
      - **Content rating:** IARC questionnaire, all *No*, Utility/Productivity.
      - **Target audience:** 13+ (adults; not designed for children).
      - **Data safety:** from `store/privacy-answers.md` → *Data safety*.
      - **Government apps:** no. **Financial features:** none.
- [ ] Build the **.aab**: `cd android && ./gradlew bundleRelease -PversionCode=<n> -PversionName=<x.y.z>`, signed with the upload key (15.7; RELEASE.md §4). The target SDK is 36 (`android/variables.gradle`), which meets Play's current requirement.
- [ ] **Testing → Internal testing → Create release:**
      - upload the .aab;
      - release notes from `changelogs/default.txt`;
      - add testers.
- [ ] Record the internal-track version here: ______
- [ ] Later: closed testing, then production. A new personal developer account must run a closed test with testers before production; check the current requirement in Play Console.

## 3. Desktop: Microsoft Store, winget, Homebrew

These need the signed desktop builds (plan 11.5 and 15.7). An unsigned build is refused by Microsoft Store and warned against by winget, and an un-notarised macOS app fails Homebrew's audit.

- [ ] Release with `node scripts/release.mjs build --desktop`, then `publish`. `release/SHA256SUMS` lists the installers.
- [ ] `node scripts/store.mjs desktop --version <x.y.z> --sums release/SHA256SUMS --windows <setup.exe name> --mac <.dmg name>` writes `store/desktop/`.
- [ ] **winget:** fork `microsoft/winget-pkgs` and copy `store/desktop/manifests/l/Lumen/Lumen/<version>/`. Check with `winget validate --manifest <dir>` and `winget install --manifest <dir>` on Windows, then open the PR to winget-pkgs.
- [ ] **Homebrew:** copy `store/desktop/Casks/l/lumen.rb` into a tap (`talstilkol/homebrew-lumen`) first, and check with `brew install --cask ./lumen.rb` and `brew audit --cask --new lumen`. Submit to homebrew-cask only once the app is notarised and the project meets its notability rules.
- [ ] **Microsoft Store:**
      - Partner Center → Apps and games → New product → MSIX or PWA. The installed web app can also be listed as a PWA through PWABuilder.
      - Listing in English and Hebrew from `store/listing.json`.
      - Screenshots from `store/screenshots/desktop/`.
      - Privacy policy URL, and age rating through IARC.
- [ ] Record the submission IDs here: ______

## After review

- [ ] Record in plan 13.7's status: the store, the build, the date sent, and later the date approved.
- [ ] Add the store links to the README and to the beta page (plan W2.25), once they're live.
