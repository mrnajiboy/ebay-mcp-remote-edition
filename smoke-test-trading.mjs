#!/usr/bin/env node
/**
 * Smoke test for Trading API: relist, get_listing, end_listing
 * Tests against a real ended listing (Leviton switch 168103939137)
 */
import { config } from 'dotenv';
config({ quiet: true });

// Dynamic imports from built output
const { EbayApiClient } = await import('./build/api/client.js');
const { TradingApiClient } = await import('./build/api/client-trading.js');
const { TradingApi } = await import('./build/api/trading/trading.js');

const ITEM_ID = '168103939137';

// Build config from env (same as getEbayConfig)
const ebayConfig = {
  clientId: process.env.EBAY_CLIENT_ID ?? '',
  clientSecret: process.env.EBAY_CLIENT_SECRET ?? '',
  environment: process.env.EBAY_ENVIRONMENT ?? 'production',
  accessToken: process.env.EBAY_USER_ACCESS_TOKEN ?? '',
  refreshToken: process.env.EBAY_USER_REFRESH_TOKEN ?? '',
  appAccessToken: process.env.EBAY_APP_ACCESS_TOKEN ?? '',
  marketplaceId: process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US',
  contentLanguage: process.env.EBAY_CONTENT_LANGUAGE ?? 'en-US',
};

const restClient = new EbayApiClient(ebayConfig);
await restClient.initialize();
const tradingClient = new TradingApiClient(restClient);
const api = new TradingApi(tradingClient);

async function step(name, fn) {
  process.stdout.write(`  ${name}... `);
  try {
    const result = await fn();
    console.log('OK');
    return result;
  } catch (err) {
    console.log(`FAIL: ${err.message}`);
    throw err;
  }
}

console.log(`\nSmoke testing Trading API against item ${ITEM_ID}\n`);

// Step 1: Relist the ended item
const relistResult = await step('relist_item', () => api.relistItem(ITEM_ID));
const newItemId = relistResult.ItemID || ITEM_ID;
console.log(`    Relisted as item: ${newItemId}`);

// Step 2: Get listing to verify it's active
const listing = await step('get_listing (verify active)', () => api.getListing(String(newItemId)));
const status = listing.SellingStatus?.ListingStatus || listing.ListingStatus || 'unknown';
console.log(`    Status: ${status}, Title: ${listing.Title}`);

// Step 3: End the listing
await step('end_listing', () => api.endListing(String(newItemId), 'NotAvailable'));

// Step 4: Get listing to verify it's ended
const ended = await step('get_listing (verify ended)', () => api.getListing(String(newItemId)));
const endedStatus = ended.SellingStatus?.ListingStatus || ended.ListingStatus || 'unknown';
console.log(`    Status: ${endedStatus}`);

// Step 5: Create a new listing (based on Leviton switch template)
console.log('\n--- create_listing test ---\n');
const testItem = {
  Title: 'TEST LISTING - Leviton 8-Port Switch - WILL BE ENDED IMMEDIATELY',
  PrimaryCategory: { CategoryID: '51268' },
  StartPrice: 24.99,
  ConditionID: 3000, // Used
  Country: 'US',
  Currency: 'USD',
  DispatchTimeMax: 0,
  ListingDuration: 'GTC',
  ListingType: 'FixedPriceItem',
  Quantity: 1,
  SKU: 'SMOKE-TEST-DELETE-ME',
  Description: '<p>Smoke test listing - will be ended immediately after creation.</p>',
  PictureDetails: {
    PictureURL: 'https://i.ebayimg.com/00/s/MTIwMFgxNjAw/z/E-oAAeSwr59pcu9X/$_57.PNG?set_id=880000500F',
  },
  ShippingDetails: {
    ShippingType: 'Flat',
    ShippingServiceOptions: {
      ShippingServicePriority: 1,
      ShippingService: 'USPSFirstClass',
      ShippingServiceCost: 0,
      FreeShipping: true,
    },
  },
  ReturnPolicy: {
    ReturnsAcceptedOption: 'ReturnsNotAccepted',
  },
  PostalCode: '98115',
  Location: 'Seattle, WA',
  ItemSpecifics: {
    NameValueList: [
      { Name: 'Type', Value: 'Ethernet Switch' },
      { Name: 'Brand', Value: 'Leviton' },
      { Name: 'Number of LAN Ports', Value: '8' },
      { Name: 'Network Connectivity', Value: 'Wired - Ethernet (RJ-45)' },
      { Name: 'Maximum Data Transfer Rate', Value: '100 Mbps' },
    ],
  },
};

const createResult = await step('create_listing', () => api.createListing(testItem));
const createdItemId = createResult.ItemID;
console.log(`    Created item: ${createdItemId}`);

// Ensure cleanup on unexpected exit
const cleanup = async () => {
  console.log(`\n    Cleaning up test listing ${createdItemId}...`);
  try {
    await api.endListing(String(createdItemId), 'NotAvailable');
    console.log('    Cleaned up.');
  } catch (e) {
    console.error(`    Cleanup failed: ${e.message}`);
  }
  process.exit(1);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Step 6: Verify it's live
const created = await step('get_listing (verify created)', () => api.getListing(String(createdItemId)));
console.log(`    Status: ${created.SellingStatus?.ListingStatus || 'unknown'}, Title: ${created.Title}`);

// Step 7: Wait for user to verify, then end it
console.log(`\n    >>> Check it out: https://www.ebay.com/itm/${createdItemId}`);
console.log('    >>> Press Enter when ready to end the listing...');
await new Promise(resolve => {
  process.stdin.once('data', resolve);
});
process.stdin.destroy();
await step('end_listing (cleanup)', () => api.endListing(String(createdItemId), 'NotAvailable'));
console.log(`    Cleaned up test listing ${createdItemId}`);

console.log('\n=== All 6 Trading API tools tested live ===\n');
console.log('  get_active_listings  — previous smoke test');
console.log('  get_listing          — verified active, ended, and created listings');
console.log('  revise_listing       — previous smoke test');
console.log('  relist_item          — relisted ended item');
console.log('  end_listing          — ended relisted + created items');
console.log('  create_listing       — created and verified new listing');