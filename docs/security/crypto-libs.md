# Cryptography from audited libraries: the vendor-in plan (W10.D11–D13, plan 3.4, W1.7)

The encrypted sync uses primitives written in this repository, in plain
TypeScript (`src/sync/e2ee/primitives/*.ts`). They pass the RFC vectors and
the 39 protocol vectors, and an independent Python reader, but no outside
party has audited them. This plan moves every primitive to an audited library.
Our own code stays only as a differential oracle in the tests. The choices
follow research R3 (§1.2 and R3.5, 14.11).

## One door, two implementations

- `src/sync/e2ee/primitives/index.ts` is the only module that callers import (`kdf.ts`, `age.ts`, the vector generator). `cryptoPrimitivesDoor.test.ts` fails on any direct import of `primitives/{argon2,blake2b,chacha20poly1305,scrypt}.ts` from outside that folder.
- The implementation is chosen in one place, `usePrimitives(…)`:
  - `IN_HOUSE`: today's code, the default until the Mac run.
  - `AUDITED`: `src/sync/e2ee/primitives/lib/audited.ts`, over the libraries below.
- age has its own adapter, `src/sync/e2ee/primitives/lib/age.ts`. It wraps typage with the same signatures as `src/sync/e2ee/age.ts`.
- `src/sync/e2ee/primitives/lib/` is **excluded from `tsconfig.json` and ESLint** until the packages are in the lockfile. Nothing in the app imports it; only `cryptoDifferential.test.ts` loads it. That test probes the library code and skips its library half with a `skip-reason` when the packages are missing.

## The libraries

| Primitive | Library | Audit | Licence | Version | Integrity (sha512) |
|---|---|---|---|---|---|
| ChaCha20-Poly1305 (age payload and stanzas) | `@noble/ciphers` (`chacha.js`: `chacha20poly1305`) | Cure53, Sep 2024 (v1.0.0) | MIT | 2.4.0 (on JSR at research time; confirm with `npm view`) | owed (Mac): `npm view @noble/ciphers@<v> dist.integrity` |
| BLAKE2b, scrypt (and HKDF when needed) | `@noble/hashes` (`blake2.js`, `scrypt.js`) | Cure53, Jan 2022 (v1.0.0). blake2 and scrypt in scope, **argon2 excluded** | MIT | 2.x, the newest 2.x at install | owed (Mac) |
| Argon2id (vault KDF) | `hash-wasm` (`argon2id`, the PHC reference C code in WebAssembly), run in a Worker (`lib/argon2Worker.ts`) | none (single maintainer). It compiles the reference implementation | MIT | 4.x (4.9.0 listed on licenses.dev); the newest 4.x at install | owed (Mac) |
| Argon2id fallback, when hash-wasm can't load | `libsodium-wrappers-sumo` (`crypto_pwhash`, `ALG_ARGON2ID13`) | libsodium C, audited 2017 | ISC | 0.8.4 | owed (Mac) |
| age (X25519, scrypt passphrase, armor) | `age-encryption` (typage, Filippo Valsorda) | no third-party audit listed. Its only dependencies are noble, and it uses WebCrypto | BSD-3-Clause | the newest at install | owed (Mac) |

Not used:

- **noble's argon2.** It is outside noble's audit. It is also about 5× slower than native, and its author suggests scrypt instead.
- **@awasm/noble.** It is too new, from April 2026.

AES-GCM, HKDF, X25519 and Ed25519 stay on WebCrypto.

The fallback derives only inputs of the shape the app makes: parallelism 1, a
16-byte salt, and no secret or associated data. It refuses any other input,
and never derives it differently.

Not verified in this lane:

- The **versions and integrity hashes** could not be read here. The npm registry is offline in this environment, and no hash may be made up. The Mac run fills them in from the registry, and the lockfile then pins them.
- The **typage method names** in `lib/age.ts` (`Encrypter.addRecipient`, `setPassphrase`, `setScryptWorkFactor`, `Decrypter.addIdentity`, `addPassphrase`, `decrypt(…, "uint8array")`) follow its README. tsc checks them at 10.M, once the package is installed and the exclude is gone.

## The Mac run (10.M), in order

