import { z } from 'zod';

export const trackingCadenceSchema = z.enum(['Daily', 'Hourly', 'Off']);

export const validationCurrentMetricsSchema = z.object({
  avgWatchersPerListing: z.number().nullable(),
  preOrderListingsCount: z.number().nullable(),
  twitterTrending: z.boolean(),
  youtubeViews24hMillions: z.number().nullable(),
  redditPostsCount7d: z.number().nullable(),
  marketPriceUsd: z.number().nullable(),
  avgShippingCostUsd: z.number().nullable(),
  competitionLevel: z.number().nullable(),
  marketPriceTrend: z.string(),
  day1Sold: z.number().nullable(),
  day2Sold: z.number().nullable(),
  day3Sold: z.number().nullable(),
  day4Sold: z.number().nullable(),
  day5Sold: z.number().nullable(),
  daysTracked: z.number().nullable(),
});

export const validationQueryContextSchema = z.object({
  directQueryActive: z.boolean().nullable().optional(),
  resolvedSearchQuery: z.string().nullable().optional(),
  validationScope: z.string().nullable().optional(),
  queryScope: z.string().nullable().optional(),
});

export const validationSourceContextSchema = z.object({
  sourceType: z.enum(['item', 'event']).optional(),
  hasItem: z.boolean().optional(),
  hasEvent: z.boolean().optional(),
  itemRecordId: z.string().nullable().optional(),
  eventRecordId: z.string().nullable().optional(),
});

const validationItemSchema = z.object({
  recordId: z.string().min(1).nullable(),
  name: z.string(),
  variation: z.array(z.string()),
  itemType: z.array(z.string()),
  releaseType: z.array(z.string()),
  releaseDate: z.string().datetime({ offset: true }).nullable(),
  releasePeriod: z.array(z.string()),
  availability: z.array(z.string()),
  wholesalePrice: z.number().nullable(),
  supplierNames: z.array(z.string()),
  canonicalArtists: z.array(z.string()),
  relatedAlbums: z.array(z.string()),
});

export const validationRunRequestSchema = z
  .object({
    validationId: z.string().min(1),
    runType: z.enum(['scheduled', 'manual']),
    cadence: trackingCadenceSchema,
    timestamp: z.string().datetime({ offset: true }),
    sourceContext: validationSourceContextSchema.optional(),
    item: validationItemSchema,
    validation: z.object({
      validationType: z.string(),
      buyDecision: z.string(),
      automationStatus: z.string(),
      autoCheckEnabled: z.boolean(),
      dDay: z.number().nullable(),
      artistTier: z.string(),
      initialBudget: z.number().nullable(),
      reserveBudget: z.number().nullable(),
      queryContext: validationQueryContextSchema.optional(),
      currentMetrics: validationCurrentMetricsSchema,
    }),
  })
  .superRefine((value, ctx) => {
    const sourceType = value.sourceContext?.sourceType ?? 'item';
    const itemRecordId = value.item.recordId?.trim() ?? '';
    const itemName = value.item.name.trim();

    if (sourceType === 'event') {
      return;
    }

    if (itemRecordId.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['item', 'recordId'],
        message: 'Item-driven validations require item.recordId.',
      });
    }

    if (itemName.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['item', 'name'],
        message: 'Item-driven validations require item.name.',
      });
    }
  });

export const validationWritesSchema = z.object({
  avgWatchersPerListing: z.number().nullable().optional(),
  preOrderListingsCount: z.number().nullable().optional(),
  twitterTrending: z.boolean().optional(),
  youtubeViews24hMillions: z.number().nullable().optional(),
  redditPostsCount7d: z.number().nullable().optional(),
  marketPriceUsd: z.number().nullable().optional(),
  avgShippingCostUsd: z.number().nullable().optional(),
  competitionLevel: z.number().nullable().optional(),
  marketPriceTrend: z.string().optional(),
  day1Sold: z.number().nullable().optional(),
  day2Sold: z.number().nullable().optional(),
  day3Sold: z.number().nullable().optional(),
  day4Sold: z.number().nullable().optional(),
  day5Sold: z.number().nullable().optional(),
  daysTracked: z.number().nullable().optional(),
  previousPobAvgPriceUsd: z.number().nullable().optional(),
  previousPobSellThroughPct: z.number().nullable().optional(),
  previousComebackFirstWeekSales: z.number().nullable().optional(),
  monitoringNotes: z.string().optional(),
  lastDataSnapshot: z.string().optional(),
  latestAiRecommendation: z.string().optional(),
  latestAiConfidence: z.enum(['High', 'Medium', 'Low']).optional(),
  validationError: z.string().optional(),
});

export const validationDecisionSchema = z.object({
  buyDecision: z.string().optional(),
  automationStatus: z.string().optional(),
  trackingCadence: trackingCadenceSchema.optional(),
  shouldAutoTrack: z.boolean().optional(),
  nextCheckAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export const validationRunResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    validationId: z.string(),
    writes: validationWritesSchema.optional(),
    decision: validationDecisionSchema.optional(),
    debug: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    status: z.literal('error'),
    validationId: z.string(),
    errorCode: z.string(),
    message: z.string(),
    retryable: z.boolean().optional(),
    nextCheckAt: z.string().datetime({ offset: true }).nullable().optional(),
  }),
]);
