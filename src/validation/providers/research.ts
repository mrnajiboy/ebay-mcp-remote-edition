import type {
  PreviousComebackResearchSignals,
  ValidationRunRequest,
  ValidationSignalConfidence,
} from '../types.js';
import { getValidationEffectiveContext } from '../effective-context.js';

interface PerplexityChatCompletionResponse {
  choices?: {
    message?: {
      content?: string | null;
    };
  }[];
  citations?: string[];
}

interface ParsedHistoricalResearchResult {
  previousAlbumTitle?: string | null;
  previousComebackFirstWeekSales?: number | string | null;
  historicalContextNotes?: string | null;
  researchConfidence?: string | null;
  sourceSnippets?: string[];
  confidenceReason?: string | null;
  scoreReason?: string | null;
  commercialStrengthContext?: string | null;
  collectorDemandContext?: string | null;
  preorderDemandContext?: string | null;
  ambiguities?: string[];
  notEnoughEvidence?: boolean;
}

type ResearchSubtype = 'album' | 'pob' | 'preorder' | 'event' | 'general';

function sanitizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function uniqueStrings(values: (string | null | undefined)[], max = 6): string[] {
  const normalized = values
    .map((value) => sanitizeText(value))
    .filter((value): value is string => value !== null);

  return Array.from(new Set(normalized)).slice(0, max);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function detectResearchSubtype(request: ValidationRunRequest): ResearchSubtype {
  const effectiveContext = getValidationEffectiveContext(request);
  if (effectiveContext.sourceType === 'event') {
    return 'event';
  }

  const combined = [
    request.validation.validationType,
    request.validation.queryContext?.validationScope,
    request.validation.queryContext?.queryScope,
  ]
    .map((value) => sanitizeText(value)?.toLowerCase() ?? '')
    .join(' ');

  if (/\bpob\b|benefit|photocard/.test(combined)) {
    return 'pob';
  }

  if (/pre\s*order|preorder/.test(combined)) {
    return 'preorder';
  }

  if (combined.includes('album')) {
    return 'album';
  }

  return 'general';
}

function buildResearchQuery(request: ValidationRunRequest): string {
  const effectiveContext = getValidationEffectiveContext(request);
  const parts =
    effectiveContext.sourceType === 'event'
      ? [
          effectiveContext.searchArtist,
          effectiveContext.searchEvent,
          effectiveContext.searchItem,
          effectiveContext.searchLocation,
        ]
      : [effectiveContext.searchArtist, effectiveContext.searchAlbum, effectiveContext.searchItem];

  return uniqueStrings(parts, 8).join(' ');
}

function buildPromptFocus(subtype: ResearchSubtype): string[] {
  switch (subtype) {
    case 'pob':
      return [
        'identify the most likely previous comeback or prior comparable release',
        'look for collector, POB, or preorder demand commentary from the prior cycle',
        'note whether prior demand was strong enough to support current collector-focused monitoring',
      ];
    case 'preorder':
      return [
        'identify the most likely previous comeback or prior comparable release',
        'look for prior preorder momentum and collector demand signals',
        'summarize whether earlier release performance supports current preorder confidence',
      ];
    case 'event':
      return [
        'identify the closest prior comparable release or event context',
        'summarize prior demand continuity and historical commercial strength',
        'call out ambiguities so live market data can be weighted appropriately',
      ];
    case 'album':
      return [
        'identify the immediately previous comeback or album release',
        'find previous first-week sales where support exists',
        'summarize prior release momentum and demand continuity for album tracking',
      ];
    default:
      return [
        'identify the best prior comparable release if one exists',
        'summarize commercial strength and demand continuity',
        'flag ambiguity when evidence is weak or mixed',
      ];
  }
}

function buildPerplexityPrompt(request: ValidationRunRequest): {
  query: string;
  promptFocus: string[];
  userPrompt: string;
} {
  const effectiveContext = getValidationEffectiveContext(request);
  const subtype = detectResearchSubtype(request);
  const query = buildResearchQuery(request);
  const promptFocus = buildPromptFocus(subtype);
  const subjectLabel =
    effectiveContext.sourceType === 'event'
      ? (effectiveContext.searchEvent ?? effectiveContext.searchItem ?? 'event context')
      : (effectiveContext.searchAlbum ?? effectiveContext.searchItem ?? request.item.name);

  const userPrompt = [
    'Research the historical commercial context for the following release or validation target.',
    `Primary query: ${query || subjectLabel}`,
    `Artist: ${effectiveContext.searchArtist ?? 'Unknown'}`,
    `Subject: ${subjectLabel}`,
    `Release date: ${effectiveContext.eventDate ?? 'Unknown'}`,
    `Validation type: ${request.validation.validationType}`,
    `Subtype: ${subtype}`,
    `Focus requirements: ${promptFocus.join('; ')}`,
    'Return JSON only with this exact shape:',
    '{',
    '  "previousAlbumTitle": string | null,',
    '  "previousComebackFirstWeekSales": number | string | null,',
    '  "historicalContextNotes": string,',
    '  "researchConfidence": "Low" | "Medium" | "High",',
    '  "commercialStrengthContext": string | null,',
    '  "collectorDemandContext": string | null,',
    '  "preorderDemandContext": string | null,',
    '  "sourceSnippets": string[],',
    '  "ambiguities": string[],',
    '  "confidenceReason": string | null,',
    '  "scoreReason": string | null,',
    '  "notEnoughEvidence": boolean',
    '}',
    'Guidance:',
    '- Prefer factual prior-release context and first-week sales if supported.',
    '- For POB or preorder cases, emphasize prior collector/preorder demand momentum.',
    '- If evidence is uncertain, use nulls, concise ambiguity notes, and lower confidence.',
    '- Keep historicalContextNotes concise and operational for Airtable.',
  ].join('\n');

  return { query, promptFocus, userPrompt };
}

function extractFirstJsonObject(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const fencedMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;
  const firstBrace = candidate.indexOf('{');
  if (firstBrace === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = firstBrace; index < candidate.length; index += 1) {
    const character = candidate[index];
    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (character === '\\') {
        isEscaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return candidate.slice(firstBrace, index + 1);
      }
    }
  }

  return null;
}

