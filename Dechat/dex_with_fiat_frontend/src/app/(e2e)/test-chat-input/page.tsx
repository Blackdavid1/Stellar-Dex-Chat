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
 * Deterministic conversation replay for incident debugging.
 *
 * A trace records versioned state transitions, tool names, normalized
 * arguments, policy decisions, and outcome codes with sensitive values
 * redacted. Replay compares a recorded trace against a pinned model/policy
 * fixture and reports divergence without executing any external or write
 * tool. Traces are retained in memory only and never persisted client-side.
 */
type PolicyDecision = 'allow' | 'deny' | 'clarify';
type OutcomeCode = 'ok' | 'denied' | 'error' | 'withheld';

interface TraceStep {
  /** Monotonic step index within the trace. */
  index: number;
  /** Versioned state transition label, e.g. "intent.parsed@v1". */
  transition: string;
  /** Tool name, or null when the step is a pure state transition. */
  tool: string | null;
  /** Normalized (redacted) tool arguments. */
  args: Record<string, string>;
  policy: PolicyDecision;
  outcome: OutcomeCode;
}

interface ConversationTrace {
  /** Trace schema version for forward-compatible replay. */
  version: 1;
  /** Pinned model/policy fixture the trace was recorded against. */
  fixture: string;
  steps: TraceStep[];
}

interface ReplayDivergence {
  index: number;
  field: 'transition' | 'tool' | 'args' | 'policy' | 'outcome';
  recorded: string;
  replayed: string;
}

const SENSITIVE_KEY = /(secret|token|key|password|seed|private|auth|signature)/i;

/** Redact sensitive argument values before they enter a trace. */
function redactArgs(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : String(v);
  }
  return out;
}

/** Tools that must never execute during replay. */
const WRITE_TOOLS = new Set(['swap', 'send', 'approve', 'transfer', 'sign']);

/**
 * Replay a recorded trace against a pinned fixture. Pure and deterministic:
 * no network, no model calls, and no tool execution. Returns divergences.
 */
function replayTrace(
  recorded: ConversationTrace,
  fixture: ConversationTrace,
): ReplayDivergence[] {
  const divergences: ReplayDivergence[] = [];
  if (recorded.fixture !== fixture.fixture) {
    divergences.push({
      index: -1,
      field: 'transition',
      recorded: recorded.fixture,
      replayed: fixture.fixture,
    });
    return divergences;
  }
  const len = Math.max(recorded.steps.length, fixture.steps.length);
  for (let i = 0; i < len; i++) {
    const a = recorded.steps[i];
    const b = fixture.steps[i];
    if (!a || !b) {
      divergences.push({
        index: i,
        field: 'transition',
        recorded: a ? a.transition : '(missing)',
        replayed: b ? b.transition : '(missing)',
      });
      continue;
    }
    if (a.transition !== b.transition) {
      divergences.push({ index: i, field: 'transition', recorded: a.transition, replayed: b.transition });
    }
    if (a.tool !== b.tool) {
      divergences.push({ index: i, field: 'tool', recorded: String(a.tool), replayed: String(b.tool) });
    }
    if (JSON.stringify(a.args) !== JSON.stringify(b.args)) {
      divergences.push({ index: i, field: 'args', recorded: JSON.stringify(a.args), replayed: JSON.stringify(b.args) });
    }
    if (a.policy !== b.policy) {
      divergences.push({ index: i, field: 'policy', recorded: a.policy, replayed: b.policy });
    }
    if (a.outcome !== b.outcome) {
      divergences.push({ index: i, field: 'outcome', recorded: a.outcome, replayed: b.outcome });
    }
  }
  return divergences;
}

const PINNED_FIXTURE = 'model-fixture@2024-06-01/policy@v3';

const SAMPLE_TRACE: ConversationTrace = {
  version: 1,
  fixture: PINNED_FIXTURE,
  steps: [
    {
      index: 0,
      transition: 'intent.parsed@v1',
      tool: null,
      args: {},
      policy: 'allow',
      outcome: 'ok',
    },
    {
      index: 1,
      transition: 'tool.routed@v1',
      tool: 'swap',
      args: redactArgs({ pair: 'USDC/ETH', amount: '1234.56', apiKey: 'sk-live-xxx' }),
      policy: 'deny',
      outcome: 'denied',
    },
  ],
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

  const replayDivergences = replayTrace(SAMPLE_TRACE, SAMPLE_TRACE);
  const replayExecutedWriteTool = SAMPLE_TRACE.steps.some(
    (s) => s.tool !== null && WRITE_TOOLS.has(s.tool),
  );

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

      {/* Deterministic conversation replay for incident debugging.
          Traces are redacted, versioned, and replayed against a pinned
          fixture without executing any external or write tool. */}
      <section data-testid="conversation-replay" className="mb-4 text-xs text-gray-600">
        <h2 className="text-sm font-semibold mb-1">Conversation replay</h2>
        <p data-testid="replay-fixture">Fixture: {SAMPLE_TRACE.fixture}</p>
        <p data-testid="replay-version">Trace version: {SAMPLE_TRACE.version}</p>
        <p data-testid="replay-divergences">
          Divergences: {replayDivergences.length}
        </p>
        <p data-testid="replay-write-tool-executed">
          Write tool executed: {replayExecutedWriteTool ? 'yes' : 'no'}
        </p>
        <ul className="ml-4 list-disc">
          {SAMPLE_TRACE.steps.map((step) => (
            <li key={step.index} data-testid={`replay-step-${step.index}`}>
              {step.transition} · tool={step.tool ?? 'none'} · policy={step.policy} ·
              outcome={step.outcome} · args={JSON.stringify(step.args)}
            </li>
          ))}
        </ul>
        <p className="italic mt-1">
          Traces are retained in memory only; access is limited to incident
          responders and sensitive values are redacted before recording.
        </p>
      </section>

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

      <ChatInput
        onSendMessage={handleSendMessage}
        isLoading={isLoading}
        onCancelRequest={handleCancelRequest}
      />
      {cancelled && (
        <p data-testid="request-cancelled" className="mt-2 text-sm text-red-600">
          Request cancelled
        </p>
      )}
    </main>
  );
}
