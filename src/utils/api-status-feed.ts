/**
 * Fetches and parses the eBay API Status RSS feed (public, no auth).
 * Used by the ebay_get_api_status MCP tool and optionally by the docs sync script.
 */

import { XMLParser } from 'fast-xml-parser';
import axios from 'axios';

const RSS_URL = 'https://developer.ebay.com/rss/api-status';

export interface ApiStatusItem {
  title: string;
  summary: string;
  link: string;
  api: string;
  site: string;
  status: string;
  lastUpdated: string;
}

interface RssItemRaw {
  title?: string;
  description?: string;
  link?: string;
  summary?: string;
  api?: string;
  site?: string;
  status?: string;
  lastUpdated?: string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return '';
}

function parseItem(raw: RssItemRaw): ApiStatusItem {
  const summary =
    normalizeString(raw.summary) ||
    stripHtml(normalizeString(raw.description)).slice(0, 300) ||
    '';
  return {
    title: normalizeString(raw.title) || 'Untitled',
    summary: summary || normalizeString(raw.title),
    link: normalizeString(raw.link) || '',
    api: normalizeString(raw.api) || '',
    site: normalizeString(raw.site) || '',
    status: normalizeString(raw.status) || '',
    lastUpdated: normalizeString(raw.lastUpdated) || '',
  };
}

function ensureArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

interface RssRoot {
  rss?: { channel?: { item?: RssItemRaw | RssItemRaw[] } };
}

export interface GetApiStatusFeedOptions {
  limit?: number;
  status?: 'Resolved' | 'Unresolved';
  api?: string;
}

/**
 * Fetches the eBay API Status RSS feed, parses it, and returns items
 * optionally filtered by status and API name, limited to `limit` items.
 */
export async function getApiStatusFeed(
  options: GetApiStatusFeedOptions = {}
): Promise<{ items: ApiStatusItem[]; error?: string }> {
  const { limit = 20, status: statusFilter, api: apiFilter } = options;

  try {
    const response = await axios.get(RSS_URL, {
      timeout: 15_000,
      responseType: 'text',
      headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
    });

    const xml = response.data as string;
    const parser = new XMLParser({
      ignoreAttributes: true,
      trimValues: true,
      parseTagValue: false,
    });
    const parsed = parser.parse(xml) as RssRoot;

    const channel = parsed?.rss?.channel;
    if (!channel) {
      return { items: [], error: 'RSS feed missing channel' };
    }

    const rawItems = ensureArray(channel.item);
    let items: ApiStatusItem[] = rawItems.map(parseItem);

    if (statusFilter) {
      items = items.filter(
        (i) => i.status.toLowerCase() === statusFilter.toLowerCase()
      );
    }
    if (apiFilter?.trim()) {
      const needle = apiFilter.trim().toLowerCase();
      items = items.filter((i) => i.api.toLowerCase().includes(needle));
    }

    items = items.slice(0, Math.min(limit, 50));

    return { items };
  } catch (err: unknown) {
    const message =
      axios.isAxiosError(err) && err.response?.status
        ? `Feed unavailable (HTTP ${err.response.status})`
        : err instanceof Error
          ? err.message
          : 'Failed to fetch API status feed';
    return { items: [], error: message };
  }
}