function parseResearchResponse(rawContent: string): ParsedHistoricalResearchResult | null {
  const jsonObject = extractFirstJsonObject(rawContent);
  if (jsonObject === null) {
    return null;
  }

  try {
    return JSON.parse(jsonObject) as ParsedHistoricalResearchResult;
  } catch {
    return null;
  }
}

function parseNormalizedSalesValue(amount: string, unit?: string | null): number | null {
  const numericPortion = Number(amount);
  if (!Number.isFinite(numericPortion) || numericPortion <= 0) {
    return null;
  }

  const normalizedUnit = unit?.toLowerCase() ?? null;
  const multiplier =
    normalizedUnit === 'm' || normalizedUnit === 'million'
      ? 1_000_000
      : normalizedUnit === 'k' || normalizedUnit === 'thousand'
        ? 1_000
        : 1;

  return Math.round(numericPortion * multiplier);
}

function parseSalesFigure(value: number | string | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/,/g, '');
  if (normalized.length === 0) {
    return null;
  }

  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    return parseNormalizedSalesValue(normalized);
  }

  const directSalesLike =
    /^(?:~|about|approximately|approx\.?|around|over|under|nearly|more than|at least)?\s*(\d+(?:\.\d+)?)\s*(m|million|k|thousand)?\s*(copies|albums|units|sales|sold)?\s*$/i.exec(
      normalized
    );
  if (directSalesLike !== null && (directSalesLike[2] || directSalesLike[3])) {
    return parseNormalizedSalesValue(directSalesLike[1], directSalesLike[2]);
  }

  const numericTokens = Array.from(normalized.matchAll(/\d+(?:\.\d+)?/g)).length;
  if (numericTokens !== 1) {
    return null;
  }

  const contextualSalesLike =
    /(?:first[-\s]?week(?:\s+\w+){0,3}\s+sales|first[-\s]?week|sales|sold|copies|albums|units)[^\d]{0,24}(\d+(?:\.\d+)?)\s*(m|million|k|thousand)?\b/i.exec(
      normalized
    );
  if (contextualSalesLike === null) {
    return null;
  }

  return parseNormalizedSalesValue(contextualSalesLike[1], contextualSalesLike[2]);
}

