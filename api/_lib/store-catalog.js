'use strict';

const CATALOG_VERSION = 'sticker-drop-8';

const inventoryItems = [
    {
        sku: 'sticker-4-inch:stay-classy',
        productId: 'sticker-4-inch',
        variantId: 'stay-classy',
        name: '4-Inch Stay Classy',
        shortName: 'Stay Classy',
        image: '/images/merchandise/stay-classy-4-inch.webp',
        inventoryKey: 'stock_4in_stay_classy',
    },
    {
        sku: 'sticker-2-inch:black-gold-holographic',
        productId: 'sticker-2-inch',
        variantId: 'black-gold-holographic',
        name: '2-Inch Black and Gold Holographic',
        shortName: 'Black and Gold',
        image: '/images/merchandise/chris-cerney-black-gold-holographic.webp',
        inventoryKey: 'stock_2in_black_gold',
    },
    {
        sku: 'sticker-2-inch:gold-holographic',
        productId: 'sticker-2-inch',
        variantId: 'gold-holographic',
        name: '2-Inch Gold Holographic',
        shortName: 'Gold',
        image: '/images/merchandise/chris-cerney-gold-holographic.webp',
        inventoryKey: 'stock_2in_gold',
    },
    {
        sku: 'sticker-2-inch:coastal-blue',
        productId: 'sticker-2-inch',
        variantId: 'coastal-blue',
        name: '2-Inch Coastal Blue',
        shortName: 'Coastal Blue',
        image: '/images/merchandise/chris-cerney-coastal-blue.webp',
        inventoryKey: 'stock_2in_coastal_blue',
    },
    {
        sku: 'sticker-2-inch:silver-holographic',
        productId: 'sticker-2-inch',
        variantId: 'silver-holographic',
        name: '2-Inch Silver Holographic',
        shortName: 'Silver',
        image: '/images/merchandise/chris-cerney-silver-holographic.webp',
        inventoryKey: 'stock_2in_silver',
    },
];

const bundle = {
    sku: 'independent-news-supporter-bundle:complete-five-sticker-set',
    productId: 'independent-news-supporter-bundle',
    variantId: 'complete-five-sticker-set',
    name: 'Independent News Supporter Bundle',
    image: '/images/merchandise/chris-cerney-black-gold-holographic.webp',
    components: Object.fromEntries(inventoryItems.map((item) => [item.sku, 1])),
};

const itemsBySku = new Map(inventoryItems.map((item) => [item.sku, item]));

module.exports = {
    CATALOG_VERSION,
    bundle,
    inventoryItems,
    itemsBySku,
};