```bash
# 1. Install exact versions (no ^), then confirm what the registry signed
npm install --save-exact @noble/ciphers@<v> @noble/hashes@<v> hash-wasm@<v> libsodium-wrappers-sumo@0.8.4 age-encryption@<v>
for p in @noble/ciphers @noble/hashes hash-wasm libsodium-wrappers-sumo age-encryption; do
  v=$(node -p "require('./package-lock.json').packages['node_modules/$p'].version")
  lock=$(node -p "require('./package-lock.json').packages['node_modules/$p'].integrity")
  reg=$(npm view "$p@$v" dist.integrity)
  pack=$(npm pack "$p@$v" --json | node -p "JSON.parse(require('fs').readFileSync(0)).at(0).integrity")
  echo "$p@$v lock=$lock registry=$reg pack=$pack"   # all three must be equal
done
# 2. Copy each version and integrity into the table above.
# 3. Put the library code into the build: remove "src/sync/e2ee/primitives/lib" from tsconfig.json's
#    exclude and from eslint.config.js's ignores
npx tsc --noEmit -p . && npm run -s lint
# 4. The differential run: 10,000 random vectors per primitive (scrypt 200, Argon2id 100), RFC vectors, age both ways
npx vitest run src/__tests__/cryptoDifferential.test.ts src/__tests__/cryptoPrimitivesDoor.test.ts
# 5. The other suites the switch must keep green
npx vitest run src/__tests__/e2ee*.test.ts src/__tests__/vaultArgon2.test.ts
python3 scripts/sync-protocol/check_vectors.py      # the 39 protocol vectors
# 6. Make AUDITED the default: one line at startup, usePrimitives(AUDITED); then the suites of 5 again
git add package.json package-lock.json tsconfig.json eslint.config.js docs/security/crypto-libs.md && git commit
```

**Acceptance at 10.M:**

- 0 differences in 10,000 vectors.
- Byte-identical outputs on the 39 protocol vectors and the e2ee suites (e2eeSync 43, e2eeVectors, e2eeAge, keyring).
- Wycheproof `chacha20_poly1305_test.json` passes.
- The RFC 9106 Argon2id vectors pass.
- The C2SP CCTV age testkit passes in full.
- `AUDITED` is the default.
- No hand-written primitive file is in the production bundle (`dist/`): they are reached only from tests.

## Argon2id parameters

- **The target** for new vaults is **64 MiB, 3 passes, parallelism 1**, the class Standard Notes uses. It must take ≤ 1 s on an M-series Mac in Chrome, Firefox and Safari, and ≤ 2 s on a Pixel 7.
- **The default stays where it is** until these are measured on the Mac and on a weak device (`kdfCalibrate.ts`). The floors (`ARGON2_MIN_MEMORY_KIB`, `ARGON2_MIN_COST_KIB`) don't change.
- **Existing vaults keep the parameters stored in their header**, so no migration is needed.

Measure with:

```bash
npm run dev   # then in each browser's console, on the weakest device at hand
#   await (await import("/src/sync/e2ee/kdfCalibrate.ts")).calibrateArgon2(1000)
```

Record the measured times here, then set the default from the result.

## בעברית

הסנכרון המוצפן משתמש היום בפרימיטיבים שכתבנו בעצמנו. הם עוברים את וקטורי ה-RFC ואת 39 וקטורי הפרוטוקול, אבל אף גורם חיצוני לא בדק אותם. התוכנית מעבירה כל פרימיטיב לספרייה שעברה ביקורת, והקוד שלנו נשאר רק כבדיקת הפרשים בבדיקות.

| פרימיטיב | ספרייה |
|---|---|
| ‏ChaCha20-Poly1305 | ‏`@noble/ciphers` (ביקורת Cure53 מ-2024) |
| ‏BLAKE2b ו-scrypt | ‏`@noble/hashes` (ביקורת Cure53 מ-2022) |
| ‏Argon2id | ‏`hash-wasm` ב-Worker, וכגיבוי `crypto_pwhash` של libsodium. לא ה-argon2 של noble: הוא מחוץ לביקורת ואיטי. |
| ‏age | ‏typage ‏(`age-encryption`) |

- **ממשק אחד.** כל הקוראים עוברים דרך `src/sync/e2ee/primitives/index.ts`, והבחירה במימוש נעשית במקום אחד.
- **עד ההרצה ב-Mac.** המימוש מעל הספריות נמצא ב-`primitives/lib`, מחוץ ל-tsconfig ול-ESLint, ובדיקת ההפרשים מדלגת עליו ואומרת למה.
- **ב-Mac** מתקינים גרסאות מדויקות ומשווים את ה-integrity של ה-lock, של ה-registry ושל `npm pack`. אחר כך מסירים את ההחרגה, מריצים 10,000 וקטורים אקראיים ואת וקטורי ה-RFC, ומעבירים את ברירת המחדל לספריות.
- **פרמטרי Argon2id.** היעד הוא ‏64 MiB, ‏3 מעברים ו-parallelism 1. ברירת המחדל משתנה רק אחרי מדידה במכשיר חלש. כספות קיימות שומרות את הפרמטרים שלהן.
