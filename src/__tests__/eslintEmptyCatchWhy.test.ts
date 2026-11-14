/**
 * Plan 0.4.2 / 12.1: the `lumen/empty-catch-why` ESLint rule — an empty catch
 * block, or an empty `.catch()` handler, must explain itself with a `why:`
 * comment.
 * @vitest-environment node
 */
import { describe, it } from "vitest";
import { RuleTester } from "eslint";
// @ts-expect-error -- plain JS rule module, no types
import rule from "../../eslint-rules/empty-catch-why.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: "module" } }).run("lumen/empty-catch-why", rule, {
  valid: [
    "try { f(); } catch { /* why: storage denied in private mode */ }",
    "try { f(); } catch (e) {\n  // why: best effort, the next save retries\n}",
    "try { f(); } catch { /** why: already closed */ }",
    "try { f(); } catch {\n  /*\n   * why: storage may be unavailable\n   */\n}",
    "function h() { try { f(); } catch { return null; } }",
    "try { f(); } catch (e) { log(e); }",
    "p.catch(() => { /* why: best effort, the next save retries */ });",
    "p.catch(function () {\n  // why: already reported by the caller\n});",
    "p.catch(() => null);",
    "p.catch((e) => { log(e); });",
    "p.then(() => {}, () => {});",
  ],
  invalid: [
    { code: "try { f(); } catch {}", errors: [{ messageId: "missing" }] },
    { code: "try { f(); } catch (e) { /* ignore */ }", errors: [{ messageId: "missing" }] },
    { code: "try { f(); } catch { // why:\n}", errors: [{ messageId: "missing" }] },
    { code: "try { f(); } catch {\n  /*\n   * ignore\n   */\n}", errors: [{ messageId: "missing" }] },
    { code: "p.catch(() => {});", errors: [{ messageId: "missingHandler" }] },
    { code: "void p.catch(function () { /* ignore */ });", errors: [{ messageId: "missingHandler" }] },
    { code: "p.then(f).catch((_e) => {\n});", errors: [{ messageId: "missingHandler" }] },
  ],
});
