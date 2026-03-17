import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MetadataApi } from '../../../src/api/listing-metadata/metadata.js';
import type { EbayApiClient } from '../../../src/api/client.js';

describe('MetadataApi', () => {
  let metadataApi: MetadataApi;
  let mockClient: EbayApiClient;

  beforeEach(() => {
    // Create mock client with spy methods
    mockClient = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as EbayApiClient;

    metadataApi = new MetadataApi(mockClient);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Marketplace Policy Methods', () => {
    describe('getAutomotivePartsCompatibilityPolicies', () => {
      it('should get automotive parts compatibility policies without filter', async () => {
        const mockResponse = {
          compatibilityPolicies: [{ policyId: '1', categoryId: '100' }],
        };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        const result = await metadataApi.getAutomotivePartsCompatibilityPolicies('EBAY_US');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_US/get_automotive_parts_compatibility_policies',
          {}
        );
        expect(result).toEqual(mockResponse);
      });

      it('should get automotive parts compatibility policies with filter', async () => {
        const mockResponse = { compatibilityPolicies: [] };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        await metadataApi.getAutomotivePartsCompatibilityPolicies('EBAY_US', 'categoryIds:{12345}');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_US/get_automotive_parts_compatibility_policies',
          { filter: 'categoryIds:{12345}' }
        );
      });

      it('should throw error when marketplaceId is missing', async () => {
        await expect(
          metadataApi.getAutomotivePartsCompatibilityPolicies('' as any)
        ).rejects.toThrow('marketplaceId is required and must be a string');
      });

      it('should throw error when marketplaceId is not a string', async () => {
        await expect(
          metadataApi.getAutomotivePartsCompatibilityPolicies(123 as any)
        ).rejects.toThrow('marketplaceId is required and must be a string');
      });

      it('should throw error when filter is not a string', async () => {
        await expect(
          metadataApi.getAutomotivePartsCompatibilityPolicies('EBAY_US', 123 as any)
        ).rejects.toThrow('filter must be a string when provided');
      });
    });

    describe('getCategoryPolicies', () => {
      it('should get category policies without filter', async () => {
        const mockResponse = {
          categoryPolicies: [{ categoryId: '1', policyIds: ['P1'] }],
        };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        const result = await metadataApi.getCategoryPolicies('EBAY_US');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_US/get_category_policies',
          {}
        );
        expect(result).toEqual(mockResponse);
      });

      it('should get category policies with filter', async () => {
        const mockResponse = { categoryPolicies: [] };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        await metadataApi.getCategoryPolicies('EBAY_US', 'categoryIds:{12345}');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_US/get_category_policies',
          { filter: 'categoryIds:{12345}' }
        );
      });

      it('should throw error when marketplaceId is missing', async () => {
        await expect(metadataApi.getCategoryPolicies('' as any)).rejects.toThrow(
          'marketplaceId is required and must be a string'
        );
      });
    });

    describe('getExtendedProducerResponsibilityPolicies', () => {
      it('should get EPR policies without filter', async () => {
        const mockResponse = {
          eprPolicies: [{ policyId: 'EPR1' }],
        };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        const result = await metadataApi.getExtendedProducerResponsibilityPolicies('EBAY_DE');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_DE/get_extended_producer_responsibility_policies',
          {}
        );
        expect(result).toEqual(mockResponse);
      });

      it('should get EPR policies with filter', async () => {
        const mockResponse = { eprPolicies: [] };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        await metadataApi.getExtendedProducerResponsibilityPolicies(
          'EBAY_DE',
          'categoryIds:{12345}'
        );

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_DE/get_extended_producer_responsibility_policies',
          { filter: 'categoryIds:{12345}' }
        );
      });
    });

    describe('getHazardousMaterialsLabels', () => {
      it('should get hazardous materials labels', async () => {
        const mockResponse = {
          labels: [{ labelId: 'HAZMAT1', description: 'Flammable' }],
        };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        const result = await metadataApi.getHazardousMaterialsLabels('EBAY_US');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_US/get_hazardous_materials_labels'
        );
        expect(result).toEqual(mockResponse);
      });

      it('should throw error when marketplaceId is missing', async () => {
        await expect(metadataApi.getHazardousMaterialsLabels('' as any)).rejects.toThrow(
          'marketplaceId is required and must be a string'
        );
      });
    });

    describe('getItemConditionPolicies', () => {
      it('should get item condition policies without filter', async () => {
        const mockResponse = {
          conditionPolicies: [{ policyId: 'COND1', conditions: ['NEW', 'USED'] }],
        };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        const result = await metadataApi.getItemConditionPolicies('EBAY_US');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_US/get_item_condition_policies',
          {}
        );
        expect(result).toEqual(mockResponse);
      });

      it('should get item condition policies with filter', async () => {
        const mockResponse = { conditionPolicies: [] };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        await metadataApi.getItemConditionPolicies('EBAY_US', 'categoryIds:{12345}');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_US/get_item_condition_policies',
          { filter: 'categoryIds:{12345}' }
        );
      });
    });

    describe('getListingStructurePolicies', () => {
      it('should get listing structure policies without filter', async () => {
        const mockResponse = {
          structurePolicies: [{ policyId: 'STRUCT1' }],
        };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        const result = await metadataApi.getListingStructurePolicies('EBAY_UK');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_UK/get_listing_structure_policies',
          {}
        );
        expect(result).toEqual(mockResponse);
      });
    });

    describe('getNegotiatedPricePolicies', () => {
      it('should get negotiated price policies without filter', async () => {
        const mockResponse = {
          pricePolicies: [{ policyId: 'PRICE1' }],
        };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        const result = await metadataApi.getNegotiatedPricePolicies('EBAY_US');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_US/get_negotiated_price_policies',
          {}
        );
        expect(result).toEqual(mockResponse);
      });
    });

    describe('getProductSafetyLabels', () => {
      it('should get product safety labels', async () => {
        const mockResponse = {
          labels: [{ labelId: 'SAFETY1', description: 'CE Mark' }],
        };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        const result = await metadataApi.getProductSafetyLabels('EBAY_DE');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_DE/get_product_safety_labels'
        );
        expect(result).toEqual(mockResponse);
      });
    });

    describe('getRegulatoryPolicies', () => {
      it('should get regulatory policies without filter', async () => {
        const mockResponse = {
          regulatoryPolicies: [{ policyId: 'REG1' }],
        };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        const result = await metadataApi.getRegulatoryPolicies('EBAY_US');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_US/get_regulatory_policies',
          {}
        );
        expect(result).toEqual(mockResponse);
      });
    });

    describe('getReturnPolicies', () => {
      it('should get return policies without filter', async () => {
        const mockResponse = {
          returnPolicies: [{ policyId: 'RET1' }],
        };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        const result = await metadataApi.getReturnPolicies('EBAY_US');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_US/get_return_policies',
          {}
        );
        expect(result).toEqual(mockResponse);
      });
    });

    describe('getShippingCostTypePolicies', () => {
      it('should get shipping cost type policies without filter', async () => {
        const mockResponse = {
          shippingPolicies: [{ policyId: 'SHIP1' }],
        };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        const result = await metadataApi.getShippingCostTypePolicies('EBAY_US');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_US/get_shipping_cost_type_policies',
          {}
        );
        expect(result).toEqual(mockResponse);
      });
    });

    describe('getClassifiedAdPolicies', () => {
      it('should get classified ad policies without filter', async () => {
        const mockResponse = {
          classifiedPolicies: [{ policyId: 'CLASS1' }],
        };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        const result = await metadataApi.getClassifiedAdPolicies('EBAY_MOTORS');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_MOTORS/get_classified_ad_policies',
          {}
        );
        expect(result).toEqual(mockResponse);
      });
    });

    describe('getCurrencies', () => {
      it('should get currencies for marketplace', async () => {
        const mockResponse = {
          currencies: [
            { currency: 'USD', description: 'US Dollar' },
            { currency: 'CAD', description: 'Canadian Dollar' },
          ],
        };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        const result = await metadataApi.getCurrencies('EBAY_US');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_US/get_currencies'
        );
        expect(result).toEqual(mockResponse);
      });
    });

    describe('getListingTypePolicies', () => {
      it('should get listing type policies without filter', async () => {
        const mockResponse = {
          listingTypePolicies: [{ policyId: 'TYPE1' }],
        };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        const result = await metadataApi.getListingTypePolicies('EBAY_US');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_US/get_listing_type_policies',
          {}
        );
        expect(result).toEqual(mockResponse);
      });
    });

    describe('getMotorsListingPolicies', () => {
      it('should get motors listing policies without filter', async () => {
        const mockResponse = {
          motorsPolicies: [{ policyId: 'MOTORS1' }],
        };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        const result = await metadataApi.getMotorsListingPolicies('EBAY_MOTORS');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_MOTORS/get_motors_listing_policies',
          {}
        );
        expect(result).toEqual(mockResponse);
      });
    });

    describe('getShippingPolicies', () => {
      it('should get shipping policies without filter', async () => {
        const mockResponse = {
          shippingPolicies: [{ policyId: 'SHIP1' }],
        };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        const result = await metadataApi.getShippingPolicies('EBAY_US');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_US/get_shipping_policies',
          {}
        );
        expect(result).toEqual(mockResponse);
      });
    });

    describe('getSiteVisibilityPolicies', () => {
      it('should get site visibility policies without filter', async () => {
        const mockResponse = {
          visibilityPolicies: [{ policyId: 'VIS1' }],
        };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        const result = await metadataApi.getSiteVisibilityPolicies('EBAY_US');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/marketplace/EBAY_US/get_site_visibility_policies',
          {}
        );
        expect(result).toEqual(mockResponse);
      });
    });
  });

  describe('Compatibility Methods', () => {
    describe('getCompatibilitiesBySpecification', () => {
      it('should get compatibilities by specification', async () => {
        const specification = {
          compatibilityProperties: [
            { name: 'Make', value: 'Toyota' },
            { name: 'Model', value: 'Camry' },
          ],
        };

        const mockResponse = {
          compatibilities: [{ productFamilyId: '12345', productId: '67890' }],
        };

        vi.spyOn(mockClient, 'post').mockResolvedValue(mockResponse);

        const result = await metadataApi.getCompatibilitiesBySpecification(specification);

        expect(mockClient.post).toHaveBeenCalledWith(
          '/sell/metadata/v1/compatibilities/get_compatibilities_by_specification',
          specification
        );
        expect(result).toEqual(mockResponse);
      });

      it('should throw error when specification is missing', async () => {
        await expect(metadataApi.getCompatibilitiesBySpecification(null as any)).rejects.toThrow(
          'specification is required and must be an object'
        );
      });

      it('should throw error when specification is not an object', async () => {
        await expect(
          metadataApi.getCompatibilitiesBySpecification('invalid' as any)
        ).rejects.toThrow('specification is required and must be an object');
      });
    });

    describe('getCompatibilityPropertyNames', () => {
      it('should get compatibility property names', async () => {
        const data = {
          categoryTreeId: '0',
          categoryId: '6016',
        };

        const mockResponse = {
          names: ['Make', 'Model', 'Year'],
        };

        vi.spyOn(mockClient, 'post').mockResolvedValue(mockResponse);

        const result = await metadataApi.getCompatibilityPropertyNames(data);

        expect(mockClient.post).toHaveBeenCalledWith(
          '/sell/metadata/v1/compatibilities/get_compatibility_property_names',
          data
        );
        expect(result).toEqual(mockResponse);
      });

      it('should throw error when data is missing', async () => {
        await expect(metadataApi.getCompatibilityPropertyNames(null as any)).rejects.toThrow(
          'data is required and must be an object'
        );
      });
    });

    describe('getCompatibilityPropertyValues', () => {
      it('should get compatibility property values', async () => {
        const data = {
          categoryTreeId: '0',
          categoryId: '6016',
          compatibilityProperty: 'Make',
        };

        const mockResponse = {
          values: ['Toyota', 'Honda', 'Ford'],
        };

        vi.spyOn(mockClient, 'post').mockResolvedValue(mockResponse);

        const result = await metadataApi.getCompatibilityPropertyValues(data);

        expect(mockClient.post).toHaveBeenCalledWith(
          '/sell/metadata/v1/compatibilities/get_compatibility_property_values',
          data
        );
        expect(result).toEqual(mockResponse);
      });
    });

    describe('getMultiCompatibilityPropertyValues', () => {
      it('should get multi compatibility property values', async () => {
        const data = {
          categoryTreeId: '0',
          categoryId: '6016',
          compatibilityProperties: [{ name: 'Make', value: 'Toyota' }],
        };

        const mockResponse = {
          propertyValues: [{ propertyName: 'Model', values: ['Camry', 'Corolla'] }],
        };

        vi.spyOn(mockClient, 'post').mockResolvedValue(mockResponse);

        const result = await metadataApi.getMultiCompatibilityPropertyValues(data);

        expect(mockClient.post).toHaveBeenCalledWith(
          '/sell/metadata/v1/compatibilities/get_multi_compatibility_property_values',
          data
        );
        expect(result).toEqual(mockResponse);
      });
    });

    describe('getProductCompatibilities', () => {
      it('should get product compatibilities', async () => {
        const data = {
          categoryTreeId: '0',
          epid: '12345',
        };

        const mockResponse = {
          compatibilities: [
            {
              compatibilityProperties: [
                { name: 'Make', value: 'Toyota' },
                { name: 'Model', value: 'Camry' },
              ],
            },
          ],
        };

        vi.spyOn(mockClient, 'post').mockResolvedValue(mockResponse);

        const result = await metadataApi.getProductCompatibilities(data);

        expect(mockClient.post).toHaveBeenCalledWith(
          '/sell/metadata/v1/compatibilities/get_product_compatibilities',
          data
        );
        expect(result).toEqual(mockResponse);
      });
    });
  });

  describe('Tax Methods', () => {
    describe('getSalesTaxJurisdictions', () => {
      it('should get sales tax jurisdictions for country', async () => {
        const mockResponse = {
          salesTaxJurisdictions: [
            {
              salesTaxJurisdictionId: 'CA',
              salesTaxPercentage: '7.25',
            },
            {
              salesTaxJurisdictionId: 'NY',
              salesTaxPercentage: '4.00',
            },
          ],
        };

        vi.spyOn(mockClient, 'get').mockResolvedValue(mockResponse);

        const result = await metadataApi.getSalesTaxJurisdictions('US');

        expect(mockClient.get).toHaveBeenCalledWith(
          '/sell/metadata/v1/country/US/sales_tax_jurisdiction'
        );
        expect(result).toEqual(mockResponse);
      });

      it('should throw error when countryCode is missing', async () => {
        await expect(metadataApi.getSalesTaxJurisdictions('' as any)).rejects.toThrow(
          'countryCode is required and must be a string'
        );
      });

      it('should throw error when countryCode is not a string', async () => {
        await expect(metadataApi.getSalesTaxJurisdictions(123 as any)).rejects.toThrow(
          'countryCode is required and must be a string'
        );
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle HTTP errors from get requests', async () => {
      const error = new Error('Network error');
      vi.spyOn(mockClient, 'get').mockRejectedValue(error);

      await expect(metadataApi.getCategoryPolicies('EBAY_US')).rejects.toThrow(
        'Failed to get category policies: Network error'
      );
    });

    it('should handle HTTP errors from post requests', async () => {
      const error = new Error('Invalid data');
      vi.spyOn(mockClient, 'post').mockRejectedValue(error);

      await expect(metadataApi.getCompatibilitiesBySpecification({ test: 'data' })).rejects.toThrow(
        'Failed to get compatibilities by specification: Invalid data'
      );
    });

    it('should handle unknown errors', async () => {
      vi.spyOn(mockClient, 'get').mockRejectedValue('string error');

      await expect(metadataApi.getHazardousMaterialsLabels('EBAY_US')).rejects.toThrow(
        'Failed to get hazardous materials labels: Unknown error'
      );
    });
  });
});
