'use client';

import React from 'react';
import ChatMessages from '@/components/ChatMessages';
import { ChatMessage } from '@/types';

const sampleMessages: ChatMessage[] = [
  {
    id: 'm1',
    role: 'assistant',
    content: 'Hello! This message contains a [link](https://example.com), some **bold** text, and *italic* emphasis with `inline code`.',
    timestamp: new Date(),
    metadata: {
      status: 'sent',
    },
  },
  {
    id: 'm2',
    role: 'assistant',
    content: 'Here is a transaction preview',
    timestamp: new Date(),
    metadata: {
      status: 'sent',
      transactionData: {
        type: 'fiat_conversion',
        tokenIn: 'XLM',
        amountIn: '123.45',
        fiatAmount: '10.00',
        fiatCurrency: 'USD',
        transactionId: 'tx-abcdef1234567890',
        txHash: '0xdeadbeefcafebabe',
        receiptId: 'r-1234567890abcdef',
        note: 'Test deposit',
      },
      confirmationRequired: true,
    },
  },
  {
    id: 'm3',
    role: 'assistant',
    content: 'This message has suggested actions',
    timestamp: new Date(),
    metadata: {
      status: 'sent',
      suggestedActions: [
        { id: 'a1', label: 'Confirm', type: 'confirm_fiat', priority: true },
        { id: 'a2', label: 'Cancel', type: 'cancel', priority: false },
      ],
    },
  },
  {
    id: 'm4',
    role: 'user',
    content: 'This is a user message',
    timestamp: new Date(),
    metadata: { status: 'sent' },
  },
  {
    id: 'm5',
    role: 'assistant',
    content: 'This message simulates a failure',
    timestamp: new Date(),
    error: { message: 'Failed to send', timestamp: new Date(), retryAttempts: 2 },
    metadata: { status: 'failed' },
  },
  {
    id: 'm6',
    role: 'assistant',
    content: 'The current XLM/USD rate is 0.1234 USD per XLM.',
    timestamp: new Date(),
    metadata: {
      status: 'sent',
      financialFact: {
        kind: 'rate',
        pair: 'XLM/USD',
        value: '0.1234',
        source: {
          name: 'Stellar DEX oracle',
          url: 'https://example.com/rates/xlm-usd',
        },
        observedAt: new Date(Date.now() - 30 * 1000),
        validUntil: new Date(Date.now() + 60 * 1000),
        freshness: 'fresh',
      },
    },
  },
  {
    id: 'm7',
    role: 'assistant',
    content: 'The last known XLM/USD rate was 0.1201 USD per XLM.',
    timestamp: new Date(),
    metadata: {
      status: 'sent',
      financialFact: {
        kind: 'rate',
        pair: 'XLM/USD',
        value: '0.1201',
        source: {
          name: 'Stellar DEX oracle',
          url: 'https://example.com/rates/xlm-usd',
        },
        observedAt: new Date(Date.now() - 30 * 60 * 1000),
        validUntil: new Date(Date.now() - 10 * 60 * 1000),
        freshness: 'stale',
      },
    },
  },
  {
    id: 'm8',
    role: 'assistant',
    content: 'I could not retrieve a current XLM/USD rate right now.',
    timestamp: new Date(),
    metadata: {
      status: 'sent',
      financialFact: {
        kind: 'rate',
        pair: 'XLM/USD',
        freshness: 'missing',
      },
    },
  },
  {
    id: 'm9',
    role: 'assistant',
    content: 'Based on the current rate, 100 XLM would be approximately 12.34 USD. This is an estimate, not a guaranteed payout.',
    timestamp: new Date(),
    metadata: {
      status: 'sent',
      financialFact: {
        kind: 'payout_estimate',
        pair: 'XLM/USD',
        value: '12.34',
        source: {
          name: 'Stellar DEX oracle',
          url: 'https://example.com/rates/xlm-usd',
        },
        observedAt: new Date(Date.now() - 20 * 1000),
        validUntil: new Date(Date.now() + 40 * 1000),
        freshness: 'fresh',
        isEstimate: true,
      },
    },
  },
];

export default function Page() {
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <h1 style={{ padding: 16 }}>Test Message Fixtures</h1>
      <div style={{ flex: 1 }}>
        <ChatMessages
          messages={sampleMessages}
          onActionClick={() => undefined}
        />
      </div>
    </div>
  );
}
