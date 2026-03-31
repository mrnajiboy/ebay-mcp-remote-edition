import type { ValidationRunRequest } from '../types.js';

export interface ProviderQueryCandidate {
  family: string;
  query: string;
}

const NOISY_VERSION_PATTERNS = [
  /\((?:weverse albums?|weverse|digipack|platform|photobook|poca|poca album|kit)\s+ver\.?\)/gi,
  /\((?:weverse albums?|weverse|digipack|platform|photobook|poca|poca album|kit)\s+version\)/gi,
  /\b(?:weverse albums?|weverse|digipack|platform|photobook|poca|poca album|kit)\s+ver\.?\b/gi,
  /\b(?:weverse albums?|weverse|digipack|platform|photobook|poca|poca album|kit)\s+version\b/gi,
];

const GENERIC_QUERY_TOKENS = new Set([
  'album',
  'albums',
  'ep',
  'single',
  'mini',
  'the',
  'and',
  'ver',
  'version',
  'release',
  'repackage',
  'pob',
  'benefit',
  'photocard',
  'preorder',
  'pre',
  'order',
]);

const POB_LIKE_PATTERN = /\bpob\b|pre\s*order|preorder|benefit|photocard/i;
const LISTING_NOISE_PATTERN = /\bset\b|\blot\b|\bbundle\b|fanmade|replica|unofficial/gi;
const GENERIC_DESCRIPTOR_PATTERN =
  /^(?:album|albums|standard album|standard|cd|music|release|kpop|version|ver)\b/i;
const BROWSE_DESCRIPTOR_HINT_PATTERN =
  /\blimited\b|\bdeluxe\b|\bdigipack\b|\bplatform\b|\bjewel\b|\bphotobook\b|\bkit\b|\bpoca\b|\bweverse\b|\bcompact\b|\btarget\b|\bexclusive\b|\bsigned\b|\bvinyl\b|\blp\b|\bstandard\b/i;
