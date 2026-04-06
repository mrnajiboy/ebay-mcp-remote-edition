import type {
  ValidationEffectiveContext,
  ValidationQueryContext,
  ValidationRunRequest,
} from './types.js';

function sanitizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildCompactText(...parts: (string | null | undefined)[]): string | null {
  const compact = parts
    .map((part) => sanitizeText(part))
    .filter((part): part is string => part !== null)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return compact.length > 0 ? compact : null;
}

function getQueryContext(request: ValidationRunRequest): ValidationQueryContext | undefined {
  return request.validation.queryContext;
}

function getFallbackArtist(request: ValidationRunRequest): string | null {
  return sanitizeText(request.item.canonicalArtists[0]);
}

function getFallbackAlbum(request: ValidationRunRequest): string | null {
  return sanitizeText(request.item.relatedAlbums[0]);
}

function getFallbackItem(request: ValidationRunRequest): string | null {
  return sanitizeText(request.item.name);
}

export function buildValidationEffectiveContext(
  request: ValidationRunRequest
): ValidationEffectiveContext {
  const queryContext = getQueryContext(request);
  const sourceType = request.sourceContext?.sourceType ?? 'item';
  const searchArtist =
    sanitizeText(queryContext?.resolvedSearchArtist) ?? getFallbackArtist(request);
  const searchAlbum = sanitizeText(getFallbackAlbum(request));
  const searchItem =
    sanitizeText(queryContext?.resolvedSearchItem) ??
    (sourceType === 'item' ? getFallbackItem(request) : null);
  const searchEvent = sanitizeText(queryContext?.resolvedSearchEvent);
  const searchLocation = sanitizeText(queryContext?.resolvedSearchLocation);
  const resolvedSearchQuery = sanitizeText(queryContext?.resolvedSearchQuery);
  const itemRecordId = sanitizeText(request.item.recordId);
  const eventRecordId = sanitizeText(request.sourceContext?.eventRecordId);
  const itemName = getFallbackItem(request);
  const hasItem =
    sourceType === 'item'
      ? (request.sourceContext?.hasItem ?? itemRecordId !== null) || itemName !== null
      : request.sourceContext?.hasItem === true || itemRecordId !== null;
  const hasEvent =
    sourceType === 'event'
      ? true
      : request.sourceContext?.hasEvent === true || searchEvent !== null || eventRecordId !== null;
  const effectiveSearchQuery =
    resolvedSearchQuery ??
    (sourceType === 'event'
      ? buildCompactText(searchArtist, searchEvent, searchItem, searchLocation)
      : buildCompactText(searchArtist, searchAlbum ?? searchItem, searchLocation));

  return {
    sourceType,
    mode: sourceType,
    validationScope: sanitizeText(queryContext?.validationScope),
    queryScope: sanitizeText(queryContext?.queryScope),
    directQueryActive: queryContext?.directQueryActive === true,
    resolvedSearchQuery,
    effectiveSearchQuery,
    searchArtist,
    searchAlbum,
    searchItem,
    searchEvent,
    searchLocation,
    hasItem,
    hasEvent,
    itemRecordId,
    eventRecordId,
    itemName,
    eventDate: sanitizeText(request.item.releaseDate),
    dDay: request.validation.dDay,
    requestTimestamp: request.timestamp,
  };
}

export function getValidationEffectiveContext(
  request: ValidationRunRequest
): ValidationEffectiveContext {
  return request.effectiveContext ?? buildValidationEffectiveContext(request);
}
