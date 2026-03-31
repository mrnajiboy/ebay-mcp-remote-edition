import { z } from 'zod';

import type { ToolDefinition } from './definitions/index.js';

export const chatGptTools: ToolDefinition[] = [
  {
    name: 'search',
    description: 'Search for eBay inventory items',
    inputSchema: {
      query: z.string().describe('Search query'),
      limit: z.number().optional().describe('Maximum number of results'),
    },
    title: 'Search',
    outputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: { type: 'object' },
      },
    },
    annotations: {
      title: 'Search',
      readOnlyHint: true,
    },
    _meta: {
      category: 'chat',
      version: '1.0.0',
    },
  },
  {
    name: 'fetch',
    description: 'Fetch a specific eBay inventory item by SKU',
    inputSchema: {
      id: z.string().describe('Item SKU'),
    },
    title: 'Fetch',
    outputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: { type: 'object' },
      },
    },
    annotations: {
      title: 'Fetch',
      readOnlyHint: true,
    },
    _meta: {
      category: 'chat',
      version: '1.0.0',
    },
  },
];
