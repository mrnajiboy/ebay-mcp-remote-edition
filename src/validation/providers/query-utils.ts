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

export function sanitizeQueryCandidate(query: string): string {
  return normalizeWhitespace(query)
    .replace(/^[\s\-–—:;,./]+/, '')
    .replace(/[\s\-–—:;,./]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
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
    const normalized = sanitizeQueryCandidate(candidate);
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

function extractMeaningfulTitleToken(value: string): string {
  const tokens = sanitizeQueryCandidate(value)
    .split(' ')
    .map((token) => token.replace(/[^a-zA-Z0-9]+/g, ''))
    .filter((token) => token.length >= 3);

  return tokens[0] ?? '';
}

function ensureArtistRetention(candidate: string, primaryArtist: string): string {
  if (!primaryArtist) {
    return sanitizeQueryCandidate(candidate);
  }

  const sanitized = sanitizeQueryCandidate(candidate);
  if (!sanitized) {
    return sanitizeQueryCandidate(primaryArtist);
  }

  if (titleAlreadyContainsArtist(sanitized, primaryArtist)) {
    return sanitized;
  }

  return sanitizeQueryCandidate(`${primaryArtist} ${sanitized}`);
}

function isValidCandidate(candidate: string, primaryArtist: string, albumPhrase: string): boolean {
  const sanitized = sanitizeQueryCandidate(candidate);
  if (sanitized.length < 8) {
    return false;
  }

  if (!/[a-zA-Z]/.test(sanitized)) {
    return false;
  }

  const meaningfulAlbumToken = extractMeaningfulTitleToken(albumPhrase);
  const hasArtist = primaryArtist ? titleAlreadyContainsArtist(sanitized, primaryArtist) : false;
  const hasAlbumToken = meaningfulAlbumToken
    ? sanitized.toLowerCase().includes(meaningfulAlbumToken.toLowerCase())
    : false;

  return hasArtist || hasAlbumToken;
}

export function buildValidationQueryCandidates(request: ValidationRunRequest): string[] {
  const title = normalizeWhitespace(request.item.name);
  const simplifiedTitle = simplifyItemTitle(title);
  const titleWithoutParens = removeBracketedContent(simplifiedTitle);
  const primaryArtist = getPrimaryArtist(request);
  const primaryAlbumPhrase = getPrimaryAlbumPhrase(request);
  const validationType = request.validation.validationType.trim();

  const tier1 = ensureArtistRetention(simplifiedTitle || title, primaryArtist);
  const tier2 = ensureArtistRetention(titleWithoutParens || tier1, primaryArtist);
  const tier3 = ensureArtistRetention(
    normalizeWhitespace(
      [
        titleAlreadyContainsArtist(tier2, primaryArtist) ? '' : primaryArtist,
        primaryAlbumPhrase,
        validationType,
      ].join(' ')
    ),
    primaryArtist
  );
  const tier4 = ensureArtistRetention(
    normalizeWhitespace(
      [
        titleAlreadyContainsArtist(primaryAlbumPhrase, primaryArtist) ? '' : primaryArtist,
        primaryAlbumPhrase,
      ].join(' ')
    ),
    primaryArtist
  );
  const tier5 = ensureArtistRetention(
    [primaryArtist, request.item.releaseType[0] ?? '', primaryAlbumPhrase].join(' '),
    primaryArtist
  );

  return dedupeQueries([tier1, tier2, tier3, tier4, tier5]).filter((candidate) =>
    isValidCandidate(candidate, primaryArtist, primaryAlbumPhrase)
  );
}
