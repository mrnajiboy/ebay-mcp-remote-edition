import type { ValidationRunRequest } from '../types.js';

const NOISY_VERSION_PATTERNS = [
  /\((?:weverse albums?|weverse|digipack|platform|photobook|poca|poca album|kit)\s+ver\.?\)/gi,
  /\((?:weverse albums?|weverse|digipack|platform|photobook|poca|poca album|kit)\s+version\)/gi,
  /\b(?:weverse albums?|weverse|digipack|platform|photobook|poca|poca album|kit)\s+ver\.?\b/gi,
  /\b(?:weverse albums?|weverse|digipack|platform|photobook|poca|poca album|kit)\s+version\b/gi,
];

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function simplifyItemTitle(title: string): string {
  let simplified = title;
  for (const pattern of NOISY_VERSION_PATTERNS) {
    simplified = simplified.replace(pattern, ' ');
  }
  return normalizeWhitespace(simplified);
}

export function titleAlreadyContainsArtist(title: string, artist: string): boolean {
  const normalizedTitle = normalizeWhitespace(title).toLowerCase();
  const normalizedArtist = normalizeWhitespace(artist).toLowerCase();
  return normalizedArtist.length > 0 && normalizedTitle.includes(normalizedArtist);
}

function removeBracketedContent(value: string): string {
  return normalizeWhitespace(value.replace(/\([^)]*\)/g, ' '));
}

function dedupeQueries(candidates: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of candidates) {
    const normalized = normalizeWhitespace(candidate);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function getPrimaryArtist(request: ValidationRunRequest): string {
  return request.item.canonicalArtists[0]?.trim() ?? '';
}

function getPrimaryAlbumPhrase(request: ValidationRunRequest): string {
  const relatedAlbum = request.item.relatedAlbums[0]?.trim();
  if (relatedAlbum) {
    return relatedAlbum;
  }

  const simplifiedTitle = simplifyItemTitle(request.item.name);
  const withoutArtist = request.item.canonicalArtists.reduce(
    (acc, artist) =>
      acc.replace(new RegExp(artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' '),
    simplifiedTitle
  );

  return normalizeWhitespace(removeBracketedContent(withoutArtist));
}

export function buildValidationQueryCandidates(request: ValidationRunRequest): string[] {
  const title = normalizeWhitespace(request.item.name);
  const simplifiedTitle = simplifyItemTitle(title);
  const titleWithoutParens = removeBracketedContent(simplifiedTitle);
  const primaryArtist = getPrimaryArtist(request);
  const primaryAlbumPhrase = getPrimaryAlbumPhrase(request);
  const validationType = request.validation.validationType.trim();

  const tier1 = simplifiedTitle || title;
  const tier2 = titleWithoutParens || tier1;
  const tier3 = normalizeWhitespace(
    [
      titleAlreadyContainsArtist(tier2, primaryArtist) ? '' : primaryArtist,
      primaryAlbumPhrase,
      validationType,
    ].join(' ')
  );
  const tier4 = normalizeWhitespace(
    [
      titleAlreadyContainsArtist(primaryAlbumPhrase, primaryArtist) ? '' : primaryArtist,
      primaryAlbumPhrase,
    ].join(' ')
  );
  const tier5 = normalizeWhitespace(
    [primaryArtist, request.item.releaseType[0] ?? '', primaryAlbumPhrase].join(' ')
  );

  return dedupeQueries([tier1, tier2, tier3, tier4, tier5]);
}
