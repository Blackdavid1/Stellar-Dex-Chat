'use client';

import { useState } from 'react';
import ChatInput from '@/components/ChatInput';

/**
 * Structured financial fact attached to an AI answer.
 *
 * Source, observed-at time, pair, and validity window are passed as
 * application data so citations are rendered from trusted values and the
 * model can never invent source URLs.
 */
type FactStatus = 'fresh' | 'stale' | 'missing' | 'conflicting';

interface FinancialFact {
  pair: string;
  source: string;
  sourceUrl: string;
  observedAt: string;
  validUntil: string;
  status: FactStatus;
  /** Rate is authoritative; payout is an estimate, never a guarantee. */
  rate?: number;
  estimatedPayout?: number;
}

interface SentMessage {
  text: string;
  fact?: FinancialFact;
}

const STATUS_LABEL: Record<FactStatus, string> = {
  fresh: 'Fresh data',
  stale: 'Stale data — verify before acting',
  missing: 'Data missing — no authoritative rate available',
  conflicting: 'Conflicting sources — treat as unverified',
};

/**
 * Supported locales for locale-aware intent evaluation.
 *
 * Each entry declares representative examples for amounts, decimal/grouping
 * separators, currencies, and ambiguity cases. Language interpretation is kept
 * separate from canonical parsing and contract unit conversion so transaction
 * arithmetic stays deterministic and unchanged.
 */
type LocaleCode = 'en-US' | 'de-DE' | 'fr-FR' | 'ja-JP';

interface LocaleExample {
  /** Raw user utterance in this locale. */
  utterance: string;
  /** Canonical amount after deterministic parsing, or null if withheld. */
  canonicalAmount: number | null;
  /** ISO 4217 currency code resolved from the utterance, or null if ambiguous. */
  currency: string | null;
  /** True when the input must be withheld for clarification. */
  ambiguous: boolean;
}

interface LocaleSpec {
  code: LocaleCode;
  label: string;
  decimalSeparator: '.' | ',';
  groupingSeparator: ',' | '.' | ' ';
  examples: LocaleExample[];
}

const SUPPORTED_LOCALES: LocaleSpec[] = [
  {
    code: 'en-US',
    label: 'English (United States)',
    decimalSeparator: '.',
    groupingSeparator: ',',
    examples: [
      { utterance: 'swap 1,234.56 USDC to ETH', canonicalAmount: 1234.56, currency: 'USDC', ambiguous: false },
      { utterance: 'send 100 dollars', canonicalAmount: 100, currency: 'USD', ambiguous: false },
      { utterance: 'swap 50 $ to ETH', canonicalAmount: 50, currency: null, ambiguous: true },
    ],
  },
  {
    code: 'de-DE',
    label: 'German (Germany)',
    decimalSeparator: ',',
    groupingSeparator: '.',
    examples: [
      { utterance: 'tausche 1.234,56 USDC in ETH', canonicalAmount: 1234.56, currency: 'USDC', ambiguous: false },
      { utterance: 'sende 100 Euro', canonicalAmount: 100, currency: 'EUR', ambiguous: false },
      { utterance: 'tausche 50 $ in ETH', canonicalAmount: 50, currency: null, ambiguous: true },
    ],
  },
  {
    code: 'fr-FR',
    label: 'French (France)',
    decimalSeparator: ',',
    groupingSeparator: ' ',
    examples: [
      { utterance: 'échanger 1 234,56 USDC contre ETH', canonicalAmount: 1234.56, currency: 'USDC', ambiguous: false },
      { utterance: 'envoyer 100 euros', canonicalAmount: 100, currency: 'EUR', ambiguous: false },
      { utterance: 'échanger 50 $ contre ETH', canonicalAmount: 50, currency: null, ambiguous: true },
    ],
  },
  {
    code: 'ja-JP',
    label: 'Japanese (Japan)',
    decimalSeparator: '.',
    groupingSeparator: ',',
    examples: [
      { utterance: '1,234.56 USDC を ETH に交換', canonicalAmount: 1234.56, currency: 'USDC', ambiguous: false },
      { utterance: '100 円 を送金', canonicalAmount: 100, currency: 'JPY', ambiguous: false },
      { utterance: '50 $ を ETH に交換', canonicalAmount: 50, currency: null, ambiguous: true },
    ],
  },
];

