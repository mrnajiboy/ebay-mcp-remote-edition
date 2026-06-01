window._automatic_tracking_config = {
    clickRoles: ['button', 'link', 'tab', 'menuitem', 'option', 'combobox', 'menuitemcheckbox', 'menuitemradio'],
    sampledPages: {
        '2353552': 0.5,
        '2355842': 0.5,
        '2260255': 0.5,
        '2523511': 1,
        '2523510': 1
    },
    dynamicSelectors: '.x-btf-river .d-vi-region, .merch-module .merch-placements-container, [id^="placement"] .recs-module .merch-placements-container, .page-alerts, #placement_101912',
    dynamicSubtreeSelectors: {
        '[class*="x-rx-slot--"]': '.recs-placement-arrangement',
        '[class*="x-rx-slot-btf--"]': 'div[role="list"]',
        '.box-column.iframe-container': '.box-row.item-card-row'
    },
    clickRoles: ['button', 'link', 'tab', 'menuitem', 'option', 'combobox', 'menuitemcheckbox', 'menuitemradio'],
    dataClickPageIdWhiteList: ['4508568', '4507253', '2355842', '2353552', '2523510', '4492868', '4492867', '4492872', '4492870', '2566055', '2376473', '4536386', '2380676', '2374601', '4542154', '2380680', '4560505', '4517509', '4514735', '2491904'],
    dataPageViewPageIdWhiteList: ['4508568', '4507253', '2355842', '2353552', '2523510', '4492868', '4492867', '4492872', '4492870', '2566055', '2376473', '4536386', '2380676', '2374601', '4542154', '2380680', '4560505', '4517509', '4514735', '2491904'],
    customElements: {
        'default': [], // more configs can be added, key is page id string
        '3137842': ['div.play'],
        '3418065': ['div.str-header__banner.str-header__banner--large'], // background-image banner in MTab page, example “https://www.ebay.com/str/adidas” 
        '2489527': ['span.brm-pill__item-label, span.brm__flyout__btn-label, button.brm__all-filters.fake-link'], // for "Filter" module in MAG pages
        '3606739': ['li#gh-ti'], // doodle in sell pages on de & uk sites "https://www.ebay.de/sl/sell"
        '4517509': ['div.sc-review-button','a.campaign-container__ctaButton.fake-btn.fake-btn–primary', '.reco-carousel__item .todays-insights__card-container > div'], // panels on seller hub "https://www.ebay.com.au/sh/ads/dashboard"
        '2353552': ['div#redemptionCode-error'], // got error while applying coupon
        '2355842': ['div#redemptionCode-error'] // got error while applying coupon
    }
};
