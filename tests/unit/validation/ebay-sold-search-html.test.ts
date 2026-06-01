import { describe, expect, it } from 'vitest';

import {
  buildEbaySoldSearchUrl,
  collectCurrencyCodesFromSoldSearchHtml,
  parseEbaySoldSearchHtml,
} from '../../../src/validation/providers/ebay-sold-search-html.js';

describe('eBay sold-search HTML fallback', () => {
  it('builds the anonymous sold-search URL with the browser-observed request shape', () => {
    const url = new URL(buildEbaySoldSearchUrl('le sserafim keyring'));

    expect(url.origin + url.pathname).toBe('https://www.ebay.com/sch/i.html');
    expect(url.searchParams.get('_nkw')).toBe('le sserafim keyring');
    expect(url.search).toContain('_nkw=le+sserafim+keyring');
    expect(url.searchParams.get('_from')).toBe('R40');
    expect(url.searchParams.get('_oac')).toBe('1');
    expect(url.searchParams.get('LH_Complete')).toBe('1');
    expect(url.searchParams.get('LH_Sold')).toBe('1');
    expect(url.searchParams.get('rt')).toBe('nc');
    expect(url.searchParams.get('_fcid')).toBe('1');
    expect(url.searchParams.get('LH_PrefLoc')).toBe('2');
  });

  it('extracts sold rows only before the Results matching fewer words cutoff', () => {
    const html = `
      <html>
        <body>
          <h1 class="srp-controls__count-heading"><span class="BOLD">114</span> results for le sserafim keyring</h1>
          <div id="srp-river-results">
            <ul>
              <li class="s-item s-item__pl-on-bottom">
                <a class="s-item__link" href="https://www.ebay.com/itm/111?hash=abc">
                  <span role="heading" class="s-item__title">LE SSERAFIM Official Keyring</span>
                </a>
                <span class="s-item__price">$19.99</span>
                <span class="s-item__shipping">+$4.00 shipping</span>
                <span class="POSITIVE">Sold Jun 1, 2026</span>
              </li>
              <li class="s-item s-item__pl-on-bottom">
                <a class="s-item__link" href="https://www.ebay.com/itm/222?hash=def">
                  <span class="s-item__title">LE SSERAFIM CRAZY Plush Key Ring</span>
                </a>
                <span class="s-item__price">$26.50</span>
                <span class="s-item__shipping">Free shipping</span>
                <span>Sold May 29</span>
              </li>
              <li class="srp-river-answer srp-river-answer--REWRITE_START">
                <section><section>Results matching fewer words</section></section>
              </li>
              <li class="s-item s-item__pl-on-bottom">
                <a class="s-item__link" href="https://www.ebay.com/itm/333">
                  <span class="s-item__title">LE SSERAFIM photocard unrelated broader result</span>
                </a>
                <span class="s-item__price">$999.00</span>
                <span>Sold Jun 1, 2026</span>
              </li>
            </ul>
          </div>
        </body>
      </html>`;

    const parsed = parseEbaySoldSearchHtml(html, {
      requestTimestamp: '2026-06-01T12:00:00.000Z',
    });

    expect(parsed.cutoffDetected).toBe(true);
    expect(parsed.rawResultsCount).toBe(114);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map((item) => item.title)).toEqual([
      'LE SSERAFIM Official Keyring',
      'LE SSERAFIM CRAZY Plush Key Ring',
    ]);
    expect(parsed.items.map((item) => item.priceUsd)).toEqual([19.99, 26.5]);
    expect(parsed.items[0]?.itemUrl).toBe('https://www.ebay.com/itm/111');
    expect(parsed.items[0]?.soldAt).toBe('2026-06-01T00:00:00.000Z');
    expect(parsed.items[1]?.soldAt).toBe('2026-05-29T00:00:00.000Z');
  });

  it('parses current eBay s-card rows and converts non-USD prices when rates are available', () => {
    const html = `
      <main>
        <h1 class="srp-controls__count-heading">29 results for le sserafim keyring</h1>
        <div id="srp-river-results"><ul>
          <li class="s-card s-card--horizontal">
            <a class="s-card__link" href="https://www.ebay.com/itm/306934934961?hash=abc">
              <span class="s-card__title">LE SSERAFIM Seoul Concert Lucky Draw Acrylic Keyring EEunchae</span>
            </a>
            <span class="s-card__price">KRW55,529.99</span>
            <span class="s-card__caption">Sold Jun 1, 2026</span>
          </li>
          <li class="srp-river-answer srp-river-answer--REWRITE_START">
            <section><section>Results matching fewer words</section></section>
          </li>
          <li class="s-card s-card--horizontal">
            <a class="s-card__link" href="https://www.ebay.com/itm/999">
              <span class="s-card__title">New Jeans unrelated broader result</span>
            </a>
            <span class="s-card__price">$999.00</span>
            <span class="s-card__caption">Sold Jun 1, 2026</span>
          </li>
        </ul></div>
      </main>`;

    const parsed = parseEbaySoldSearchHtml(html, {
      requestTimestamp: '2026-06-01T12:00:00.000Z',
      currencyRatesToUsd: {
        KRW: 0.00073,
      },
    });

    expect(parsed.blockedReason).toBeNull();
    expect(parsed.cutoffDetected).toBe(true);
    expect(parsed.rawResultsCount).toBe(29);
    expect(parsed.items).toHaveLength(1);
    expect(collectCurrencyCodesFromSoldSearchHtml(html)).toEqual(['KRW']);
    expect(parsed.items[0]).toMatchObject({
      title: 'LE SSERAFIM Seoul Concert Lucky Draw Acrylic Keyring EEunchae',
      soldAt: '2026-06-01T00:00:00.000Z',
      priceUsd: 40.54,
      itemUrl: 'https://www.ebay.com/itm/306934934961',
    });
    expect(parsed.items.some((item) => /New Jeans/i.test(item.title))).toBe(false);
  });

  it('classifies eBay anti-bot and HTTP denial pages as blocked', () => {
    expect(
      parseEbaySoldSearchHtml('Pardon Our Interruption', {
        requestTimestamp: '2026-06-01T00:00:00.000Z',
      }).blockedReason
    ).toBe('ebay_pardon_interruption');
    expect(
      parseEbaySoldSearchHtml('<html><title>Access Denied</title></html>', {
        requestTimestamp: '2026-06-01T00:00:00.000Z',
      }).blockedReason
    ).toBe('access_denied');
  });
});
