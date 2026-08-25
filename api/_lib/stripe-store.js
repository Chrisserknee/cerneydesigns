'use strict';

const { bundle, bundlesBySku, inventoryItems, itemsBySku } = require('./store-catalog');

const INVENTORY_MARKER = 'chris_cerney_store_inventory_v1';
const MAX_SESSION_PAGES = 20;
const SALES_CACHE_MS = 60 * 1000;
const INVENTORY_CACHE_MS = 30 * 1000;

let salesCache = null;
let inventoryProductCache = null;

function stripeSecret() {
    return String(process.env.STRIPE_SECRET_KEY || '').trim();
}

async function stripeRequest(path, options = {}) {
    const secret = stripeSecret();
    if (!secret) throw new Error('Stripe is not configured');
    const response = await fetch(`https://api.stripe.com${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${secret}`,
            ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(12000),
    });
    const body = await response.json();
    if (!response.ok) {
        const error = new Error(`Stripe request failed with status ${response.status}`);
        error.status = response.status;
        error.code = body?.error?.code;
        throw error;
    }
    return body;
}

function emptyCounts() {
    return Object.fromEntries(inventoryItems.map((item) => [item.sku, 0]));
}

function parseItemSelections(value) {
    if (typeof value !== 'string' || !value.trim()) return [];
    const selections = [];
    for (const entry of value.split('|')) {
        const [productId, variantId, quantityText] = entry.split(':');
        const quantity = Number(quantityText);
        const sku = `${productId}:${variantId}`;
        if ((!itemsBySku.has(sku) && !bundlesBySku.has(sku)) || !Number.isInteger(quantity) || quantity < 1) continue;
        selections.push({ sku, quantity });
    }
    return selections;
}

function selectionFromLineItem(lineItem) {
    const text = `${lineItem?.description || ''} ${lineItem?.price?.product?.name || ''}`.toLowerCase();
    const quantity = Number.isInteger(lineItem?.quantity) && lineItem.quantity > 0 ? lineItem.quantity : 1;
    if (text.includes('independent news supporter bundle')) {
        const legacyBundle = Array.from(bundlesBySku.values()).find((candidate) => candidate !== bundle);
        const isLegacy = text.includes('all four') || text.includes('five-sticker') || text.includes('five sticker');
        return { sku: isLegacy && legacyBundle ? legacyBundle.sku : bundle.sku, quantity };
    }
    if (text.includes('4-inch stay classy') || text.includes('4 inch stay classy')) {
        return { sku: 'sticker-4-inch:stay-classy', quantity };
    }
    if (!text.includes('2-inch chris cerney') && !text.includes('2 inch chris cerney')) return null;
    if (text.includes('black and gold')) return { sku: 'sticker-2-inch:black-gold-holographic', quantity };
    if (text.includes('coastal blue')) return { sku: 'sticker-2-inch:coastal-blue', quantity };
    if (text.includes('silver')) return { sku: 'sticker-2-inch:silver-holographic', quantity };
    if (text.includes('gold')) return { sku: 'sticker-2-inch:gold-holographic', quantity };
    return { sku: 'legacy:2-inch-unspecified', quantity };
}

async function selectionsForSession(session) {
    const metadataSelections = parseItemSelections(session?.metadata?.item_selections);
    if (metadataSelections.length) return metadataSelections;
    if (!/^cs_(?:live|test)_[A-Za-z0-9]+$/.test(session?.id || '')) return [];
    const lineItems = await stripeRequest(`/v1/checkout/sessions/${encodeURIComponent(session.id)}/line_items?limit=100&expand[]=data.price.product`);
    return (lineItems.data || []).map(selectionFromLineItem).filter(Boolean);
}

async function listPaidSessions() {
    const sessions = [];
    let startingAfter = '';
    for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
        const query = new URLSearchParams({ limit: '100', status: 'complete' });
        query.append('expand[]', 'data.payment_intent.latest_charge.balance_transaction');
        if (startingAfter) query.set('starting_after', startingAfter);
        const result = await stripeRequest(`/v1/checkout/sessions?${query}`);
        const paid = (result.data || []).filter((session) => session.mode === 'payment' && session.payment_status === 'paid');
        sessions.push(...paid);
        if (!result.has_more || !result.data?.length) break;
        startingAfter = result.data[result.data.length - 1].id;
    }
    return sessions;
}

