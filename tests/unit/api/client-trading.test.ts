import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import nock from 'nock';
import { TradingApiClient } from '@/api/client-trading.js';
import type { EbayApiClient } from '@/api/client.js';

function createMockRestClient(environment = 'production') {
  const mockOAuthClient = {
    getAccessToken: vi.fn().mockResolvedValue('mock_token'),
  };
  return {
    getConfig: vi.fn().mockReturnValue({ environment }),
    getOAuthClient: vi.fn().mockReturnValue(mockOAuthClient),
    _mockOAuthClient: mockOAuthClient,
  } as unknown as EbayApiClient & { _mockOAuthClient: { getAccessToken: ReturnType<typeof vi.fn> } };
}

describe('TradingApiClient', () => {
  let client: TradingApiClient;
  let mockRestClient: ReturnType<typeof createMockRestClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    nock.cleanAll();
    nock.disableNetConnect();
    mockRestClient = createMockRestClient('production');
    client = new TradingApiClient(mockRestClient as unknown as EbayApiClient);
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('should send XML request with correct headers', async () => {
    const scope = nock('https://api.ebay.com')
      .post('/ws/api.dll')
      .matchHeader('X-EBAY-API-CALL-NAME', 'GetMyeBaySelling')
      .matchHeader('X-EBAY-API-SITEID', '0')
      .matchHeader('X-EBAY-API-COMPATIBILITY-LEVEL', '1451')
      .matchHeader('X-EBAY-API-IAF-TOKEN', 'mock_token')
      .matchHeader('Content-Type', 'text/xml')
      .reply(
        200,
        `<?xml version="1.0" encoding="utf-8"?>
        <GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
          <Ack>Success</Ack>
        </GetMyeBaySellingResponse>`
      );

    const result = await client.execute('GetMyeBaySelling', {});
    expect(result.Ack).toBe('Success');
    scope.done();
  });

  it('should build XML request body from params', async () => {
    const scope = nock('https://api.ebay.com')
      .post('/ws/api.dll', (body: string) => {
        return body.includes('<ItemID>12345</ItemID>');
      })
      .reply(
        200,
        `<?xml version="1.0" encoding="utf-8"?>
        <GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
          <Ack>Success</Ack>
          <Item><ItemID>12345</ItemID></Item>
        </GetItemResponse>`
      );

    const result = await client.execute('GetItem', { ItemID: '12345' });
    expect(result.Ack).toBe('Success');
    scope.done();
  });

  it('should throw on eBay error response', async () => {
    nock('https://api.ebay.com')
      .post('/ws/api.dll')
      .reply(
        200,
        `<?xml version="1.0" encoding="utf-8"?>
        <GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
          <Ack>Failure</Ack>
          <Errors>
            <ShortMessage>Invalid item ID</ShortMessage>
            <LongMessage>The item ID 99999 is invalid.</LongMessage>
            <SeverityCode>Error</SeverityCode>
          </Errors>
        </GetItemResponse>`
      );

    await expect(client.execute('GetItem', { ItemID: '99999' })).rejects.toThrow(
      'Invalid item ID'
    );
  });

  it('should use sandbox URL for sandbox environment', () => {
    const sandboxClient = new TradingApiClient(
      createMockRestClient('sandbox') as unknown as EbayApiClient
    );
    expect(sandboxClient.getBaseUrl()).toBe('https://api.sandbox.ebay.com');
  });

  it('should use production URL for production environment', () => {
    expect(client.getBaseUrl()).toBe('https://api.ebay.com');
  });
});
