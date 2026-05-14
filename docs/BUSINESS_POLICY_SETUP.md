# eBay Business Policy Setup Guide

> **Purpose:** This guide walks you through creating the required eBay Business Policies (Fulfillment, Payment, Return) so that `ebay_create_offer` succeeds. Without these policies in place, offer creation will fail with policy-related errors.

---

## Overview

When using the eBay Sell API to create offers via `ebay_create_offer`, your eBay account must have active Business Policies. These policies define:

| Policy Type | Purpose | Required for `ebay_create_offer` |
|-------------|---------|----------------------------------|
| **Fulfillment** | Shipping/handling rules, delivery times, locations | Yes |
| **Payment** | Accepted payment methods, payment terms | Yes |
| **Return** | Return window, who pays return shipping, refund type | Yes |

eBay requires **all three** policies before you can create offers programmatically.

---

## Step 1: Create Business Policies via eBay Seller Hub

### Option A: Create via eBay Web UI (Recommended for First-Time Setup)

1. Go to [eBay Seller Hub](https://www.ebay.com/sellerhub)
2. Navigate to **Settings** > **Business Policies**
3. Create each policy type:

#### Fulfillment Policy

1. Click **Add policy** > **Fulfillment**
2. Fill in:
   - **Policy name:** e.g., "Standard Shipping"
   - **Handling time:** Number of business days before item ships (e.g., 1-3 days)
   - **Shipping service:** Select shipping carriers and services
   - **Shipping cost:** Flat rate, calculated, or free shipping
   - **Locations:** Domestic and international shipping destinations
3. Save the policy

#### Payment Policy

1. Click **Add policy** > **Payment**
2. Fill in:
   - **Policy name:** e.g., "Standard Payment"
   - **Payment methods:** Select accepted methods (PayPal, credit cards, etc.)
   - **Payment terms:** Immediate payment required, or allow later payment
3. Save the policy

#### Return Policy

1. Click **Add policy** > **Return**
2. Fill in:
   - **Policy name:** e.g., "30-Day Returns"
   - **Returns accepted:** Yes/No
   - **Return window:** 30, 60, or 90 days
   - **Return shipping paid by:** Seller or Buyer
   - **Refund type:** Money back or replacement
3. Save the policy

### Option B: Create via eBay Sell API

You can also create policies programmatically using the eBay Sell Account API.

#### Create Fulfillment Policy

```bash
curl -X POST "https://api.ebay.com/sell/fulfillment/v1/policy/fulfillment" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: reply=minimal" \
  -d '{
    "name": "Standard Shipping",
    "shippingSpeedPolicy": {
      "handlingTime": 1,
      "excludes": []
    },
    "shippingDiscountPolicy": {},
    "shippingOptions": [
      {
        "shippingServiceId": "1",
        "shippingType": "Flat",
        "shippingRate": {
          "value": "5.99",
          "currencyCode": "USD"
        },
        "shippingLocation": "90210",
        "shipToLocations": ["US"]
      }
    ]
  }'
```

#### Create Payment Policy

```bash
curl -X POST "https://api.ebay.com/sell/fulfillment/v1/policy/payment" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: reply=minimal" \
  -d '{
    "name": "Standard Payment",
    "paymentMethod": ["PAYPAL"],
    "autoConfirm": {
      "enabled": true,
      "delayTime": "P3D"
    }
  }'
```

#### Create Return Policy

```bash
curl -X POST "https://api.ebay.com/sell/fulfillment/v1/policy/return" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: reply=minimal" \
  -d '{
    "name": "30-Day Returns",
    "returnsAcceptedOption": "Yes",
    "returnsWithinOption": "Days30",
    "returnShippingServicePaidBy": "Seller",
    "refundOption": "MoneyBack",
    "notReturnedHandlingFee": {
      "value": "0.00",
      "currencyCode": "USD"
    },
    "description": "30-day money-back guarantee"
  }'
```

---

## Step 2: Retrieve Your Policy IDs

After creating your policies, you need the policy IDs to reference them in offers.

### Via eBay Seller Hub

1. Go to **Settings** > **Business Policies**
2. Click on each policy to view details
3. The policy ID is displayed in the policy details page

### Via API

```bash
# List fulfillment policies
curl "https://api.ebay.com/sell/fulfillment/v1/policy/fulfillment" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# List payment policies
curl "https://api.ebay.com/sell/fulfillment/v1/policy/payment" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# List return policies
curl "https://api.ebay.com/sell/fulfillment/v1/policy/return" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

Each response will include the `id` field for each policy.

---

## Step 3: Use Policy IDs with `ebay_create_offer`

Once you have your policy IDs, use them when creating offers:

```json
{
  "sku": "YOUR_ITEM_SKU",
  "marketplaceId": "EBAY_US",
  "format": "FixedPriceItem",
  "availableQuantity": 10,
  "categoryId": "15032",
  "listingPolicies": {
    "fulfillmentPolicyId": "YOUR_FULFILLMENT_POLICY_ID",
    "paymentPolicyId": "YOUR_PAYMENT_POLICY_ID",
    "returnPolicyId": "YOUR_RETURN_POLICY_ID"
  },
  "pricingSummary": {
    "price": {
      "value": "34.99",
      "currencyCode": "USD"
    }
  }
}
```

---

## Troubleshooting

### "Policy not found" Error

- Verify the policy ID is correct
- Ensure the policy is active (not archived)
- Check that the policy matches the marketplace you are selling on

### "Missing required policy" Error

- All three policies (fulfillment, payment, return) must be provided
- Ensure none of the policy IDs are empty strings

### "Policy not applicable" Error

- Fulfillment policies must match the shipping services you are using
- Payment policies must support the payment methods you intend to accept
- Return policies must comply with eBay category requirements

### Policy ID Format

Policy IDs are typically alphanumeric strings (e.g., `"A2B3C4D5E6F7"`). They are **not** numeric and are **case-sensitive**.

---

## Policy Best Practices

1. **Create generic policies first:** Start with broad policies that cover most of your items, then create specific ones as needed.
2. **Naming conventions:** Use descriptive names (e.g., "Express Shipping - 1 Day Handling" rather than "Policy 1").
3. **Match category requirements:** Some eBay categories have specific policy requirements (e.g., motors, real estate).
4. **International considerations:** If selling internationally, create separate fulfillment policies for domestic and international shipping.
5. **Keep policies updated:** Review and update policies regularly to reflect changes in your business operations.

---

## Related Resources

- [eBay Business Policies Help](https://www.ebay.com/help/selling/making-selling-easier/manage-business-policies?id=4339)
- [eBay Sell Fulfillment API v1 Documentation](https://developer.ebay.com/api-docs/sell/fulfillment/resources/)
- [eBay Seller Hub](https://www.ebay.com/sellerhub)

---

*Last updated: 2026-05-03*
