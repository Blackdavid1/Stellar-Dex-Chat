# Chat History & AI Intent Evaluation

This document describes how the chat layer interprets user messages, how
amounts are validated, and how locale-aware intent evaluation works without
affecting transaction arithmetic.

## Locale-aware intent evaluation (issue #108)

Language interpretation is deliberately separated from canonical parsing and
contract unit conversion. The pipeline is:

1. **Language interpretation** — detect the user's locale and extract the
   intent (e.g. "send", "swap") plus the raw amount/currency tokens as the
   user typed them. This stage is best-effort and never produces a final
   numeric value.
2. **Canonical parsing** — normalize the extracted tokens into a canonical
   decimal string using the declared locale rules below. This stage is
   deterministic and locale-driven.
3. **Contract unit conversion** — convert the canonical decimal into base
   units (e.g. wei) using the token's decimals. This stage is unchanged and
   remains the single source of truth for transaction arithmetic.

Because stages 2 and 3 are deterministic and independent of the language
model, adding new languages cannot change how amounts are computed.

## Supported locales

Each locale declares its decimal separator, grouping separator, and the
representative examples used by the offline evaluations.

| Locale | Decimal sep | Grouping sep | Example amount | Parsed canonical | Currency example |
| ------ | ----------- | ------------ | -------------- | ---------------- | ---------------- |
| `en-US` | `.` | `,` | `1,234.56` | `1234.56` | `$1,234.56` → USD |
| `en-GB` | `.` | `,` | `1,234.56` | `1234.56` | `£1,234.56` → GBP |
| `de-DE` | `,` | `.` | `1.234,56` | `1234.56` | `1.234,56 €` → EUR |
| `fr-FR` | `,` | narrow no-break space | `1 234,56` | `1234.56` | `1 234,56 €` → EUR |
| `es-ES` | `,` | `.` | `1.234,56` | `1234.56` | `1.234,56 €` → EUR |
| `ja-JP` | `.` | `,` | `1,234.56` | `1234.56` | `¥1,234` → JPY |

### Ambiguity examples

- `1.234` in `de-DE`/`es-ES` is a grouping form → `1234`.
- `1.234` in `en-US` is a decimal form → `1.234`.
- `1,234` in `en-US` is a grouping form → `1234`.
- `1,234` in `de-DE` is a decimal form → `1.234`.
- A bare `$` is ambiguous across USD/CAD/AUD and must be resolved by the
  declared locale or withheld for clarification.

## Edge cases

### Mixed-locale input

When the detected language and the amount formatting disagree (e.g. an
`en-US` sentence containing `1.234,56`), the parser does **not** guess. The
intent is withheld and the user is asked to confirm the amount.

### Ambiguous currency symbols

Symbols shared by multiple currencies (`$`, `¥`) are only resolved when the
locale unambiguously maps to a single currency. Otherwise the request is
withheld for clarification.

### Unsupported languages

If the detected locale is not in the supported table above, the intent is
withheld for clarification rather than falling back to a default locale.

## Diagnostics

Diagnostics and logs record only the locale, the resolved intent kind, and a
coarse outcome (`parsed`, `withheld`, `unsupported`). They never include the
raw user prompt or the extracted amount tokens, so sensitive input is not
persisted in logs.

## Validation

Offline evaluations run per locale against the representative examples in the
table. For every case the parsed value must either match the deterministic
canonical parsing result or be withheld for clarification; no evaluation may
produce a value that differs from canonical parsing.
