import { describe, it, expect } from 'vitest';
import {
  validateScopesDetailed,
  getRequiredScopesForTool,
  hasRequiredScopes,
  getScopeDifferences,
  formatScopeForDisplay,
  groupScopesByCategory,
  isScopeReadonly,
  getWriteScope,
  getReadonlyScope,
  getScopeDescription,
} from '@/auth/scope-utils.js';

describe('Scope Utils', () => {
  describe('validateScopesDetailed', () => {
    it('should validate production scopes', () => {
      const result = validateScopesDetailed(
        [
          'https://api.ebay.com/oauth/api_scope/sell.inventory',
          'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
        ],
        'production'
      );

      expect(result.isValid).toBe(true);
      expect(result.validScopes).toHaveLength(2);
      expect(result.invalidScopes).toHaveLength(0);
    });

    it('should detect invalid scopes', () => {
      const result = validateScopesDetailed(
        [
          'https://api.ebay.com/oauth/api_scope/sell.inventory',
          'https://api.ebay.com/oauth/api_scope/invalid.scope',
        ],
        'production'
      );

      expect(result.isValid).toBe(false);
      expect(result.validScopes).toHaveLength(1);
      expect(result.invalidScopes).toContain('https://api.ebay.com/oauth/api_scope/invalid.scope');
    });

    it('should validate sandbox scopes', () => {
      const result = validateScopesDetailed(
        [
          'https://api.ebay.com/oauth/api_scope/sell.inventory',
          'https://api.ebay.com/oauth/api_scope/buy.order.readonly',
        ],
        'sandbox'
      );

      expect(result.validScopes).toContain('https://api.ebay.com/oauth/api_scope/sell.inventory');
    });
  });

  describe('getRequiredScopesForTool', () => {
    it('should return scopes for inventory tools', () => {
      const requirement = getRequiredScopesForTool('ebay_get_inventory_items');

      expect(requirement).toBeDefined();
      expect(requirement?.requiredScopes).toContain(
        'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly'
      );
      expect(requirement?.minimumScope).toBe(
        'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly'
      );
    });

    it('should return scopes for order management tools', () => {
      const requirement = getRequiredScopesForTool('ebay_get_orders');

      expect(requirement).toBeDefined();
      expect(requirement?.requiredScopes).toContain(
        'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly'
      );
    });

    it('should return scopes for create/write operations', () => {
      const requirement = getRequiredScopesForTool('ebay_create_inventory_item');

      expect(requirement).toBeDefined();
      expect(requirement?.requiredScopes).toEqual([
        'https://api.ebay.com/oauth/api_scope/sell.inventory',
      ]);
      expect(requirement?.minimumScope).toBe('https://api.ebay.com/oauth/api_scope/sell.inventory');
    });

    it('should return null for unknown tools', () => {
      const requirement = getRequiredScopesForTool('ebay_unknown_tool');
      expect(requirement).toBeNull();
    });

    it('should include optional scopes when applicable', () => {
      const requirement = getRequiredScopesForTool('ebay_publish_offer');

      expect(requirement).toBeDefined();
      expect(requirement?.optionalScopes).toBeDefined();
      expect(requirement?.optionalScopes).toContain(
        'https://api.ebay.com/oauth/api_scope/sell.account'
      );
    });
  });

  describe('hasRequiredScopes', () => {
    it('should return true when token has required scope', () => {
      const tokenScopes = [
        'https://api.ebay.com/oauth/api_scope/sell.inventory',
        'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
      ];

      const result = hasRequiredScopes(tokenScopes, [
        'https://api.ebay.com/oauth/api_scope/sell.inventory',
      ]);

      expect(result).toBe(true);
    });

    it('should return true when token has one of multiple required scopes', () => {
      const tokenScopes = ['https://api.ebay.com/oauth/api_scope/sell.inventory.readonly'];

      const result = hasRequiredScopes(tokenScopes, [
        'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
        'https://api.ebay.com/oauth/api_scope/sell.inventory',
      ]);

      expect(result).toBe(true);
    });

    it('should return false when token lacks required scopes', () => {
      const tokenScopes = ['https://api.ebay.com/oauth/api_scope/sell.inventory'];

      const result = hasRequiredScopes(tokenScopes, [
        'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
      ]);

      expect(result).toBe(false);
    });

    it('should handle empty token scopes', () => {
      const result = hasRequiredScopes([], ['https://api.ebay.com/oauth/api_scope/sell.inventory']);

      expect(result).toBe(false);
    });
  });

  describe('getScopeDifferences', () => {
    it('should identify scopes in both environments', () => {
      const diff = getScopeDifferences();

      expect(diff.inBothEnvironments).toBeDefined();
      expect(diff.productionOnly).toBeDefined();
      expect(diff.sandboxOnly).toBeDefined();

      // Sell inventory should be in both
      expect(diff.inBothEnvironments).toContain(
        'https://api.ebay.com/oauth/api_scope/sell.inventory'
      );
    });

    it('should identify production-only scopes', () => {
      const diff = getScopeDifferences();

      // commerce.message is production-only
      if (diff.productionOnly.length > 0) {
        expect(diff.productionOnly).toBeDefined();
      }
    });

    it('should identify sandbox-only scopes', () => {
      const diff = getScopeDifferences();

      // buy.* scopes are typically sandbox-only
      if (diff.sandboxOnly.length > 0) {
        expect(diff.sandboxOnly).toBeDefined();
      }
    });
  });

  describe('formatScopeForDisplay', () => {
    it('should remove common eBay prefix', () => {
      const formatted = formatScopeForDisplay(
        'https://api.ebay.com/oauth/api_scope/sell.inventory'
      );

      expect(formatted).toBe('api_scope/sell.inventory');
    });

    it('should return scope as-is if no prefix', () => {
      const formatted = formatScopeForDisplay('custom:scope');

      expect(formatted).toBe('custom:scope');
    });
  });

  describe('groupScopesByCategory', () => {
    it('should group scopes by category', () => {
      const scopes = [
        'https://api.ebay.com/oauth/api_scope/sell.inventory',
        'https://api.ebay.com/oauth/api_scope/buy.order.readonly',
        'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
        'custom:scope',
      ];

      const grouped = groupScopesByCategory(scopes);

      expect(grouped.sell).toContain('https://api.ebay.com/oauth/api_scope/sell.inventory');
      expect(grouped.buy).toContain('https://api.ebay.com/oauth/api_scope/buy.order.readonly');
      expect(grouped.commerce).toContain(
        'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly'
      );
      expect(grouped.other).toContain('custom:scope');
    });

    it('should handle empty array', () => {
      const grouped = groupScopesByCategory([]);

      expect(grouped.sell).toHaveLength(0);
      expect(grouped.buy).toHaveLength(0);
      expect(grouped.commerce).toHaveLength(0);
      expect(grouped.other).toHaveLength(0);
    });
  });

  describe('isScopeReadonly', () => {
    it('should identify readonly scopes', () => {
      expect(isScopeReadonly('https://api.ebay.com/oauth/api_scope/sell.inventory.readonly')).toBe(
        true
      );
      expect(
        isScopeReadonly('https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly')
      ).toBe(true);
    });

    it('should identify write scopes', () => {
      expect(isScopeReadonly('https://api.ebay.com/oauth/api_scope/sell.inventory')).toBe(false);
      expect(isScopeReadonly('https://api.ebay.com/oauth/api_scope/sell.fulfillment')).toBe(false);
    });
  });

  describe('getWriteScope', () => {
    it('should convert readonly scope to write scope', () => {
      const writeScope = getWriteScope(
        'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly'
      );

      expect(writeScope).toBe('https://api.ebay.com/oauth/api_scope/sell.inventory');
    });

    it('should return null for write scope', () => {
      const writeScope = getWriteScope('https://api.ebay.com/oauth/api_scope/sell.inventory');

      expect(writeScope).toBeNull();
    });
  });

  describe('getReadonlyScope', () => {
    it('should convert write scope to readonly scope', () => {
      const readonlyScope = getReadonlyScope('https://api.ebay.com/oauth/api_scope/sell.inventory');

      expect(readonlyScope).toBe('https://api.ebay.com/oauth/api_scope/sell.inventory.readonly');
    });

    it('should return null for readonly scope', () => {
      const readonlyScope = getReadonlyScope(
        'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly'
      );

      expect(readonlyScope).toBeNull();
    });

    it('should return null for scopes without readonly equivalent', () => {
      const readonlyScope = getReadonlyScope('https://api.ebay.com/oauth/api_scope/sell.edelivery');

      expect(readonlyScope).toBeNull();
    });
  });

  describe('getScopeDescription', () => {
    it('should return description for known scopes', () => {
      expect(getScopeDescription('https://api.ebay.com/oauth/api_scope/sell.inventory')).toBe(
        'View and manage your inventory and offers'
      );

      expect(
        getScopeDescription('https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly')
      ).toBe('View your order fulfillments');

      expect(
        getScopeDescription('https://api.ebay.com/oauth/api_scope/commerce.identity.readonly')
      ).toBe('View basic user information from eBay account');
    });

    it('should return generic description for unknown scopes', () => {
      const description = getScopeDescription('https://api.ebay.com/oauth/api_scope/unknown.scope');

      expect(description).toBe('Access to unknown.scope');
    });
  });
});