function normalizeConfidence(
  value: string | null | undefined,
  hasSubstantiveEvidence: boolean
): ValidationSignalConfidence {
  if (!hasSubstantiveEvidence) {
    return 'Low';
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'high') {
      return 'High';
    }
    if (normalized === 'medium') {
      return 'Medium';
    }
    if (normalized === 'low') {
      return 'Low';
    }
  }

  return 'Medium';
}

function buildHistoricalNotes(
  parsed: ParsedHistoricalResearchResult,
  subtype: ResearchSubtype
): string {
  const explicitNotes = sanitizeText(parsed.historicalContextNotes);
  if (explicitNotes !== null) {
    return truncateText(explicitNotes, 320);
  }

  const parts = [
    sanitizeText(parsed.previousAlbumTitle)
      ? `Previous release identified as ${sanitizeText(parsed.previousAlbumTitle)}.`
      : null,
    parseSalesFigure(parsed.previousComebackFirstWeekSales)
      ? `Reported first-week sales were approximately ${parseSalesFigure(
          parsed.previousComebackFirstWeekSales
        )}.`
      : null,
    sanitizeText(parsed.commercialStrengthContext),
    subtype === 'pob' || subtype === 'preorder'
      ? (sanitizeText(parsed.preorderDemandContext) ?? sanitizeText(parsed.collectorDemandContext))
      : sanitizeText(parsed.collectorDemandContext),
    sanitizeText(parsed.ambiguities?.[0]),
  ];

  const joined = uniqueStrings(parts, 5).join(' ');
  return joined.length > 0
    ? truncateText(joined, 320)
    : 'Limited prior-market evidence found. Context weak; rely more on live market signals.';
}

function computeHistoricalContextScore(input: {
  confidence: ValidationSignalConfidence;
  previousAlbumTitle: string | null;
  previousComebackFirstWeekSales: number | null;
  demandContextPresent: boolean;
  snippetCount: number;
  notEnoughEvidence: boolean;
}): number {
  const hasSubstantiveEvidence =
    input.previousAlbumTitle !== null ||
    input.previousComebackFirstWeekSales !== null ||
    input.demandContextPresent;

  if (!hasSubstantiveEvidence) {
    return 0;
  }

  if (
    input.notEnoughEvidence &&
    input.previousAlbumTitle === null &&
    input.previousComebackFirstWeekSales === null &&
    !input.demandContextPresent
  ) {
    return 0;
  }

  let score = 0;
  if (input.previousAlbumTitle !== null) {
    score += 6;
  }
  if (input.previousComebackFirstWeekSales !== null) {
    score += 6;
  }
  if (input.demandContextPresent) {
    score += 4;
  }
  if (input.snippetCount >= 2) {
    score += 2;
  }
  if (input.snippetCount >= 3) {
    score += 2;
  }

  if (score === 0) {
    return 0;
  }

  if (input.confidence === 'High') {
    return clamp(Math.max(score, 15), 15, 20);
  }
  if (input.confidence === 'Medium') {
    return clamp(Math.max(score, 8), 8, 14);
  }
  return clamp(Math.max(score, 1), 1, 7);
}

function buildScoreAssignmentReason(input: {
  confidence: ValidationSignalConfidence;
  previousAlbumTitle: string | null;
  previousComebackFirstWeekSales: number | null;
  demandContextPresent: boolean;
  snippetCount: number;
  score: number;
  parsedScoreReason: string | null;
}): string {
  const factors = [
    input.previousAlbumTitle !== null ? 'resolved prior release' : null,
    input.previousComebackFirstWeekSales !== null ? 'supported first-week sales' : null,
    input.demandContextPresent ? 'collector/preorder demand context' : null,
    input.snippetCount > 0
      ? `${input.snippetCount} supporting snippet${input.snippetCount === 1 ? '' : 's'}`
      : null,
  ].filter((value): value is string => value !== null);

  const defaultReason =
    factors.length > 0
      ? `${input.confidence} confidence based on ${factors.join(', ')}; assigned normalized historical score ${input.score}.`
      : `No reliable historical evidence was normalized, so the historical score remained ${input.score}.`;

  const parsedReason = sanitizeText(input.parsedScoreReason);
  return parsedReason !== null ? truncateText(parsedReason, 240) : defaultReason;
}