function moneyFromSession(session) {
    const charge = session?.payment_intent?.latest_charge;
    const balance = charge?.balance_transaction;
    return {
        total: Number(session.amount_total || 0),
        subtotal: Number(session.amount_subtotal || 0),
        shipping: Number(session.shipping_cost?.amount_total || 0),
        refunded: Number(charge?.amount_refunded || 0),
        fee: Number(balance?.fee || 0),
        net: Number(balance?.net || 0),
    };
}

async function calculateSales() {
    const sessions = await listPaidSessions();
    const direct = emptyCounts();
    const bundleConsumption = emptyCounts();
    const totals = { orders: 0, bundleUnits: 0, legacyUnspecified: 0, total: 0, subtotal: 0, shipping: 0, refunded: 0, fee: 0, net: 0 };
    const recentOrders = [];

    for (const session of sessions) {
        const selections = await selectionsForSession(session);
        if (!selections.length) continue;
        totals.orders += 1;
        const money = moneyFromSession(session);
        Object.keys(money).forEach((key) => { totals[key] += money[key]; });
        const orderItems = [];

        for (const selection of selections) {
            const bundleDefinition = bundlesBySku.get(selection.sku);
            if (bundleDefinition) {
                totals.bundleUnits += selection.quantity;
                Object.entries(bundleDefinition.components).forEach(([sku, componentQuantity]) => {
                    bundleConsumption[sku] += selection.quantity * componentQuantity;
                });
                orderItems.push(`${bundleDefinition.name} x${selection.quantity}`);
            } else if (selection.sku === 'legacy:2-inch-unspecified') {
                totals.legacyUnspecified += selection.quantity;
                orderItems.push(`2-Inch Sticker (color unspecified) x${selection.quantity}`);
            } else if (itemsBySku.has(selection.sku)) {
                direct[selection.sku] += selection.quantity;
                orderItems.push(`${itemsBySku.get(selection.sku).shortName} x${selection.quantity}`);
            }
        }

        recentOrders.push({
            id: session.id,
            created: Number(session.created || 0),
            amount: money.total,
            refunded: money.refunded,
            items: orderItems,
        });
    }

    const items = inventoryItems.map((item) => ({
        ...item,
        directSold: direct[item.sku],
        bundleSold: bundleConsumption[item.sku],
        totalUsed: direct[item.sku] + bundleConsumption[item.sku],
    }));

    recentOrders.sort((a, b) => b.created - a.created);
    return {
        generatedAt: new Date().toISOString(),
        totals,
        items,
        recentOrders: recentOrders.slice(0, 20),
    };
}

async function getSales(options = {}) {
    const now = Date.now();
    if (!options.fresh && salesCache && now - salesCache.time < SALES_CACHE_MS) return salesCache.value;
    const value = await calculateSales();
    salesCache = { time: now, value };
    return value;
}

async function findInventoryProduct() {
    const now = Date.now();
    if (inventoryProductCache && now - inventoryProductCache.time < INVENTORY_CACHE_MS) return inventoryProductCache.value;
    let startingAfter = '';
    for (let page = 0; page < 5; page += 1) {
        const query = new URLSearchParams({ limit: '100' });
        if (startingAfter) query.set('starting_after', startingAfter);
        const result = await stripeRequest(`/v1/products?${query}`);
        const product = (result.data || []).find((candidate) => candidate.metadata?.inventory_control === INVENTORY_MARKER);
        if (product) {
            inventoryProductCache = { time: now, value: product };
            return product;
        }
        if (!result.has_more || !result.data?.length) break;
        startingAfter = result.data[result.data.length - 1].id;
    }
    inventoryProductCache = { time: now, value: null };
    return null;
}

function numberFromMetadata(metadata, key) {
    if (!Object.hasOwn(metadata || {}, key) || metadata[key] === '') return null;
    const value = Number(metadata[key]);
    return Number.isInteger(value) && value >= 0 ? value : null;
}

