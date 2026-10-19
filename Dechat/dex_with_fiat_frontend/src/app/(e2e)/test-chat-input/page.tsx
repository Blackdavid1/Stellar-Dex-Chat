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