function buildFallbackResearchSignals(input: {
  notes: string;
  confidence?: ValidationSignalConfidence;
  query?: string | null;
  promptFocus?: string[];
  providerStatus: 'unconfigured' | 'no_evidence' | 'error' | 'skipped';
  parseStatus: 'error' | 'unconfigured' | 'fallback' | 'skipped';
  rawResponseText?: string | null;
  errorMessage?: string | null;
}): PreviousComebackResearchSignals {
  const confidence = input.confidence ?? 'Low';
  const historicalContextNotes = truncateText(input.notes, 320);

  return {
    previousAlbumTitle: null,
    previousComebackFirstWeekSales: null,
    perplexityHistoricalContextScore: 0,
    historicalContextNotes,
    confidence,
    notes: historicalContextNotes,
    sources: [],
    debug: {
      providerStatus: input.providerStatus,
      parseStatus: input.parseStatus,
      query: input.query ?? null,
      promptFocus: input.promptFocus ?? [],
      citations: [],
      sourceSnippets: [],
      resolvedPriorRelease: null,
      extractedConfidence: null,
      computedConfidence: confidence,
      confidenceReason: null,
      scoreAssignmentReason:
        input.providerStatus === 'error'
          ? 'Historical research request failed, so the provider returned a zero historical score.'
          : 'Historical research did not yield structured evidence, so the provider returned a zero historical score.',
      rawResponseText: input.rawResponseText ?? null,
      errorMessage: input.errorMessage ?? null,
    },
  };
}

