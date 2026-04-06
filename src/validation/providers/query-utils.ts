import type {
  ProviderQueryResolutionDebug,
  ValidationQueryContext,
  ValidationRunRequest,
} from '../types.js';
import { getValidationEffectiveContext } from '../effective-context.js';

export interface ProviderQueryCandidate {
  family: string;
  query: string;
}

export interface ResolvedProviderQueryPlan {
  queryPlan: ProviderQueryCandidate[];
  queryResolution: ProviderQueryResolutionDebug;
}

type DeclaredQueryScope =
  | 'artist_only'
  | 'artist_item'
  | 'artist_album'
  | 'artist_event'
  | 'artist_location'
  | 'artist_item_location'
  | 'direct_query'
  | 'unknown';

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
const SOCIAL_LISTING_NOISE_PATTERN =
  /\b(?:set|lot|bundle|sealed|official merch|merch(?:andise)?|shop|store|benefit|photocard|pob|pre\s*order|preorder|fanmade|replica|unofficial|listing|sale)\b/gi;

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

function stripBracketCharacters(value: string): string {
  return normalizeWhitespace(value.replace(/[\]{}()[]/g, ' '));
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
  return (
    getValidationEffectiveContext(request).searchArtist ??
    request.item.canonicalArtists[0]?.trim() ??
    ''
  );
}

export function getPrimaryAlbumPhrase(request: ValidationRunRequest): string {
  const effectiveContext = getValidationEffectiveContext(request);

  if (effectiveContext.sourceType === 'event') {
    const eventPhrase = sanitizeQueryCandidate(effectiveContext.searchEvent ?? '');
    if (eventPhrase && extractSemanticTokens(eventPhrase).length > 0) {
      return eventPhrase;
    }

    const itemPhrase = sanitizeQueryCandidate(effectiveContext.searchItem ?? '');
    if (itemPhrase && extractSemanticTokens(itemPhrase).length > 0) {
      return itemPhrase;
    }

    return sanitizeQueryCandidate(effectiveContext.searchLocation ?? '');
  }

  const relatedAlbum = sanitizeQueryCandidate(
    effectiveContext.searchAlbum ?? request.item.relatedAlbums[0]?.trim() ?? ''
  );
  if (relatedAlbum && extractSemanticTokens(relatedAlbum).length > 0) {
    return relatedAlbum;
  }

  const simplifiedTitle = simplifyItemTitle(effectiveContext.searchItem ?? request.item.name);
  const withoutArtist = stripArtistsFromText(simplifiedTitle, request.item.canonicalArtists);
  const cleanedWithoutArtist = sanitizeQueryCandidate(removeBracketedContent(withoutArtist));
  if (extractSemanticTokens(cleanedWithoutArtist).length > 0) {
    return cleanedWithoutArtist;
  }

  const cleanedTitle = sanitizeQueryCandidate(removeBracketedContent(simplifiedTitle));
  return extractSemanticTokens(cleanedTitle).length > 0 ? cleanedTitle : relatedAlbum;
}