/**
 * Test harness page for ChatInput E2E tests.
 *
 * Exposes a controlled form around ChatInput so tests can verify sending,
 * error states, keyboard shortcuts, command palette, and emoji picker.
 * Also renders structured financial facts (source, timestamp, pair, validity)
 * alongside answers so citations come from application data only.
 */
export default function TestChatInputPage() {
  const [messages, setMessages] = useState<SentMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  const handleSendMessage = (msg: string) => {
    setIsLoading(true);
    setMessages((prev) => [...prev, { text: msg }]);
    // Simulate async AI response completing after 300 ms
    setTimeout(() => setIsLoading(false), 300);
  };

  const handleCancelRequest = () => {
    setIsLoading(false);
    setCancelled(true);
  };

  return (
    <main className="min-h-screen flex flex-col p-4">
      <h1 className="text-lg font-semibold mb-4">ChatInput Test Harness</h1>

      {/* Sent-messages log for test assertions */}
      <ul data-testid="sent-messages" className="flex-1 mb-4 space-y-1">
        {messages.map((m, i) => (
          <li key={i} data-testid="sent-message" className="text-sm border rounded p-2">
            <p>{m.text}</p>
            {m.fact && (
              <div
                data-testid="fact-citation"
                data-status={m.fact.status}
                className="mt-2 text-xs text-gray-600 space-y-0.5"
              >
                <p data-testid="fact-pair">Pair: {m.fact.pair}</p>
                <p data-testid="fact-source">
                  Source:{' '}
                  <a
                    href={m.fact.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    {m.fact.source}
                  </a>
                </p>
                <p data-testid="fact-observed-at">
                  Observed at: {new Date(m.fact.observedAt).toLocaleString()}
                </p>
                <p data-testid="fact-valid-until">
                  Valid until: {new Date(m.fact.validUntil).toLocaleString()}
                </p>
                <p data-testid="fact-status" className="font-medium">
                  {STATUS_LABEL[m.fact.status]}
                </p>
                {m.fact.estimatedPayout !== undefined && (
                  <p data-testid="fact-estimated-payout" className="italic">
                    Estimated payout: {m.fact.estimatedPayout} (estimate only, not a
                    guaranteed payout)
                  </p>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {/* Locale-aware intent evaluation fixtures for offline evaluation.
          Language interpretation is separate from canonical parsing and
          contract unit conversion; ambiguous or unsupported input is withheld. */}
      <section data-testid="locale-eval" className="mb-4 text-xs text-gray-600">
        <h2 className="text-sm font-semibold mb-1">Locale intent evaluation</h2>
        {SUPPORTED_LOCALES.map((locale) => (
          <div key={locale.code} data-testid={`locale-${locale.code}`} className="mb-2">
            <p className="font-medium">
              {locale.label} (decimal &quot;{locale.decimalSeparator}&quot;, grouping
              &quot;{locale.groupingSeparator}&quot;)
            </p>
            <ul className="ml-4 list-disc">
              {locale.examples.map((ex, i) => (
                <li
                  key={i}
                  data-testid={`locale-example-${locale.code}-${i}`}
                  data-ambiguous={ex.ambiguous}
                >
                  {ex.utterance} →{' '}
                  {ex.ambiguous
                    ? 'withheld for clarification'
                    : `${ex.canonicalAmount} ${ex.currency}`}
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p data-testid="locale-unsupported" className="italic">
          Unsupported languages are withheld for clarification rather than guessed.
        </p>
      </section>

      {cancelled && (
        <p data-testid="cancel-notice" className="text-xs text-amber-600 mb-2">
          Request cancelled.
        </p>
      )}

      <ChatInput
        onSendMessage={handleSendMessage}
        onCancelRequest={handleCancelRequest}
        isLoading={isLoading}
        placeholder="Type a message…"
        sessionId="harness-session"
      />
    </main>
  );
}