export async function getPreviousComebackResearchSignals(
  request: ValidationRunRequest
): Promise<PreviousComebackResearchSignals> {
  const hasPerplexityKey = (process.env.PERPLEXITY_API_KEY ?? '').trim().length > 0;
  const isPerplexityResearchEnabled =
    (process.env.PERPLEXITY_RESEARCH_ENABLED ?? '').trim().toLowerCase() === 'true';
  const effectiveContext = getValidationEffectiveContext(request);
  const primaryAlbum =
    effectiveContext.searchAlbum ?? effectiveContext.searchEvent ?? effectiveContext.searchItem;
  const { query, promptFocus, userPrompt } = buildPerplexityPrompt(request);

  if (request.providerOptions?.skipPerplexity === true) {
    return buildFallbackResearchSignals({
      notes:
        'Perplexity historical research skipped because the Airtable historical context fields are already filled.',
      providerStatus: 'skipped',
      parseStatus: 'skipped',
      query,
      promptFocus,
    });
  }

  if (!isPerplexityResearchEnabled) {
    return buildFallbackResearchSignals({
      notes:
        'Perplexity historical research disabled by default. Live market, Terapeak, and social signals remain active.',
      providerStatus: 'skipped',
      parseStatus: 'skipped',
      query,
      promptFocus,
    });
  }

  if (!hasPerplexityKey) {
    return buildFallbackResearchSignals({
      notes: `PERPLEXITY_API_KEY is not configured. Historical context for ${primaryAlbum ?? 'this release'} remains unverified; rely more on live market signals.`,
      providerStatus: 'unconfigured',
      parseStatus: 'unconfigured',
      query,
      promptFocus,
    });
  }

  if (query.length === 0) {
    return buildFallbackResearchSignals({
      notes: 'Historical research query could not be derived from the current validation context.',
      providerStatus: 'no_evidence',
      parseStatus: 'fallback',
      query: null,
      promptFocus,
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY ?? ''}`,
      },
      body: JSON.stringify({
        model: 'sonar',
        temperature: 0.1,
        max_tokens: 900,
        messages: [
          {
            role: 'system',
            content:
              'You are a historical music market research assistant. Use grounded web research, stay cautious with ambiguous evidence, and return JSON only.',
          },
          {
            role: 'user',
            content: userPrompt,
          },
        ],
      }),
      signal: controller.signal,
    });

    const responseText = await response.text();
    if (!response.ok) {
      return buildFallbackResearchSignals({
        notes: `Perplexity historical research request failed for ${primaryAlbum ?? 'this release'}.`,
        providerStatus: 'error',
        parseStatus: 'error',
        query,
        promptFocus,
        rawResponseText: responseText,
        errorMessage: `HTTP ${response.status}`,
      });
    }

    const parsedResponse = JSON.parse(responseText) as PerplexityChatCompletionResponse;
    const rawContent = parsedResponse.choices?.[0]?.message?.content?.trim() ?? '';
    const parsed = parseResearchResponse(rawContent);

    if (parsed === null) {
      return buildFallbackResearchSignals({
        notes: `Perplexity returned an unstructured historical response for ${primaryAlbum ?? 'this release'}, so live market signals should carry more weight.`,
        providerStatus: 'error',
        parseStatus: 'error',
        query,
        promptFocus,
        rawResponseText: rawContent,
        errorMessage: 'Unable to normalize Perplexity response into structured JSON.',
      });
    }

    const previousAlbumTitle = sanitizeText(parsed.previousAlbumTitle);
    const previousComebackFirstWeekSales = parseSalesFigure(parsed.previousComebackFirstWeekSales);
    const demandContextPresent =
      sanitizeText(parsed.commercialStrengthContext) !== null ||
      sanitizeText(parsed.collectorDemandContext) !== null ||
      sanitizeText(parsed.preorderDemandContext) !== null;
    const sourceSnippets = uniqueStrings(parsed.sourceSnippets ?? [], 4);
    const citations = uniqueStrings(parsedResponse.citations ?? [], 6);
    const hasSubstantiveEvidence =
      previousAlbumTitle !== null ||
      previousComebackFirstWeekSales !== null ||
      demandContextPresent;
    const confidence = normalizeConfidence(parsed.researchConfidence, hasSubstantiveEvidence);
    const score = computeHistoricalContextScore({
      confidence,
      previousAlbumTitle,
      previousComebackFirstWeekSales,
      demandContextPresent,
      snippetCount: sourceSnippets.length + Math.min(citations.length, 2),
      notEnoughEvidence: parsed.notEnoughEvidence === true,
    });
    const historicalContextNotes = buildHistoricalNotes(parsed, detectResearchSubtype(request));
    const scoreAssignmentReason = buildScoreAssignmentReason({
      confidence,
      previousAlbumTitle,
      previousComebackFirstWeekSales,
      demandContextPresent,
      snippetCount: sourceSnippets.length + citations.length,
      score,
      parsedScoreReason: sanitizeText(parsed.scoreReason),
    });

    return {
      previousAlbumTitle,
      previousComebackFirstWeekSales,
      perplexityHistoricalContextScore: score,
      historicalContextNotes,
      confidence,
      notes: historicalContextNotes,
      sources: citations,
      debug: {
        providerStatus: hasSubstantiveEvidence ? 'ok' : 'no_evidence',
        parseStatus: 'ok',
        query,
        promptFocus,
        citations,
        sourceSnippets,
        resolvedPriorRelease: previousAlbumTitle,
        extractedConfidence: sanitizeText(parsed.researchConfidence)
          ? normalizeConfidence(parsed.researchConfidence, hasSubstantiveEvidence)
          : null,
        computedConfidence: confidence,
        confidenceReason: sanitizeText(parsed.confidenceReason),
        scoreAssignmentReason,
        rawResponseText: rawContent,
        errorMessage: null,
      },
    };
  } catch (error) {
    return buildFallbackResearchSignals({
      notes: `Historical research lookup failed for ${primaryAlbum ?? 'this release'}. Context remains weak until live market data improves.`,
      providerStatus: 'error',
      parseStatus: 'error',
      query,
      promptFocus,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timeout);
  }
}
