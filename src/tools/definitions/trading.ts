import { z } from 'zod';
import type { ToolDefinition } from './account.js';

// Schema for Trading API price fields that include currency
const PriceWithCurrencySchema = z.union([
  z.string(),
  z.object({
    value: z.string().or(z.number()).describe('Price value'),
    currencyID: z.string().optional().describe('Currency code, e.g., USD, EUR, GBP'),
  }),
]);

// Schema for Trading API item specifics (NameValueList)
const ItemSpecificsSchema = z.array(
  z.object({
    name: z.string().describe('Specific name, e.g., Brand, Colour, Size'),
    value: z.union([z.string(), z.array(z.string())]).describe('Specific value(s)'),
  })
);

// Schema for Trading API item object
const TradingItemSchema = z.object({
  // Required fields
  Title: z.string().describe('Item title (max 80 characters)'),
  PrimaryCategory: z
    .object({
      CategoryID: z.string().describe('eBay category ID, e.g., "15032"'),
    })
    .describe('Primary category for the listing'),
  StartPrice: PriceWithCurrencySchema.describe('Starting price or fixed price'),
  ConditionID: z.union([z.number(), z.string()]).describe('eBay condition ID, e.g., 1000 for New'),
  Country: z.string().describe('ISO country code, e.g., US, GB, DE'),
  Currency: z.string().optional().describe('Currency code, e.g., USD, EUR, GBP'),
  DispatchTimeMax: z.union([z.number(), z.string()]).describe('Max dispatch time in days'),
  ListingDuration: z
    .string()
    .describe(
      'Listing duration — use Days_30 (recommended), Days_7, Days_10, Days_14, Days_21, Days_30, Days_60, Days_90. GMS/GN may not be available for all accounts.'
    ),
  ListingType: z.literal('FixedPriceItem').describe('Must be "FixedPriceItem"'),
  Quantity: z.union([z.number(), z.string()]).describe('Number of items available'),
  SKU: z.string().describe('Stock keeping unit / inventory identifier'),

  // Optional fields
  Subtitle: z.string().optional().describe('Item subtitle (max 35 characters)'),
  Description: z.string().optional().describe('HTML description of the item'),
  ItemSpecifics: ItemSpecificsSchema.optional().describe('Product specifics/attributes'),
  PicturesDetails: z
    .object({
      GalleryType: z.string().optional().describe('Gallery type, e.g., Plus, Summary'),
      PictureURL: z.array(z.string()).describe('Array of image URLs'),
    })
    .optional()
    .describe('Picture details for the listing'),
  ShippingDetails: z
    .object({
      ShippingServiceOptions: z
        .object({
          ShippingServicePriority: z.string().optional().describe('Shipping priority (1-9)'),
          ShippingServiceID: z.string().describe('eBay shipping service ID'),
          ShippingServiceCost: PriceWithCurrencySchema.describe('Shipping cost'),
          ShippingType: z.string().describe('Shipping type: Flat, FlatPlusHandling, or Calculated'),
        })
        .describe('Domestic shipping service options'),
      InternationalShippingServiceOption: z
        .array(
          z.object({
            ShippingServicePriority: z.string().optional().describe('Shipping priority (1-9)'),
            ShippingServiceID: z.string().describe('eBay shipping service ID'),
            ShippingServiceCost: PriceWithCurrencySchema.describe('Shipping cost'),
            ShippingType: z.string().describe('Shipping type'),
            Country: z.array(z.string()).describe('Array of destination country codes'),
          })
        )
        .optional()
        .describe('International shipping service options'),
      HandlingTime: z.union([z.number(), z.string()]).optional().describe('Handling time in days'),
    })
    .optional()
    .describe('Shipping details for the listing'),
  ReturnPolicy: z
    .object({
      ReturnsAcceptedOption: z
        .string()
        .describe('Returns accepted: ReturnsAccepted or ReturnsNotAccepted'),
      ReturnsWithinOption: z
        .string()
        .describe('Return window: Days_30, Days_60, Days_90 (with underscore)'),
      Description: z.string().describe('Return policy description'),
      RefundOption: z.string().optional().describe('Refund type: MoneyBack or Replacement'),
    })
    .optional()
    .describe('Return policy for the listing'),
  PaymentMethods: z.array(z.string()).optional().describe('Accepted payment methods'),
  ProxyItem: z.boolean().optional().describe('Whether this is a proxy item'),
});

