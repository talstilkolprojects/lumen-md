---
title: Personal data before the cloud
description: When your AI policy lets a request leave this device, Lumen hides e-mails, phone numbers, ID numbers, cards, IBANs, plates and birth dates on the device first, and puts them back in the answer.
---

Under the **local only** policy nothing leaves your device, so there is
nothing to hide. Under **local first** or **cloud**, a request can go to
a cloud provider (OpenAI, Anthropic, Gemini or Mistral). Before it does,
Lumen redacts personal data **on this device**:

| What | How it is recognised |
|---|---|
| E-mail address | the address pattern |
| Phone number | Israeli mobile and landline formats, `+972`, international with separators |
| ID number (ת״ז) | 9 digits **with a valid check digit** |
| Payment card | 13–19 digits that pass the **Luhn** check |
| IBAN | the IBAN format **with a valid mod-97 check** |
| Licence plate | Israeli formats `12-345-67` and `123-45-678` |
| Birth date | a date next to a birth word ("תאריך לידה", "נולד", "born", "DOB") |
| Names | with the Hebrew name model (DictaBERT-NER, CC BY 4.0) downloaded |

Each value becomes a token such as `⟨EMAIL_1⟩`. The same value always
gets the same token within one request, so the model can still refer to
it. When the answer comes back, the tokens are replaced with the
originals, including in streamed answers.

Numbers that only look like personal data are left alone. This covers an
order number, a parcel code, a product code, an ID with a wrong check
digit, a card number that fails Luhn, and historical or event dates.

## Settings

**AI settings → Personal data before the cloud** (shown when the policy
is not *local only*):

- **Hide personal data before a request leaves this device.** This is on
  by default.
- **Show what will be sent before each cloud request.** Before each cloud
  request you see the redacted text and a count per type, and can cancel.

The **privacy ledger** (`⌘K → Privacy ledger…`) shows how many items
were hidden in how many requests. It shows the counts only, never the
values.

## Names

Names have no pattern. Hebrew names are found by DictaBERT-NER, a model
that runs on your device. A cloud request never downloads it; you
download it with consent, after seeing its size and licence, under
**Settings → Models**. Without it, only the patterns above are hidden,
and names are sent as written.

## How it is measured

- **Patterns:** on the dev split of the PII golden set
  (`eval/golden/ner-pii`), recall is 100% and precision is 100%, with 0
  false redactions on the 13 hard negatives. On 3000 generated items
  (1000 hard negatives) there were 0 false redactions. The test is
  `src/__tests__/piiGolden.test.ts`.
- **In the browser:** an end-to-end test puts every pattern item of the
  set in a note and sends it to a stubbed cloud provider. None of the
  values reaches the provider (`e2e/pii-redaction.spec.ts`).
- **The held-out test split** is scored in CI by
  `scripts/golden/evals/ner-pii.mjs`.