export function getPrimarySocialAlbumPhrase(request: ValidationRunRequest): string {
  const effectiveContext = getValidationEffectiveContext(request);

  if (effectiveContext.sourceType === 'event') {
    const eventPhrase = buildConversationAlbumPhrase(
      buildCompactPhrase(
        effectiveContext.searchEvent ?? '',
        effectiveContext.searchItem ?? '',
        effectiveContext.searchLocation ?? ''
      )
    );

    if (extractSemanticTokens(eventPhrase).length > 0) {
      return eventPhrase;
    }
  }

  for (const relatedAlbum of request.item.relatedAlbums) {
    const sanitizedRelatedAlbum = sanitizeQueryCandidate(relatedAlbum?.trim() ?? '');
    if (!sanitizedRelatedAlbum) {
      continue;
    }

    const conversationAlbum = buildConversationAlbumPhrase(sanitizedRelatedAlbum);
    if (extractSemanticTokens(conversationAlbum).length > 0) {
      return conversationAlbum;
    }
  }

  return buildConversationAlbumPhrase(getPrimaryAlbumPhrase(request));
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

export function normalizeSocialSearchPhrase(value: string): string {
  return sanitizeQueryCandidate(
    stripBracketCharacters(simplifyItemTitle(value))
      .replace(/[“”"'`]+/g, ' ')
      .replace(/[&]+/g, ' and ')
      .replace(/[,:;/\\|]+/g, ' ')
      .replace(/[-–—]+/g, ' ')
      .replace(/[.!?]+/g, ' ')
      .replace(POB_LIKE_PATTERN, ' ')
      .replace(LISTING_NOISE_PATTERN, ' ')
      .replace(SOCIAL_CONVERSATION_NOISE_PATTERN, ' ')
      .replace(SOCIAL_LISTING_NOISE_PATTERN, ' ')
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
  const effectiveContext = getValidationEffectiveContext(request);

  if (effectiveContext.sourceType === 'event') {
    const eventDescriptors = [
      effectiveContext.searchItem,
      effectiveContext.searchLocation,
      options.includeValidationType ? request.validation.validationType : null,
    ]
      .map((value) => normalizeDescriptorPhrase(value ?? ''))
      .filter(Boolean)
      .filter((value) => !GENERIC_DESCRIPTOR_PATTERN.test(value.toLowerCase()));

    return dedupeQueries(eventDescriptors).slice(0, 3);
  }

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

function sanitizeQueryContextValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const sanitized = sanitizeQueryCandidate(value);
  return sanitized.length > 0 ? sanitized : null;
}

function isRejectedResolvedQuery(value: string | null): boolean {
  return value !== null && /^error\s*:/i.test(value);
}

export function getQueryContext(request: ValidationRunRequest): ValidationQueryContext | undefined {
  return request.validation.queryContext;
}

export function getResolvedSearchQuery(request: ValidationRunRequest): string | null {
  return sanitizeQueryContextValue(getQueryContext(request)?.resolvedSearchQuery);
}

function getUsableResolvedSearchQuery(request: ValidationRunRequest): string | null {
  const resolvedSearchQuery = getResolvedSearchQuery(request);

  return resolvedSearchQuery && !isRejectedResolvedQuery(resolvedSearchQuery)
    ? resolvedSearchQuery
    : null;
}

function getNormalizedQueryScope(request: ValidationRunRequest): string | null {
  return sanitizeQueryContextValue(getQueryContext(request)?.queryScope)?.toLowerCase() ?? null;
}

function resolveDeclaredQueryScope(request: ValidationRunRequest): DeclaredQueryScope {
  const normalizedQueryScope = getNormalizedQueryScope(request);

  if (!normalizedQueryScope) {
    return 'unknown';
  }

  if (normalizedQueryScope.includes('direct query')) {
    return 'direct_query';
  }

  const hasArtist = normalizedQueryScope.includes('artist');
  const hasItem = normalizedQueryScope.includes('item');
  const hasAlbum = normalizedQueryScope.includes('album');
  const hasEvent = normalizedQueryScope.includes('event');
  const hasLocation =
    normalizedQueryScope.includes('city') ||
    normalizedQueryScope.includes('country') ||
    normalizedQueryScope.includes('state') ||
    normalizedQueryScope.includes('province') ||
    normalizedQueryScope.includes('location');

  if (hasArtist && hasItem && hasLocation) {
    return 'artist_item_location';
  }

  if (hasArtist && hasLocation) {
    return 'artist_location';
  }

  if (hasArtist && hasEvent) {
    return 'artist_event';
  }

  if (hasArtist && hasAlbum) {
    return 'artist_album';
  }

  if (hasArtist && hasItem) {
    return 'artist_item';
  }

  if (normalizedQueryScope === 'artist only' || normalizedQueryScope === 'artist') {
    return 'artist_only';
  }

  return 'unknown';
}

function hasExclusiveDirectQueryOverride(request: ValidationRunRequest): boolean {
  const queryContext = getQueryContext(request);

  return (
    queryContext?.directQueryActive === true && getNormalizedQueryScope(request) === 'direct query'
  );
}

function finalizeLooseQueryPlan(candidates: ProviderQueryCandidate[]): ProviderQueryCandidate[] {
  return dedupeQueryPlan(candidates).filter((candidate) =>
    isValidConversationQuery(candidate.query)
  );
}

function buildArtistOnlyCommerceFallbackPlan(
  request: ValidationRunRequest
): ProviderQueryCandidate[] {
  return finalizeLooseQueryPlan([
    {
      family: 'artist_only_fallback',
      query: getPrimaryArtist(request),
    },
  ]);
}

function buildArtistOnlySocialFallbackPlan(
  request: ValidationRunRequest
): ProviderQueryCandidate[] {
  return finalizeLooseQueryPlan([
    {
      family: 'artist_only_fallback',
      query: normalizeSocialSearchPhrase(getPrimaryArtist(request)),
    },
  ]);
}

function constrainFallbackPlanForScope(
  request: ValidationRunRequest,
  fallbackPlan: ProviderQueryCandidate[],
  scopeSpecificFallbackPlan: ProviderQueryCandidate[]
): ProviderQueryCandidate[] {
  if (getUsableResolvedSearchQuery(request) === null) {
    return fallbackPlan;
  }

  switch (resolveDeclaredQueryScope(request)) {
    case 'artist_only':
      return scopeSpecificFallbackPlan;
    case 'artist_item':
    case 'artist_album':
    case 'unknown':
      return fallbackPlan;
    case 'artist_event':
    case 'artist_location':
    case 'artist_item_location':
    case 'direct_query':
      return [];
  }
}

export function buildProviderQueryResolutionDebug(
  request: ValidationRunRequest,
  queryContextUsed: boolean
): ProviderQueryResolutionDebug {
  const queryContext = getQueryContext(request);
  const resolvedSearchQuery = getResolvedSearchQuery(request);

  return {
    queryContextUsed,
    querySource: queryContextUsed ? 'resolved_query_context' : 'provider_fallback',
    resolvedSearchQuery,
    validationScope: sanitizeQueryContextValue(queryContext?.validationScope),
    queryScope: sanitizeQueryContextValue(queryContext?.queryScope),
  };
}

export function prependResolvedQueryCandidate(
  request: ValidationRunRequest,
  fallbackPlan: ProviderQueryCandidate[]
): ResolvedProviderQueryPlan {
  const usableResolvedQuery = getUsableResolvedSearchQuery(request);
  const queryPlan = usableResolvedQuery
    ? hasExclusiveDirectQueryOverride(request)
      ? [{ family: 'resolved_query_context', query: usableResolvedQuery }]
      : dedupeQueryPlan([
          { family: 'resolved_query_context', query: usableResolvedQuery },
          ...fallbackPlan,
        ])
    : fallbackPlan;

  return {
    queryPlan,
    queryResolution: buildProviderQueryResolutionDebug(request, usableResolvedQuery !== null),
  };
}

function isValidConversationQuery(candidate: string): boolean {
  const sanitized = sanitizeQueryCandidate(candidate);

  return sanitized.length >= 2 && /[\p{L}\p{N}]/u.test(sanitized);
}

function finalizeConversationQueryPlan(
  candidates: ProviderQueryCandidate[]
): ProviderQueryCandidate[] {
  return dedupeQueryPlan(candidates).filter((candidate) =>
    isValidConversationQuery(candidate.query)
  );
}

export function buildConversationAlbumPhrase(albumPhrase: string): string {
  const primarySegment = normalizeSocialSearchPhrase(albumPhrase.split(',')[0] ?? albumPhrase);

  if (extractSemanticTokens(primarySegment).length > 0) {
    return primarySegment;
  }

  return normalizeSocialSearchPhrase(albumPhrase);
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
  const effectiveContext = getValidationEffectiveContext(request);
  const primaryArtist = getPrimaryArtist(request);
  const albumPhrase = getPrimaryAlbumPhrase(request);
  const simplifiedTitle =
    effectiveContext.sourceType === 'event'
      ? sanitizeQueryCandidate(
          buildCompactPhrase(
            primaryArtist,
            effectiveContext.searchEvent ?? '',
            effectiveContext.searchItem ?? '',
            effectiveContext.searchLocation ?? ''
          )
        )
      : sanitizeQueryCandidate(removeBracketedContent(simplifyItemTitle(request.item.name)));
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

export function buildResolvedBrowseQueryPlan(
  request: ValidationRunRequest
): ResolvedProviderQueryPlan {
  return prependResolvedQueryCandidate(
    request,
    constrainFallbackPlanForScope(
      request,
      buildBrowseQueryPlan(request),
      buildArtistOnlyCommerceFallbackPlan(request)
    )
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

export function buildResolvedSoldQueryPlan(
  request: ValidationRunRequest
): ResolvedProviderQueryPlan {
  return prependResolvedQueryCandidate(
    request,
    constrainFallbackPlanForScope(
      request,
      buildSoldQueryPlan(request),
      buildArtistOnlyCommerceFallbackPlan(request)
    )
  );
}

export function buildSoldQueryCandidates(request: ValidationRunRequest): string[] {
  return buildSoldQueryPlan(request).map((candidate) => candidate.query);
}

export function buildTwitterQueryPlan(request: ValidationRunRequest): ProviderQueryCandidate[] {
  const { primaryArtist } = buildCorePhrases(request);
  const compactArtist = normalizeSocialSearchPhrase(primaryArtist);
  const compactAlbum = stripPrimaryArtist(
    getPrimarySocialAlbumPhrase(request),
    compactArtist || primaryArtist
  );
  const artistAlbum = buildCompactPhrase(compactArtist, compactAlbum);

  const candidates: ProviderQueryCandidate[] = compactAlbum
    ? [
        {
          family: 'artist_album_conversation',
          query: artistAlbum,
        },
        {
          family: 'quoted_artist_album',
          query: artistAlbum ? `"${artistAlbum}"` : '',
        },
      ]
    : [];

  candidates.push(
    { family: 'artist_only_fallback', query: compactArtist },
    { family: 'album_only_fallback', query: compactAlbum }
  );

  return finalizeConversationQueryPlan(candidates);
}

export function buildResolvedTwitterQueryPlan(
  request: ValidationRunRequest
): ResolvedProviderQueryPlan {
  return prependResolvedQueryCandidate(
    request,
    constrainFallbackPlanForScope(
      request,
      buildTwitterQueryPlan(request),
      buildArtistOnlySocialFallbackPlan(request)
    )
  );
}

export function buildTwitterQueryCandidates(request: ValidationRunRequest): string[] {
  return buildTwitterQueryPlan(request).map((candidate) => candidate.query);
}

export function buildYouTubeQueryPlan(request: ValidationRunRequest): ProviderQueryCandidate[] {
  const { primaryArtist } = buildCorePhrases(request);
  const compactArtist = normalizeSocialSearchPhrase(primaryArtist);
  const compactAlbum = stripPrimaryArtist(
    getPrimarySocialAlbumPhrase(request),
    compactArtist || primaryArtist
  );
  const artistAlbum = buildCompactPhrase(compactArtist, compactAlbum);

  return finalizeConversationQueryPlan(
    compactAlbum
      ? [
          { family: 'artist_album_media_core', query: artistAlbum },
          { family: 'artist_album_official', query: buildCompactPhrase(artistAlbum, 'official') },
          { family: 'artist_album_mv', query: buildCompactPhrase(artistAlbum, 'mv') },
          {
            family: 'artist_album_music_video',
            query: buildCompactPhrase(artistAlbum, 'music video'),
          },
          { family: 'artist_album_teaser', query: buildCompactPhrase(artistAlbum, 'teaser') },
        ]
      : [{ family: 'artist_only_media_fallback', query: compactArtist }]
  );
}

export function buildResolvedYouTubeQueryPlan(
  request: ValidationRunRequest
): ResolvedProviderQueryPlan {
  return prependResolvedQueryCandidate(
    request,
    constrainFallbackPlanForScope(
      request,
      buildYouTubeQueryPlan(request),
      buildArtistOnlySocialFallbackPlan(request)
    )
  );
}

export function buildYouTubeQueryCandidates(request: ValidationRunRequest): string[] {
  return buildYouTubeQueryPlan(request).map((candidate) => candidate.query);
}

export function buildRedditQueryPlan(request: ValidationRunRequest): ProviderQueryCandidate[] {
  const { primaryArtist } = buildCorePhrases(request);
  const compactAlbum = stripPrimaryArtist(
    getPrimarySocialAlbumPhrase(request),
    normalizeSocialSearchPhrase(primaryArtist) || primaryArtist
  );
  const artistAlbum = buildCompactPhrase(primaryArtist, compactAlbum);

  return finalizeQueryPlan(
    [
      { family: 'artist_album_discussion', query: artistAlbum },
      { family: 'album_artist_discussion', query: buildCompactPhrase(compactAlbum, primaryArtist) },
      {
        family: 'artist_album_comeback',
        query: buildCompactPhrase(primaryArtist, compactAlbum, 'discussion'),
      },
    ],
    primaryArtist,
    compactAlbum
  );
}

export function buildResolvedRedditQueryPlan(
  request: ValidationRunRequest
): ResolvedProviderQueryPlan {
  return prependResolvedQueryCandidate(
    request,
    constrainFallbackPlanForScope(
      request,
      buildRedditQueryPlan(request),
      buildArtistOnlySocialFallbackPlan(request)
    )
  );
}

export function buildRedditQueryCandidates(request: ValidationRunRequest): string[] {
  return buildRedditQueryPlan(request).map((candidate) => candidate.query);
}

export function buildValidationQueryCandidates(request: ValidationRunRequest): string[] {
  return buildSoldQueryCandidates(request);
}

export function buildResolvedValidationQueryPlan(
  request: ValidationRunRequest
): ResolvedProviderQueryPlan {
  return prependResolvedQueryCandidate(
    request,
    constrainFallbackPlanForScope(
      request,
      buildSoldQueryPlan(request),
      buildArtistOnlyCommerceFallbackPlan(request)
    )
  );
}
