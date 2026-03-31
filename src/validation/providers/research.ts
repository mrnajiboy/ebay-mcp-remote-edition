import type { PreviousComebackResearchSignals, ValidationRunRequest } from '../types.js';

export async function getPreviousComebackResearchSignals(
  request: ValidationRunRequest
): Promise<PreviousComebackResearchSignals> {
  await Promise.resolve();

  const hasPerplexityKey = (process.env.PERPLEXITY_API_KEY ?? '').trim().length > 0;
  const primaryAlbum = request.item.relatedAlbums[0] ?? null;

  return {
    previousAlbumTitle: null,
    previousComebackFirstWeekSales: null,
    confidence: 'Low',
    notes: hasPerplexityKey
      ? `Research provider contract is ready, but historical comeback lookup for ${primaryAlbum ?? 'this release'} is not implemented yet.`
      : 'Research provider contract is ready, but PERPLEXITY_API_KEY is not configured and historical comeback lookup is not implemented yet.',
    sources: [],
  };
}
