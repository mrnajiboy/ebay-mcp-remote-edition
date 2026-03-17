import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DisputeApi } from '@/api/order-management/dispute.js';
import type { EbayApiClient } from '@/api/client.js';

describe('DisputeApi', () => {
  let disputeApi: DisputeApi;
  let mockClient: EbayApiClient;

  beforeEach(() => {
    mockClient = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as EbayApiClient;

    disputeApi = new DisputeApi(mockClient);
  });

  describe('getPaymentDispute', () => {
    it('should get payment dispute details', async () => {
      const mockDispute = {
        paymentDisputeId: 'DISPUTE-123',
        paymentDisputeStatus: 'OPEN',
      };

      vi.mocked(mockClient.get).mockResolvedValue(mockDispute);

      const result = await disputeApi.getPaymentDispute('DISPUTE-123');

      expect(mockClient.get).toHaveBeenCalledWith(
        '/sell/fulfillment/v1/payment_dispute/DISPUTE-123'
      );
      expect(result).toEqual(mockDispute);
    });
  });

  describe('fetchEvidenceContent', () => {
    it('should fetch evidence file content', async () => {
      const mockBuffer = new ArrayBuffer(8);
      vi.mocked(mockClient.get).mockResolvedValue(mockBuffer);

      const result = await disputeApi.fetchEvidenceContent(
        'DISPUTE-123',
        'EVIDENCE-456',
        'FILE-789'
      );

      expect(mockClient.get).toHaveBeenCalledWith(
        '/sell/fulfillment/v1/payment_dispute/DISPUTE-123/fetch_evidence_content',
        {
          evidence_id: 'EVIDENCE-456',
          file_id: 'FILE-789',
        }
      );
      expect(result).toEqual(mockBuffer);
    });
  });

  describe('getActivities', () => {
    it('should get payment dispute activity history', async () => {
      const mockActivity = {
        activity: [{ activityType: 'DISPUTE_OPENED', activityDate: '2025-01-01T00:00:00Z' }],
      };

      vi.mocked(mockClient.get).mockResolvedValue(mockActivity);

      const result = await disputeApi.getActivities('DISPUTE-123');

      expect(mockClient.get).toHaveBeenCalledWith(
        '/sell/fulfillment/v1/payment_dispute/DISPUTE-123/activity'
      );
      expect(result).toEqual(mockActivity);
    });
  });

  describe('getPaymentDisputeSummaries', () => {
    it('should search for payment disputes with no params', async () => {
      const mockSummaries = {
        disputeSummaries: [{ paymentDisputeId: 'DISPUTE-123' }],
        total: 1,
      };

      vi.mocked(mockClient.get).mockResolvedValue(mockSummaries);

      const result = await disputeApi.getPaymentDisputeSummaries();

      expect(mockClient.get).toHaveBeenCalledWith(
        '/sell/fulfillment/v1/payment_dispute_summary',
        undefined
      );
      expect(result).toEqual(mockSummaries);
    });

    it('should search for payment disputes with filters', async () => {
      const mockSummaries = {
        disputeSummaries: [],
        total: 0,
      };

      vi.mocked(mockClient.get).mockResolvedValue(mockSummaries);

      const params = {
        order_id: 'ORDER-123',
        payment_dispute_status: 'OPEN',
        limit: 10,
        offset: 0,
      };

      const result = await disputeApi.getPaymentDisputeSummaries(params);

      expect(mockClient.get).toHaveBeenCalledWith(
        '/sell/fulfillment/v1/payment_dispute_summary',
        params
      );
      expect(result).toEqual(mockSummaries);
    });
  });

  describe('contestPaymentDispute', () => {
    it('should contest a payment dispute without body', async () => {
      vi.mocked(mockClient.post).mockResolvedValue(undefined);

      await disputeApi.contestPaymentDispute('DISPUTE-123');

      expect(mockClient.post).toHaveBeenCalledWith(
        '/sell/fulfillment/v1/payment_dispute/DISPUTE-123/contest',
        undefined
      );
    });

    it('should contest a payment dispute with request body', async () => {
      vi.mocked(mockClient.post).mockResolvedValue(undefined);

      const body = {
        returnAddress: {
          addressLine1: '123 Main St',
          city: 'San Francisco',
          stateOrProvince: 'CA',
          postalCode: '94105',
          countryCode: 'US',
        },
      };

      await disputeApi.contestPaymentDispute('DISPUTE-123', body);

      expect(mockClient.post).toHaveBeenCalledWith(
        '/sell/fulfillment/v1/payment_dispute/DISPUTE-123/contest',
        body
      );
    });
  });

  describe('acceptPaymentDispute', () => {
    it('should accept a payment dispute without body', async () => {
      vi.mocked(mockClient.post).mockResolvedValue(undefined);

      await disputeApi.acceptPaymentDispute('DISPUTE-123');

      expect(mockClient.post).toHaveBeenCalledWith(
        '/sell/fulfillment/v1/payment_dispute/DISPUTE-123/accept',
        undefined
      );
    });

    it('should accept a payment dispute with request body', async () => {
      vi.mocked(mockClient.post).mockResolvedValue(undefined);

      const body = {
        returnAddress: {
          addressLine1: '123 Main St',
          city: 'San Francisco',
          stateOrProvince: 'CA',
          postalCode: '94105',
          countryCode: 'US',
        },
      };

      await disputeApi.acceptPaymentDispute('DISPUTE-123', body);

      expect(mockClient.post).toHaveBeenCalledWith(
        '/sell/fulfillment/v1/payment_dispute/DISPUTE-123/accept',
        body
      );
    });
  });

  describe('uploadEvidenceFile', () => {
    it('should upload an evidence file', async () => {
      const mockFileEvidence = {
        evidenceId: 'EVIDENCE-123',
        files: [{ fileId: 'FILE-456' }],
      };

      vi.mocked(mockClient.post).mockResolvedValue(mockFileEvidence);

      const buffer = new ArrayBuffer(8);
      const result = await disputeApi.uploadEvidenceFile('DISPUTE-123', buffer);

      expect(mockClient.post).toHaveBeenCalledWith(
        '/sell/fulfillment/v1/payment_dispute/DISPUTE-123/upload_evidence_file',
        buffer,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      expect(result).toEqual(mockFileEvidence);
    });
  });

  describe('addEvidence', () => {
    it('should add evidence to a dispute', async () => {
      const mockResponse = {
        evidenceId: 'EVIDENCE-123',
      };

      vi.mocked(mockClient.post).mockResolvedValue(mockResponse);

      const body = {
        evidenceType: 'PROOF_OF_DELIVERY',
        files: [{ fileId: 'FILE-456' }],
        lineItems: [{ itemId: 'ITEM-789', quantity: 1 }],
      };

      const result = await disputeApi.addEvidence('DISPUTE-123', body);

      expect(mockClient.post).toHaveBeenCalledWith(
        '/sell/fulfillment/v1/payment_dispute/DISPUTE-123/add_evidence',
        body
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('updateEvidence', () => {
    it('should update evidence for a dispute', async () => {
      vi.mocked(mockClient.post).mockResolvedValue(undefined);

      const body = {
        evidenceId: 'EVIDENCE-123',
        lineItems: [{ itemId: 'ITEM-789', quantity: 2 }],
      };

      await disputeApi.updateEvidence('DISPUTE-123', body);

      expect(mockClient.post).toHaveBeenCalledWith(
        '/sell/fulfillment/v1/payment_dispute/DISPUTE-123/update_evidence',
        body
      );
    });
  });
});