export const tradingTools: ToolDefinition[] = [
  {
    name: 'ebay_get_active_listings',
    description:
      'Get all active fixed-price listings with SKU, quantity, price, and watch count.\n\nUses the Trading API (GetMyeBaySelling). Returns listings created via any method (UI, Trading API, or REST API).\n\nRequired: User OAuth token.',
    inputSchema: {
      page: z.number().optional().describe('Page number (default 1)'),
      entriesPerPage: z.number().optional().describe('Items per page, max 200 (default 50)'),
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'ebay_get_listing',
    description:
      'Get full details for a single listing by item ID.\n\nUses the Trading API (GetItem). Returns all listing fields including description, specifics, shipping, and images.\n\nRequired: User OAuth token.',
    inputSchema: {
      itemId: z.string().describe('The eBay item ID (e.g., "167382780779")'),
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'ebay_create_listing',
    description:
      'Create a new fixed-price listing.\\n\\nUses the Trading API (AddFixedPriceItem). Requires complete item details.\\n\\nIMPORTANT: Photos are REQUIRED and MUST be hosted on eBay servers. External URLs (even HTTPS) are rejected. To get eBay-hosted photo URLs:\\n1. Upload photos via eBay Seller Hub UI\\n2. Use the eBay Image Hosting API (if enabled for your app)\\n3. Reference existing eBay-hosted URLs from previous listings\\n\\nRequired: User OAuth token.',
    inputSchema: {
      item: TradingItemSchema.describe(
        'Trading API item object with eBay-specific field structure.'
      ),
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'ebay_revise_listing',
    description:
      'Revise an existing fixed-price listing. Update quantity, price, title, description, or other supported fields.\n\nUses the Trading API (ReviseFixedPriceItem). For inventory-based listings, Title, Description, Quantity, and StartPrice use an Inventory API fallback. A PictureDetails-only revision is also supported for inventory-based listings: it re-syncs the complete current PictureURL array to product.imageUrls, but rejects any URL that differs from the active listing or any companion field.\n\nExamples:\n- Update quantity: { "Quantity": 10 }\n- Update price: { "StartPrice": 14.99 }\n- Re-sync current pictures only: { "PictureDetails": { "PictureURL": ["https://i.ebayimg.com/...", "https://i.ebayimg.com/..."] } }\n\nRequired: User OAuth token.',
    inputSchema: {
      itemId: z.string().describe('The eBay item ID to revise'),
      fields: z
        .record(z.string(), z.unknown())
        .describe('Fields to update (e.g., { "Quantity": 10, "StartPrice": 14.99 })'),
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'ebay_end_listing',
    description:
      'End/remove an active fixed-price listing.\n\nUses the Trading API (EndFixedPriceItem).\n\nRequired: User OAuth token.',
    inputSchema: {
      itemId: z.string().describe('The eBay item ID to end'),
      reason: z
        .enum([
          'NotAvailable',
          'Incorrect',
          'LostOrBroken',
          'OtherListingError',
          'SellToHighBidder',
        ])
        .optional()
        .describe('Reason for ending (default: NotAvailable)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'ebay_relist_item',
    description:
      'Relist an ended fixed-price listing, optionally with modifications.\n\nUses the Trading API (RelistFixedPriceItem).\n\nRequired: User OAuth token.',
    inputSchema: {
      itemId: z.string().describe('The eBay item ID to relist'),
      modifications: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Optional fields to change when relisting (e.g., { "Quantity": 20 })'),
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'ebay_upload_images',
    description:
      "Upload images to eBay Picture Services using the Commerce Media API and get eBay-hosted image URLs for use in listings.\n\nTwo modes:\n1. **From URL** — Provide imageUrls (public URLs). eBay fetches and hosts them by default. Set forceLocalProcessing=true to make the hosted MCP server download the URL, process it with Sharp, then upload JPEG binary through eBay's authenticated file endpoint.\n2. **From file** — Provide imageFiles (local file paths). Files are processed with Sharp and uploaded as JPEG binary.\n\nSupports: JPG, GIF, PNG, BMP, TIFF, AVIF, HEIC, WEBP. Max 10MB per image.\n\nReturns a result for each uploaded image including the eBay-hosted URL, image ID, and uploadMode.",
    inputSchema: {
      imageUrls: z
        .array(z.string().describe('Public URL of the image to upload'))
        .optional()
        .describe('Array of image URLs to upload (use imageFiles OR imageUrls, not both)'),
      imageFiles: z
        .array(z.string().describe('Local file path of the image to upload'))
        .optional()
        .describe('Array of local file paths to upload (use imageFiles OR imageUrls, not both)'),
      forceLocalProcessing: z
        .boolean()
        .optional()
        .describe(
          'For imageUrls only: force hosted-server download, Sharp processing, and authenticated binary upload instead of eBay URL ingestion. Use when direct URL ingestion creates placeholders or ImageProcessingError.'
        ),
      description: z.string().optional().describe('Optional description for the uploaded images'),
    },
    annotations: { readOnlyHint: false },
  },
];
