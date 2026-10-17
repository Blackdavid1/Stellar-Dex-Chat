'use client';

import React, { Suspense } from 'react';
import dynamic from 'next/dynamic';
import type { TransactionHistoryEntry } from '@/types';

const ReceiptDrawer = dynamic(() => import('./ReceiptDrawer'), {
  ssr: false,
});

import type { ReceiptDrawerProps } from './ReceiptDrawer';

export type ReceiptDrawerWrapperProps = ReceiptDrawerProps;

export default function ReceiptDrawerWrapper(props: ReceiptDrawerWrapperProps) {
  return (
    <Suspense fallback={null}>
      <ReceiptDrawer {...props} />
    </Suspense>
  );
}
