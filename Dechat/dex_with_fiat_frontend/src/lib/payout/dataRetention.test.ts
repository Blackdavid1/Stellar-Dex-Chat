import { describe, it, expect, beforeEach } from 'vitest';
import {
  FIELD_CLASSIFICATIONS,
  RETENTION_PERIODS_MS,
  encryptAtRest,
  decryptAtRest,
  tokenizeBankIdentifier,
  maskAccountNumber,
  redactSensitivePayoutData,
  deletePayoutPii,
  generateAuditHash,
  PayoutRetentionService,
  type PayoutRecord,
} from './dataRetention';

describe('Issue #51: Payout PII Data-Retention and Verifiable Deletion Workflows', () => {
  let service: PayoutRetentionService;

  beforeEach(() => {
    service = new PayoutRetentionService('test-secure-encryption-key-32b!');
    service.clear();
  });

  describe('Field Sensitivity Classification', () => {
    it('classifies bank details and identity fields as RESTRICTED_PII with log redaction and encryption', () => {
      const restrictedFields = ['account_number', 'account_name', 'bvn', 'phone_number', 'email'];

      for (const field of restrictedFields) {
        const policy = FIELD_CLASSIFICATIONS[field];
        expect(policy).toBeDefined();
        expect(policy.sensitivity).toBe('RESTRICTED_PII');
        expect(policy.redactInLogs).toBe(true);
        expect(policy.wipeOnDeletion).toBe(true);
      }
    });

    it('classifies transient provider codes as OPERATIONAL with wipeOnDeletion', () => {
      const operationalFields = ['recipient_code', 'transfer_code'];

      for (const field of operationalFields) {
        const policy = FIELD_CLASSIFICATIONS[field];
        expect(policy).toBeDefined();
        expect(policy.sensitivity).toBe('OPERATIONAL');
        expect(policy.wipeOnDeletion).toBe(true);
      }
    });

    it('classifies financial accounting fields as AUDIT_FINANCIAL preserved indefinitely', () => {
      const auditFields = ['reference', 'amount', 'currency', 'status', 'createdAt', 'settledAt', 'bankToken'];

      for (const field of auditFields) {
        const policy = FIELD_CLASSIFICATIONS[field];
        expect(policy).toBeDefined();
        expect(policy.sensitivity).toBe('AUDIT_FINANCIAL');
        expect(policy.wipeOnDeletion).toBe(false);
      }
    });

    it('defines distinct retention periods by terminal status', () => {
      expect(RETENTION_PERIODS_MS.completed).toBe(24 * 60 * 60 * 1000);
      expect(RETENTION_PERIODS_MS.failed).toBe(48 * 60 * 60 * 1000);
      expect(RETENTION_PERIODS_MS.cancelled).toBe(24 * 60 * 60 * 1000);
      expect(RETENTION_PERIODS_MS.rejected).toBe(24 * 60 * 60 * 1000);
      expect(RETENTION_PERIODS_MS.pending).toBe(Number.POSITIVE_INFINITY);
    });
  });

  describe('Encryption and Tokenization at Rest', () => {
    it('encrypts and decrypts sensitive bank PII using AES-256-GCM', () => {
      const plaintext = JSON.stringify({
        accountNumber: '0123456789',
        accountName: 'Alice Test',
        bvn: '22334455667',
      });

      const encrypted = encryptAtRest(plaintext, 'my-super-secret-key-32-chars!!');
      expect(encrypted.ciphertext).not.toContain('0123456789');
      expect(encrypted.ciphertext).not.toContain('Alice Test');
      expect(encrypted.iv).toHaveLength(24); // 12 bytes in hex
      expect(encrypted.tag).toHaveLength(32); // 16 bytes in hex

      const decrypted = decryptAtRest(encrypted, 'my-super-secret-key-32-chars!!');
      expect(decrypted).toBe(plaintext);
    });

    it('generates deterministic irreversible bank tokens for reconciliation without storing raw numbers', () => {
      const token1 = tokenizeBankIdentifier('0123456789', '058');
      const token2 = tokenizeBankIdentifier('0123456789', '058');
      const tokenOther = tokenizeBankIdentifier('9876543210', '058');

      expect(token1).toMatch(/^tok_bank_[a-f0-9]{16}$/);
      expect(token1).toBe(token2); // Deterministic for reconciliation
      expect(token1).not.toBe(tokenOther);
      expect(token1).not.toContain('0123456789');
    });

    it('masks bank account numbers preserving only the last 4 digits', () => {
      expect(maskAccountNumber('0123456789')).toBe('******6789');
      expect(maskAccountNumber('12345')).toBe('*2345');
      expect(maskAccountNumber('123')).toBe('****');
    });
  });

  describe('Log and Analytics Redaction', () => {
    it('redacts sensitive fields in nested log payloads while preserving audit references', () => {
      const sensitiveLogPayload = {
        event: 'payout_initiated',
        reference: 'PAY_REF_998877',
        amount: 50000,
        currency: 'NGN',
        status: 'pending',
        beneficiary: {
          account_number: '0123456789',
          account_name: 'John Doe',
          bvn: '22334455667',
          phone_number: '+2348012345678',
          email: 'johndoe@example.com',
        },
        provider_data: {
          recipient_code: 'RCP_12345678abcdef',
          transfer_code: 'TRF_987654321fedcba',
        },
      };

      const redacted = redactSensitivePayoutData(sensitiveLogPayload);

      // Financial audit fields preserved
      expect(redacted.event).toBe('payout_initiated');
      expect(redacted.reference).toBe('PAY_REF_998877');
      expect(redacted.amount).toBe(50000);
      expect(redacted.currency).toBe('NGN');
      expect(redacted.status).toBe('pending');

      // Sensitive PII redacted
      expect(redacted.beneficiary.account_number).toBe('******6789');
      expect(redacted.beneficiary.account_name).toBe('[REDACTED]');
      expect(redacted.beneficiary.bvn).toBe('[REDACTED]');
      expect(redacted.beneficiary.phone_number).toBe('[REDACTED]');
      expect(redacted.beneficiary.email).toBe('[REDACTED]');
      expect(redacted.provider_data.recipient_code).toBe('[REDACTED]');
      expect(redacted.provider_data.transfer_code).toBe('[REDACTED]');
    });

    it('handles arrays and primitives gracefully in log redaction', () => {
      const logs = [
        { account_number: '1122334455', amount: 100 },
        { account_number: '9988776655', amount: 200 },
      ];

      const cleaned = redactSensitivePayoutData(logs);
      expect(cleaned[0].account_number).toBe('******4455');
      expect(cleaned[0].amount).toBe(100);
      expect(cleaned[1].account_number).toBe('******6655');
      expect(cleaned[1].amount).toBe(200);
    });
  });

  describe('Verifiable Deletion Workflow and Idempotency', () => {
    it('eradicates PII, preserves financial audit references, and generates cryptographic audit proof', () => {
      const record: PayoutRecord = {
        reference: 'PAY_COMPLETED_001',
        amount: 25000,
        currency: 'NGN',
        status: 'completed',
        createdAt: Date.now() - 100000,
        settledAt: Date.now() - 50000,
        bankCode: '044',
        bankToken: 'tok_bank_abcdef1234567890',
        accountNumber: '0123456789',
        accountName: 'Jane Smith',
        bvn: '22334455667',
        recipientCode: 'RCP_xyz123',
        transferCode: 'TRF_abc789',
      };

      const { updatedRecord, proof } = deletePayoutPii(record, 'user_request', {
        requestedBy: 'user_wallet_GBRPY...',
      });

      // PII scrubbed from record
      expect(updatedRecord.isPiiDeleted).toBe(true);
      expect(updatedRecord.accountNumber).toBeUndefined();
      expect(updatedRecord.accountName).toBeUndefined();
      expect(updatedRecord.bvn).toBeUndefined();
      expect(updatedRecord.recipientCode).toBeUndefined();
      expect(updatedRecord.transferCode).toBeUndefined();

      // Non-identifying financial audit fields preserved
      expect(updatedRecord.reference).toBe('PAY_COMPLETED_001');
      expect(updatedRecord.amount).toBe(25000);
      expect(updatedRecord.currency).toBe('NGN');
      expect(updatedRecord.status).toBe('completed');
      expect(updatedRecord.bankToken).toBe('tok_bank_abcdef1234567890');

      // Verifiable cryptographic proof
      expect(proof.reference).toBe('PAY_COMPLETED_001');
      expect(proof.reason).toBe('user_request');
      expect(proof.requestedBy).toBe('user_wallet_GBRPY...');
      expect(proof.fieldsWiped).toContain('account_number');
      expect(proof.fieldsWiped).toContain('account_name');
      expect(proof.fieldsWiped).toContain('bvn');
      expect(proof.auditHash).toHaveLength(64);

      // Verify audit hash validity
      const expectedHash = generateAuditHash(
        record.reference,
        proof.deletedAt,
        proof.preservedAuditReference,
      );
      expect(proof.auditHash).toBe(expectedHash);
    });

    it('is strictly idempotent when deletion is invoked multiple times', () => {
      const payout = service.savePayout({
        reference: 'PAY_IDEMPOTENT_001',
        amount: 15000,
        currency: 'NGN',
        status: 'completed',
        accountNumber: '0987654321',
        accountName: 'Bob Idempotent',
        bankCode: '058',
      });

      const proof1 = service.deletePayoutPii(payout.reference, 'automated_expiry');
      expect(proof1).toBeDefined();

      // Second deletion invocation
      const proof2 = service.deletePayoutPii(payout.reference, 'automated_expiry');
      expect(proof2).toEqual(proof1);
      expect(proof2.auditHash).toBe(proof1.auditHash);
      expect(proof2.deletedAt).toBe(proof1.deletedAt);
    });

    it('blocks PII deletion when transfer is in pending active state', () => {
      service.savePayout({
        reference: 'PAY_PENDING_001',
        amount: 10000,
        currency: 'NGN',
        status: 'pending',
        accountNumber: '1122334455',
        accountName: 'In Flight User',
        bankCode: '057',
      });

      expect(() => {
        service.deletePayoutPii('PAY_PENDING_001', 'automated_expiry');
      }).toThrow(/Cannot execute PII deletion on pending transfer/i);
    });
  });

  describe('Retention Expiry Pruning Service', () => {
    it('prunes expired completed (24h) and failed (48h) payouts while retaining pending and recent records', () => {
      const now = Date.now();
      const ONE_HOUR = 60 * 60 * 1000;

      // 1. Expired completed payout (settled 25 hours ago)
      service.savePayout({
        reference: 'PAY_EXPIRED_COMPLETED',
        amount: 5000,
        currency: 'NGN',
        status: 'completed',
        accountNumber: '0011223344',
        accountName: 'Old Completed',
        bankCode: '058',
        settledAt: now - 25 * ONE_HOUR,
      });

      // 2. Recent completed payout (settled 2 hours ago - should be kept)
      service.savePayout({
        reference: 'PAY_RECENT_COMPLETED',
        amount: 8000,
        currency: 'NGN',
        status: 'completed',
        accountNumber: '0022334455',
        accountName: 'Recent Completed',
        bankCode: '058',
        settledAt: now - 2 * ONE_HOUR,
      });

      // 3. Expired failed payout (failed 50 hours ago)
      service.savePayout({
        reference: 'PAY_EXPIRED_FAILED',
        amount: 3000,
        currency: 'NGN',
        status: 'failed',
        accountNumber: '0033445566',
        accountName: 'Old Failed',
        bankCode: '044',
        settledAt: now - 50 * ONE_HOUR,
      });

      // 4. Recent failed payout (failed 10 hours ago - within 48h retry window)
      service.savePayout({
        reference: 'PAY_RECENT_FAILED',
        amount: 4000,
        currency: 'NGN',
        status: 'failed',
        accountNumber: '0044556677',
        accountName: 'Recent Failed',
        bankCode: '044',
        settledAt: now - 10 * ONE_HOUR,
      });

      // 5. Old pending payout (must NEVER be auto-deleted while in-flight)
      service.savePayout({
        reference: 'PAY_OLD_PENDING',
        amount: 100000,
        currency: 'NGN',
        status: 'pending',
        accountNumber: '0055667788',
        accountName: 'Stuck Pending',
        bankCode: '058',
        createdAt: now - 100 * ONE_HOUR,
      });

      const result = service.pruneExpiredPayouts(now);

      // Only the 2 expired records should have been pruned
      expect(result.prunedProofs).toHaveLength(2);
      const prunedRefs = result.prunedProofs.map((p) => p.reference);
      expect(prunedRefs).toContain('PAY_EXPIRED_COMPLETED');
      expect(prunedRefs).toContain('PAY_EXPIRED_FAILED');

      // Verify expired completed payout has PII wiped
      const expiredRec = service.getRecord('PAY_EXPIRED_COMPLETED');
      expect(expiredRec?.isPiiDeleted).toBe(true);
      expect(expiredRec?.accountNumber).toBeUndefined();

      // Verify recent completed payout still has PII stored (masked in default read)
      const recentRec = service.getRecord('PAY_RECENT_COMPLETED', { includeDecryptedPii: true });
      expect(recentRec?.isPiiDeleted).toBe(false);
      expect(recentRec?.accountNumber).toBe('0022334455');

      // Verify pending payout is untouched
      const pendingRec = service.getRecord('PAY_OLD_PENDING', { includeDecryptedPii: true });
      expect(pendingRec?.isPiiDeleted).toBe(false);
      expect(pendingRec?.accountNumber).toBe('0055667788');
    });
  });
});