const SOCIAL_CONVERSATION_NOISE_PATTERN =
  /\b(?:lp|vinyl|cd|photobook|digipack|platform|jewel|compact|kit|poca|weverse|standard|limited|deluxe|edition|version|ver\.?)\b/gi;

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizeQueryCandidate(query: string): string {
  return normalizeWhitespace(query)
    .replace(/^[\s\-–—:;,./]+/, '')
    .replace(/[\s\-–—:;,./]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeQuery(value: string): string[] {
  return sanitizeQueryCandidate(value)
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((token) => token.length > 0);
}

export function extractSemanticTokens(value: string): string[] {
  return tokenizeQuery(value).filter(
    (token) =>
      token.length >= 3 &&
      !GENERIC_QUERY_TOKENS.has(token) &&
      !/^\d+$/.test(token) &&
      !/^\d+(?:st|nd|rd|th)$/.test(token)
  );
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

function stripArtistsFromText(value: string, artists: string[]): string {
  return artists.reduce((result, artist) => {
    const sanitizedArtist = sanitizeQueryCandidate(artist);
    if (!sanitizedArtist) {
      return result;
    }

    return result.replace(new RegExp(escapeRegExp(sanitizedArtist), 'ig'), ' ');
  }, value);
}

function stripPrimaryArtist(candidate: string, primaryArtist: string): string {
  const sanitizedArtist = sanitizeQueryCandidate(primaryArtist);
  if (!sanitizedArtist) {
    return sanitizeQueryCandidate(candidate);
  }

  return sanitizeQueryCandidate(
    candidate.replace(new RegExp(escapeRegExp(sanitizedArtist), 'ig'), ' ')
  );
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

export function getPrimaryAlbumPhrase(request: ValidationRunRequest): string {
  const relatedAlbum = sanitizeQueryCandidate(request.item.relatedAlbums[0]?.trim() ?? '');
  if (relatedAlbum && extractSemanticTokens(relatedAlbum).length > 0) {
    return relatedAlbum;
  }

  const simplifiedTitle = simplifyItemTitle(request.item.name);
  const withoutArtist = stripArtistsFromText(simplifiedTitle, request.item.canonicalArtists);
  const cleanedWithoutArtist = sanitizeQueryCandidate(removeBracketedContent(withoutArtist));
  if (extractSemanticTokens(cleanedWithoutArtist).length > 0) {
    return cleanedWithoutArtist;
  }

  const cleanedTitle = sanitizeQueryCandidate(removeBracketedContent(simplifiedTitle));
  return extractSemanticTokens(cleanedTitle).length > 0 ? cleanedTitle : relatedAlbum;
}

function extractMeaningfulTitleToken(value: string): string {
  const tokens = extractSemanticTokens(value);

  return tokens[0] ?? '';
}

export function ensureArtistRetention(candidate: string, primaryArtist: string): string {
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

  if (!/[\p{L}\p{N}]/u.test(sanitized)) {
    return false;
  }

  const semanticTokens = extractSemanticTokens(sanitized);
  if (semanticTokens.length === 0) {
    return false;
  }

  const meaningfulAlbumToken = extractMeaningfulTitleToken(albumPhrase);
  const hasArtist = primaryArtist ? titleAlreadyContainsArtist(sanitized, primaryArtist) : false;
  const hasAlbumToken = meaningfulAlbumToken
    ? semanticTokens.includes(meaningfulAlbumToken.toLowerCase())
    : false;

  if (!primaryArtist) {
    return hasAlbumToken || semanticTokens.length > 0;
  }

  const nonArtistSemanticTokens = extractSemanticTokens(
    stripPrimaryArtist(sanitized, primaryArtist)
  );

  return hasAlbumToken || (hasArtist && nonArtistSemanticTokens.length > 0);
}

function buildCompactPhrase(...parts: string[]): string {
  return sanitizeQueryCandidate(
    parts
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/[,:;/\\|]+/g, ' ')
      .replace(/[-–—]+/g, ' ')
      .replace(/\s+/g, ' ')
  );
}

function normalizeDescriptorPhrase(value: string): string {
  return sanitizeQueryCandidate(
    removeBracketedContent(simplifyItemTitle(value))
      .replace(/\bpob\b|pre\s*order|preorder|benefit|photocard/gi, ' ')
      .replace(LISTING_NOISE_PATTERN, ' ')
      .replace(/\b(?:sealed|new|official)\b/gi, ' ')
  );
}

function collectDescriptorPhrases(
  request: ValidationRunRequest,
  options: {
    allowPobLike: boolean;
    includeValidationType: boolean;
    browseFocused: boolean;
  }
): string[] {
  const rawValues = [
    ...request.item.variation,
    ...request.item.itemType,
    ...request.item.releaseType,
    ...(options.includeValidationType ? [request.validation.validationType] : []),
  ];

  const descriptors = rawValues
    .map((value) => normalizeDescriptorPhrase(value))
    .filter(Boolean)
    .filter((value) => !GENERIC_DESCRIPTOR_PATTERN.test(value.toLowerCase()))
    .filter((value) => (options.allowPobLike ? true : !POB_LIKE_PATTERN.test(value)));

  const uniqueDescriptors = dedupeQueries(descriptors).filter((descriptor) => {
    const semanticTokens = extractSemanticTokens(descriptor);
    if (semanticTokens.length === 0) {
      return false;
    }

    if (!options.browseFocused) {
      return true;
    }

    return (
      BROWSE_DESCRIPTOR_HINT_PATTERN.test(descriptor.toLowerCase()) || semanticTokens.length >= 2
    );
  });

  return uniqueDescriptors.slice(0, 3);
}

function dedupeQueryPlan(candidates: ProviderQueryCandidate[]): ProviderQueryCandidate[] {
  const seen = new Set<string>();
  const result: ProviderQueryCandidate[] = [];

  for (const candidate of candidates) {
    const normalized = sanitizeQueryCandidate(candidate.query);
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({
      family: candidate.family,
      query: normalized,
    });
  }

  return result;
}

function isValidConversationQuery(candidate: string): boolean {
  const sanitized = sanitizeQueryCandidate(candidate);

  return sanitized.length >= 2 && /[\p{L}\p{N}]/u.test(sanitized);
}

function finalizeConversationQueryPlan(
  candidates: ProviderQueryCandidate[]
): ProviderQueryCandidate[] {
  return dedupeQueryPlan(candidates).filter((candidate) => isValidConversationQuery(candidate.query));
}

function buildConversationAlbumPhrase(albumPhrase: string): string {
  const primarySegment = sanitizeQueryCandidate(albumPhrase.split(',')[0] ?? albumPhrase);

  return sanitizeQueryCandidate(primarySegment.replace(SOCIAL_CONVERSATION_NOISE_PATTERN, ' '));
}

function finalizeQueryPlan(
  candidates: ProviderQueryCandidate[],
  primaryArtist: string,
  albumPhrase: string
): ProviderQueryCandidate[] {
  return dedupeQueryPlan(candidates).filter((candidate) =>
    isValidCandidate(candidate.query, primaryArtist, albumPhrase)
  );
}

function buildCorePhrases(request: ValidationRunRequest): {
  primaryArtist: string;
  albumPhrase: string;
  simplifiedTitle: string;
  artistAlbumPhrase: string;
  titleWithArtist: string;
} {
  const primaryArtist = getPrimaryArtist(request);
  const albumPhrase = getPrimaryAlbumPhrase(request);
  const simplifiedTitle = sanitizeQueryCandidate(
    removeBracketedContent(simplifyItemTitle(request.item.name))
  );
  const artistAlbumPhrase = ensureArtistRetention(
    buildCompactPhrase(primaryArtist, albumPhrase),
    primaryArtist
  );
  const titleWithArtist = ensureArtistRetention(simplifiedTitle, primaryArtist);

  return {
    primaryArtist,
    albumPhrase,
    simplifiedTitle,
    artistAlbumPhrase,
    titleWithArtist,
  };
}

export function buildBrowseQueryPlan(request: ValidationRunRequest): ProviderQueryCandidate[] {
  const { primaryArtist, albumPhrase, simplifiedTitle, artistAlbumPhrase, titleWithArtist } =
    buildCorePhrases(request);
  const browseDescriptors = collectDescriptorPhrases(request, {
    allowPobLike: false,
    includeValidationType: false,
    browseFocused: true,
  });

  return finalizeQueryPlan(
    [
      { family: 'artist_album_core', query: artistAlbumPhrase },
      ...browseDescriptors.map((descriptor) => ({
        family: 'artist_album_descriptor',
        query: buildCompactPhrase(artistAlbumPhrase, descriptor),
      })),
      { family: 'artist_title_listing', query: titleWithArtist },
      {
        family: 'artist_release_album',
        query: buildCompactPhrase(primaryArtist, request.item.releaseType[0] ?? '', albumPhrase),
      },
      { family: 'album_core', query: buildCompactPhrase(albumPhrase) },
      { family: 'simplified_title', query: simplifiedTitle },
    ],
    primaryArtist,
    albumPhrase
  );
}

export function buildBrowseQueryCandidates(request: ValidationRunRequest): string[] {
  return buildBrowseQueryPlan(request).map((candidate) => candidate.query);
}

export function buildSoldQueryPlan(request: ValidationRunRequest): ProviderQueryCandidate[] {
  const { primaryArtist, albumPhrase, titleWithArtist, artistAlbumPhrase } =
    buildCorePhrases(request);
  const soldDescriptors = collectDescriptorPhrases(request, {
    allowPobLike: true,
    includeValidationType: true,
    browseFocused: false,
  });
  const validationType = sanitizeQueryCandidate(request.validation.validationType);

  return finalizeQueryPlan(
    [
      { family: 'artist_album_core', query: artistAlbumPhrase },
      ...soldDescriptors.map((descriptor) => ({
        family: 'artist_album_descriptor',
        query: buildCompactPhrase(artistAlbumPhrase, descriptor),
      })),
      {
        family: 'artist_album_validation_type',
        query: buildCompactPhrase(primaryArtist, albumPhrase, validationType),
      },
      { family: 'artist_title_listing', query: titleWithArtist },
      { family: 'album_descriptor_only', query: buildCompactPhrase(albumPhrase, validationType) },
    ],
    primaryArtist,
    albumPhrase
  );
}

export function buildSoldQueryCandidates(request: ValidationRunRequest): string[] {
  return buildSoldQueryPlan(request).map((candidate) => candidate.query);
}

export function buildTwitterQueryPlan(request: ValidationRunRequest): ProviderQueryCandidate[] {
  const { primaryArtist, albumPhrase } = buildCorePhrases(request);
  const compactArtist = buildCompactPhrase(primaryArtist);
  const compactAlbum = buildCompactPhrase(buildConversationAlbumPhrase(albumPhrase));

  return finalizeConversationQueryPlan(
    [
      {
        family: 'artist_album_conversation',
        query: buildCompactPhrase(compactArtist, compactAlbum),
      },
      {
        family: 'quoted_artist_album',
        query: compactArtist && compactAlbum ? `"${compactArtist}" "${compactAlbum}"` : '',
      },
      {
        family: 'artist_album_keyword',
        query: buildCompactPhrase(compactArtist, 'album'),
      },
      { family: 'artist_only_fallback', query: compactArtist },
      { family: 'album_only_fallback', query: compactAlbum },
    ]
  );
}

export function buildTwitterQueryCandidates(request: ValidationRunRequest): string[] {
  return buildTwitterQueryPlan(request).map((candidate) => candidate.query);
}

export function buildYouTubeQueryPlan(request: ValidationRunRequest): ProviderQueryCandidate[] {
  const { primaryArtist, albumPhrase } = buildCorePhrases(request);
  const artistAlbum = buildCompactPhrase(primaryArtist, albumPhrase);

  return finalizeQueryPlan(
    [
      { family: 'artist_album_media_core', query: artistAlbum },
      { family: 'artist_album_official', query: buildCompactPhrase(artistAlbum, 'official') },
      { family: 'artist_album_mv', query: buildCompactPhrase(artistAlbum, 'mv') },
      { family: 'artist_album_music_video', query: buildCompactPhrase(artistAlbum, 'music video') },
      { family: 'artist_album_teaser', query: buildCompactPhrase(artistAlbum, 'teaser') },
      { family: 'artist_album_performance', query: buildCompactPhrase(artistAlbum, 'performance') },
    ],
    primaryArtist,
    albumPhrase
  );
}

export function buildYouTubeQueryCandidates(request: ValidationRunRequest): string[] {
  return buildYouTubeQueryPlan(request).map((candidate) => candidate.query);
}

export function buildRedditQueryPlan(request: ValidationRunRequest): ProviderQueryCandidate[] {
  const { primaryArtist, albumPhrase } = buildCorePhrases(request);
  const artistAlbum = buildCompactPhrase(primaryArtist, albumPhrase);

  return finalizeQueryPlan(
    [
      { family: 'artist_album_discussion', query: artistAlbum },
      { family: 'album_artist_discussion', query: buildCompactPhrase(albumPhrase, primaryArtist) },
      {
        family: 'artist_album_comeback',
        query: buildCompactPhrase(primaryArtist, albumPhrase, 'discussion'),
      },
    ],
    primaryArtist,
    albumPhrase
  );
}

export function buildRedditQueryCandidates(request: ValidationRunRequest): string[] {
  return buildRedditQueryPlan(request).map((candidate) => candidate.query);
}

export function buildValidationQueryCandidates(request: ValidationRunRequest): string[] {
  return buildSoldQueryCandidates(request);
}