function inventoryFromProduct(product, sales) {
    const metadata = product?.metadata || {};
    const items = sales.items.map((item) => {
        const onHand = numberFromMetadata(metadata, item.inventoryKey);
        const baselineUsed = numberFromMetadata(metadata, `baseline_${item.inventoryKey}`);
        const salesSinceCount = baselineUsed === null ? 0 : Math.max(0, item.totalUsed - baselineUsed);
        const remaining = onHand === null ? null : Math.max(0, onHand - salesSinceCount);
        return {
            ...item,
            onHandAtLastCount: onHand,
            baselineUsed,
            salesSinceCount,
            remaining,
            tracked: onHand !== null,
        };
    });
    const trackedItems = items.filter((item) => item.tracked);
    const inventoryBySku = new Map(items.map((item) => [item.sku, item]));
    const bundleItems = Object.entries(bundle.components)
        .map(([sku, quantity]) => ({ item: inventoryBySku.get(sku), quantity }));
    const bundleRemaining = bundleItems.every(({ item }) => item?.tracked)
        ? Math.min(...bundleItems.map(({ item, quantity }) => Math.floor(item.remaining / quantity)))
        : null;
    return {
        tracking: trackedItems.length > 0,
        fullyTracked: trackedItems.length === items.length,
        updatedAt: metadata.inventory_updated_at || null,
        items,
        bundle: {
            ...bundle,
            sold: sales.totals.bundleUnits,
            remaining: bundleRemaining,
            tracked: bundleRemaining !== null,
        },
    };
}

async function getInventorySnapshot(options = {}) {
    const [sales, product] = await Promise.all([getSales(options), findInventoryProduct()]);
    return { sales, inventory: inventoryFromProduct(product, sales) };
}

async function createInventoryProduct() {
    const parameters = new URLSearchParams({
        name: 'Chris Cerney Store Inventory (Internal)',
        active: 'false',
        'metadata[inventory_control]': INVENTORY_MARKER,
    });
    return stripeRequest('/v1/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: parameters,
    });
}

async function saveInventoryCounts(counts) {
    const sales = await getSales({ fresh: true });
    let product = await findInventoryProduct();
    if (!product) product = await createInventoryProduct();
    const salesBySku = new Map(sales.items.map((item) => [item.sku, item.totalUsed]));
    const parameters = new URLSearchParams();
    parameters.set('metadata[inventory_control]', INVENTORY_MARKER);
    parameters.set('metadata[inventory_updated_at]', new Date().toISOString());
    inventoryItems.forEach((item) => {
        parameters.set(`metadata[${item.inventoryKey}]`, String(counts[item.sku]));
        parameters.set(`metadata[baseline_${item.inventoryKey}]`, String(salesBySku.get(item.sku) || 0));
    });
    product = await stripeRequest(`/v1/products/${encodeURIComponent(product.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: parameters,
    });
    inventoryProductCache = { time: Date.now(), value: product };
    return { sales, inventory: inventoryFromProduct(product, sales) };
}

function publicInventory(snapshot) {
    const variants = {};
    snapshot.inventory.items.forEach((item) => {
        variants[item.sku] = {
            tracked: item.tracked,
            remaining: item.remaining,
            available: !item.tracked || item.remaining > 0,
        };
    });
    return {
        tracking: snapshot.inventory.tracking,
        updatedAt: snapshot.inventory.updatedAt,
        variants,
        bundle: {
            tracked: snapshot.inventory.bundle.tracked,
            remaining: snapshot.inventory.bundle.remaining,
            available: !snapshot.inventory.bundle.tracked || snapshot.inventory.bundle.remaining > 0,
        },
    };
}

function validateInventoryCounts(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const counts = {};
    for (const item of inventoryItems) {
        const count = value[item.sku];
        if (!Number.isInteger(count) || count < 0 || count > 100000) return null;
        counts[item.sku] = count;
    }
    return counts;
}

function invalidateCaches() {
    salesCache = null;
    inventoryProductCache = null;
}

module.exports = {
    getInventorySnapshot,
    getSales,
    invalidateCaches,
    publicInventory,
    saveInventoryCounts,
    validateInventoryCounts,
};
