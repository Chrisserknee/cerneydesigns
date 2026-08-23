(() => {
    'use strict';

    const catalog = Array.isArray(window.MERCH_CATALOG) ? window.MERCH_CATALOG : [];
    const productsById = new Map(catalog.map((product) => [product.id, product]));
    const storageKey = 'chris-cerney-merch-cart-v2';

    function variantFor(product, variantId) {
        return product?.variants?.find((variant) => variant.id === variantId) || null;
    }

    function cartSelection(key) {
        const [productId, variantId] = key.split('::');
        const product = productsById.get(productId);
        const variant = variantFor(product, variantId);
        return product && variant ? { product, variant } : null;
    }

    function loadCart() {
        try {
            const saved = JSON.parse(localStorage.getItem(storageKey));
            if (!saved || typeof saved !== 'object') return new Map();
            return new Map(Object.entries(saved)
                .filter(([key, quantity]) => cartSelection(key) && Number.isInteger(quantity) && quantity > 0)
                .map(([key, quantity]) => [key, Math.min(quantity, 10)]));
        } catch {
            return new Map();
        }
    }

    const cart = loadCart();
    const productGrid = document.getElementById('productGrid');
    const catalogCount = document.getElementById('catalogCount');
    const cartItems = document.getElementById('cartItems');
    const cartEmpty = document.getElementById('cartEmpty');
    const cartPanel = document.querySelector('.cart-panel');
    const cartCount = document.getElementById('cartCount');
    const cartSubtotal = document.getElementById('cartSubtotal');
    const navCartButton = document.getElementById('navCartButton');
    const navCartCount = document.getElementById('navCartCount');
    const navCartTotal = document.getElementById('navCartTotal');
    const mobileCartButton = document.getElementById('mobileCartButton');
    const mobileCartCount = document.getElementById('mobileCartCount');
    const checkoutButton = document.getElementById('checkoutButton');
    const checkoutLabel = document.getElementById('checkoutLabel');
    const checkoutMessage = document.getElementById('checkoutMessage');
    const orderStatus = document.getElementById('orderStatus');
    const orderStatusClose = document.getElementById('orderStatusClose');
    const orderStatusContinue = document.getElementById('orderStatusContinue');
    const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

    function saveCart() {
        localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(cart)));
    }

    function isPurchasable(product) {
        return product.available === true && Number.isInteger(product.price) && product.price > 0;
    }

    function createShippingIcon() {
        const namespace = 'http://www.w3.org/2000/svg';
        const icon = document.createElementNS(namespace, 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('aria-hidden', 'true');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '1.8');
        icon.setAttribute('stroke-linecap', 'round');
        icon.setAttribute('stroke-linejoin', 'round');

        const body = document.createElementNS(namespace, 'path');
        body.setAttribute('d', 'M10 17h4V5H2v12h3');
        const trailer = document.createElementNS(namespace, 'path');
        trailer.setAttribute('d', 'M14 9h4l4 4v4h-2');
        const frontWheel = document.createElementNS(namespace, 'circle');
        frontWheel.setAttribute('cx', '7');
        frontWheel.setAttribute('cy', '17');
        frontWheel.setAttribute('r', '2');
        const backWheel = document.createElementNS(namespace, 'circle');
        backWheel.setAttribute('cx', '18');
        backWheel.setAttribute('cy', '17');
        backWheel.setAttribute('r', '2');
        icon.append(body, trailer, frontWheel, backWheel);
        return icon;
    }

    function createProductCard(product) {
        const selected = { variant: product.variants[0], mediaMode: 'variant' };
        const card = document.createElement('article');
        card.className = `product-card${product.featured ? ' bundle-product' : ''}`;

        const media = document.createElement('div');
        media.className = 'product-media';
        const image = new Image();
        image.src = selected.variant.image;
        image.alt = selected.variant.imageAlt;
        image.loading = 'lazy';
        let bundleImageGrid;
        if (Array.isArray(selected.variant.images)) {
            bundleImageGrid = document.createElement('div');
            bundleImageGrid.className = 'bundle-image-grid';
            media.appendChild(bundleImageGrid);
        } else {
            media.appendChild(image);
        }

        let designPhotoButton;
        let designPhotoThumbnail;
        let lifestylePhotoButton;

        if (product.lifestyleImage) {
            const gallery = document.createElement('div');
            gallery.className = 'product-gallery';
            gallery.setAttribute('role', 'group');
            gallery.setAttribute('aria-label', `${product.name} photos`);

            designPhotoButton = document.createElement('button');
            designPhotoButton.type = 'button';
            designPhotoButton.className = 'product-photo-button selected';
            designPhotoButton.setAttribute('aria-label', 'Show sticker design');
            designPhotoButton.setAttribute('aria-pressed', 'true');
            designPhotoButton.title = 'Sticker design';
            designPhotoThumbnail = new Image();
            designPhotoThumbnail.src = selected.variant.image;
            designPhotoThumbnail.alt = '';
            designPhotoButton.appendChild(designPhotoThumbnail);

            lifestylePhotoButton = document.createElement('button');
            lifestylePhotoButton.type = 'button';
            lifestylePhotoButton.className = 'product-photo-button';
            lifestylePhotoButton.setAttribute('aria-label', 'Show sticker held in hand for scale');
            lifestylePhotoButton.setAttribute('aria-pressed', 'false');
            lifestylePhotoButton.title = 'In hand';
            const lifestyleThumbnail = new Image();
            lifestyleThumbnail.src = product.lifestyleImage;
            lifestyleThumbnail.alt = '';
            lifestylePhotoButton.appendChild(lifestyleThumbnail);

            gallery.append(designPhotoButton, lifestylePhotoButton);
            media.appendChild(gallery);
        }

        const body = document.createElement('div');
        body.className = 'product-body';
        const status = document.createElement('span');
        status.className = `product-status${isPurchasable(product) ? ' available' : ''}`;
        status.textContent = isPurchasable(product) ? 'Available' : 'Checkout setup';
        const title = document.createElement('h3');
        title.textContent = product.name;
        const description = document.createElement('p');
        description.textContent = product.description;

        let bundleSummary;
        if (Array.isArray(product.bundleSummary)) {
            bundleSummary = document.createElement('div');
            bundleSummary.className = 'bundle-summary';
            bundleSummary.setAttribute('aria-label', 'Bundle contents');
            product.bundleSummary.forEach((item) => {
                const summaryItem = document.createElement('span');
                const count = document.createElement('strong');
                count.textContent = item.count;
                const label = document.createElement('span');
                label.textContent = item.label;
                summaryItem.append(count, label);
                bundleSummary.appendChild(summaryItem);
            });
        }

        const optionArea = document.createElement('div');
        optionArea.className = 'product-options';
        const optionHeading = document.createElement('div');
        optionHeading.className = 'option-heading';
        const optionLabel = document.createElement('span');
        optionLabel.textContent = product.optionLabel || (product.variants.length > 1 ? 'Choose a finish' : 'Design');
        const optionName = document.createElement('strong');
        optionName.textContent = selected.variant.name;
        optionHeading.append(optionLabel, optionName);

        const controls = document.createElement('div');
        controls.className = 'product-controls';
        let referenceButton;

        const updateMedia = () => {
            const showingReference = selected.mediaMode === 'reference';
            const showingLifestyle = selected.mediaMode === 'lifestyle';

            if (bundleImageGrid) {
                bundleImageGrid.replaceChildren(...selected.variant.images.map((source, index) => {
                    const bundleImage = new Image();
                    bundleImage.src = source;
                    bundleImage.alt = index === selected.variant.images.length - 1
                        ? 'Four-inch Stay Classy sticker included in the bundle'
                        : `Two-inch sticker option ${index + 1} included in the bundle`;
                    bundleImage.loading = 'lazy';
                    return bundleImage;
                }));
            } else if (showingReference) {
                image.src = product.sizeReference;
                image.alt = product.sizeReferenceAlt;
            } else if (showingLifestyle) {
                image.src = product.lifestyleImage;
                image.alt = product.lifestyleImageAlt;
            } else {
                image.src = selected.variant.image;
                image.alt = selected.variant.imageAlt;
            }

            media.classList.toggle('showing-reference', showingReference);
            media.classList.toggle('showing-lifestyle', showingLifestyle);
            referenceButton?.classList.toggle('active', showingReference);
            if (referenceButton) {
                referenceButton.textContent = showingReference ? 'Back to design' : 'Size reference';
            }
            designPhotoButton?.classList.toggle('selected', !showingLifestyle && !showingReference);
            designPhotoButton?.setAttribute('aria-pressed', !showingLifestyle && !showingReference ? 'true' : 'false');
            lifestylePhotoButton?.classList.toggle('selected', showingLifestyle);
            lifestylePhotoButton?.setAttribute('aria-pressed', showingLifestyle ? 'true' : 'false');
        };

        designPhotoButton?.addEventListener('click', () => {
            selected.mediaMode = 'variant';
            updateMedia();
        });

        lifestylePhotoButton?.addEventListener('click', () => {
            selected.mediaMode = 'lifestyle';
            updateMedia();
        });

        if (product.variants.length > 1) {
            const variantList = document.createElement('div');
            variantList.className = 'variant-list';
            variantList.setAttribute('role', 'group');
            variantList.setAttribute('aria-label', `${product.name} finish`);

            product.variants.forEach((variant, index) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `variant-button${index === 0 ? ' selected' : ''}`;
                button.setAttribute('aria-label', variant.name);
                button.setAttribute('aria-pressed', index === 0 ? 'true' : 'false');
                button.title = variant.name;
                const thumbnailSources = Array.isArray(variant.images) ? variant.images.slice(0, 3) : [variant.image];
                if (thumbnailSources.length > 1) button.classList.add('bundle-variant-button');
                button.append(...thumbnailSources.map((source) => {
                    const thumbnail = new Image();
                    thumbnail.src = source;
                    thumbnail.alt = '';
                    return thumbnail;
                }));
                button.addEventListener('click', () => {
                    selected.variant = variant;
                    selected.mediaMode = 'variant';
                    if (designPhotoThumbnail) designPhotoThumbnail.src = variant.image;
                    optionName.textContent = variant.name;
                    variantList.querySelectorAll('.variant-button').forEach((candidate) => {
                        const isSelected = candidate === button;
                        candidate.classList.toggle('selected', isSelected);
                        candidate.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
                    });
                    updateMedia();
                });
                variantList.appendChild(button);
            });
            controls.appendChild(variantList);
        }

        if (product.sizeReference) {
            referenceButton = document.createElement('button');
            referenceButton.type = 'button';
            referenceButton.className = 'reference-button';
            referenceButton.textContent = 'Size reference';
            referenceButton.addEventListener('click', () => {
                selected.mediaMode = selected.mediaMode === 'reference' ? 'variant' : 'reference';
                updateMedia();
            });
            controls.appendChild(referenceButton);
        }
        optionArea.append(optionHeading, controls);

        const actionRow = document.createElement('div');
        actionRow.className = 'product-action-row';
        const priceBlock = document.createElement('div');
        priceBlock.className = 'product-price-block';
        const price = document.createElement('strong');
        price.className = 'product-price';
        price.textContent = Number.isInteger(product.price) ? money.format(product.price / 100) : 'Price coming soon';
        const shipping = document.createElement('span');
        shipping.className = 'product-shipping';
        shipping.append(createShippingIcon(), document.createTextNode(`+ ${money.format(product.shipping / 100)} shipping`));
        priceBlock.append(price, shipping);
        const addButton = document.createElement('button');
        addButton.type = 'button';
        addButton.className = 'add-button';
        addButton.textContent = isPurchasable(product) ? 'Add to cart' : 'Checkout coming soon';
        addButton.disabled = !isPurchasable(product);
        addButton.addEventListener('click', () => {
            addToCart(product.id, selected.variant.id);
            addButton.textContent = 'Added';
            addButton.classList.add('added');
            window.setTimeout(() => {
                addButton.textContent = 'Add to cart';
                addButton.classList.remove('added');
            }, 1200);
        });
        actionRow.append(priceBlock, addButton);
        body.append(status, title, description);
        if (bundleSummary) body.append(bundleSummary);
        if (product.hideOptions !== true) body.append(optionArea);
        body.append(actionRow);
        card.append(media, body);
        updateMedia();
        return card;
    }

    function renderCatalog() {
        productGrid.replaceChildren(...catalog.map(createProductCard));
        catalogCount.textContent = `${catalog.length} product${catalog.length === 1 ? '' : 's'}`;
    }

    function addToCart(productId, variantId) {
        const product = productsById.get(productId);
        if (!product || !variantFor(product, variantId) || !isPurchasable(product)) return;
        const key = `${productId}::${variantId}`;
        cart.set(key, Math.min((cart.get(key) || 0) + 1, 10));
        saveCart();
        renderCart();
        [navCartButton, mobileCartButton].forEach((button) => button.classList.remove('attention'));
        window.requestAnimationFrame(() => {
            [navCartButton, mobileCartButton].forEach((button) => button.classList.add('attention'));
        });
    }

    function changeQuantity(key, change) {
        const quantity = (cart.get(key) || 0) + change;
        if (quantity <= 0) cart.delete(key);
        else cart.set(key, Math.min(quantity, 10));
        saveCart();
        renderCart();
    }

    function createQuantityButton(label, accessibleLabel, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'quantity-button';
        button.textContent = label;
        button.setAttribute('aria-label', accessibleLabel);
        button.addEventListener('click', onClick);
        return button;
    }

    function createCartItem([key, quantity]) {
        const { product, variant } = cartSelection(key);
        const item = document.createElement('div');
        item.className = 'cart-item';
        const overview = document.createElement('div');
        overview.className = 'cart-item-overview';
        const thumbnail = document.createElement('div');
        thumbnail.className = 'cart-item-thumbnail';
        if (Array.isArray(variant.images)) {
            thumbnail.classList.add('bundle-cart-thumbnail');
            thumbnail.setAttribute('role', 'img');
            thumbnail.setAttribute('aria-label', variant.imageAlt);
            variant.images.forEach((source) => {
                const bundleImage = new Image();
                bundleImage.src = source;
                bundleImage.alt = '';
                thumbnail.appendChild(bundleImage);
            });
        } else {
            const itemImage = new Image();
            itemImage.className = 'cart-item-image';
            itemImage.src = variant.image;
            itemImage.alt = variant.imageAlt;
            thumbnail.appendChild(itemImage);
        }
        const details = document.createElement('div');
        details.className = 'cart-item-details';
        const identity = document.createElement('div');
        identity.className = 'cart-item-identity';
        const name = document.createElement('strong');
        name.textContent = product.name;
        const variantName = document.createElement('small');
        variantName.textContent = variant.name;
        identity.append(name, variantName);
        const linePrice = document.createElement('span');
        linePrice.textContent = money.format((product.price * quantity) / 100);
        details.append(identity, linePrice);

        const controls = document.createElement('div');
        controls.className = 'quantity-controls';
        const decrease = createQuantityButton('\u2212', `Decrease ${variant.name} quantity`, () => changeQuantity(key, -1));
        const count = document.createElement('span');
        count.textContent = quantity;
        count.setAttribute('aria-label', `Quantity ${quantity}`);
        const increase = createQuantityButton('+', `Increase ${variant.name} quantity`, () => changeQuantity(key, 1));
        increase.disabled = quantity >= 10;
        const remove = createQuantityButton('\u2715', `Remove ${variant.name} from cart`, () => {
            cart.delete(key);
            saveCart();
            renderCart();
        });
        remove.title = `Remove ${variant.name}`;
        remove.classList.add('remove-button');
        controls.append(decrease, count, increase, remove);
        overview.append(thumbnail, details);
        item.append(overview, controls);
        return item;
    }

    function validCartEntries() {
        return Array.from(cart.entries()).filter(([key]) => {
            const selection = cartSelection(key);
            return selection && isPurchasable(selection.product);
        });
    }

    function renderCart() {
        const entries = validCartEntries();
        const itemCount = entries.reduce((sum, [, quantity]) => sum + quantity, 0);
        const subtotal = entries.reduce((sum, [key, quantity]) => sum + (cartSelection(key).product.price * quantity), 0);
        cartItems.replaceChildren(...entries.map(createCartItem));
        cartItems.hidden = entries.length === 0;
        cartEmpty.hidden = entries.length > 0;
        cartCount.textContent = itemCount;
        cartCount.setAttribute('aria-label', `${itemCount} item${itemCount === 1 ? '' : 's'} in cart`);
        cartSubtotal.textContent = money.format(subtotal / 100);
        navCartButton.hidden = entries.length === 0;
        navCartCount.textContent = itemCount;
        navCartTotal.textContent = money.format(subtotal / 100);
        mobileCartButton.hidden = entries.length === 0;
        mobileCartCount.textContent = itemCount;
        const cartLabel = `View your cart, ${itemCount} item${itemCount === 1 ? '' : 's'}, ${money.format(subtotal / 100)}`;
        navCartButton.setAttribute('aria-label', cartLabel);
        mobileCartButton.setAttribute('aria-label', cartLabel);
        checkoutButton.disabled = entries.length === 0;
    }

    async function startCheckout() {
        const items = validCartEntries().map(([key, quantity]) => {
            const { product, variant } = cartSelection(key);
            return { id: product.id, variant: variant.id, quantity };
        });
        if (items.length === 0 || checkoutButton.disabled) return;
        checkoutButton.disabled = true;
        checkoutButton.classList.add('loading');
        checkoutLabel.textContent = 'Opening secure checkout';
        checkoutMessage.textContent = '';

        try {
            const response = await fetch('/api/create-checkout-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items }),
            });
            const result = await response.json();
            if (!response.ok || !result.url) throw new Error(result.code || 'CHECKOUT_UNAVAILABLE');
            window.location.assign(result.url);
        } catch {
            checkoutMessage.textContent = 'Checkout is temporarily unavailable. Please try again.';
            checkoutButton.disabled = false;
            checkoutButton.classList.remove('loading');
            checkoutLabel.textContent = 'Secure checkout';
        }
    }

    function dismissOrderStatus() {
        if (orderStatus.hidden) return;
        orderStatus.hidden = true;
        document.body.classList.remove('order-status-open');

        const url = new URL(window.location.href);
        url.searchParams.delete('checkout');
        url.searchParams.delete('session_id');
        window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    }

    async function showOrderStatus() {
        const parameters = new URLSearchParams(window.location.search);
        const status = parameters.get('checkout');
        if (!['success', 'cancelled'].includes(status)) return;
        const kicker = document.getElementById('orderStatusKicker');
        const title = document.getElementById('orderStatusTitle');
        const body = document.getElementById('orderStatusBody');

        if (status === 'success') {
            const sessionId = parameters.get('session_id');
            kicker.textContent = 'Confirming payment';
            title.textContent = 'Checking your Stripe order.';
            body.textContent = 'This usually takes only a moment.';
            orderStatus.dataset.status = 'checking';
            orderStatus.hidden = false;
            document.body.classList.add('order-status-open');
            window.requestAnimationFrame(() => orderStatus.focus({ preventScroll: true }));

            try {
                if (!sessionId) throw new Error('MISSING_SESSION');
                const response = await fetch(`/api/checkout-session-status?session_id=${encodeURIComponent(sessionId)}`, {
                    headers: { Accept: 'application/json' },
                });
                const result = await response.json();
                if (!response.ok || result.confirmed !== true) throw new Error(result.code || 'NOT_CONFIRMED');

                cart.clear();
                saveCart();
                kicker.textContent = 'Payment successful';
                title.textContent = 'Your sticker order is confirmed.';
                body.textContent = 'A Stripe receipt will be sent to the email used at checkout. Your order will now be prepared for shipping. Due to high demand, shipping times may vary.';
                orderStatus.dataset.status = 'success';
                renderCart();
            } catch {
                kicker.textContent = 'Payment verification needed';
                title.textContent = 'We could not verify this order yet.';
                body.textContent = 'Your cart has been kept. Check your Stripe receipt, then contact order support if your payment completed.';
                orderStatus.dataset.status = 'error';
            }
            return;
        } else {
            kicker.textContent = 'Checkout cancelled';
            title.textContent = 'Your cart is still here.';
            body.textContent = 'No payment was completed. You can return to checkout whenever you are ready.';
        }
        orderStatus.dataset.status = status;
        orderStatus.hidden = false;
        document.body.classList.add('order-status-open');
        window.requestAnimationFrame(() => orderStatus.focus({ preventScroll: true }));
    }

    let cartReturnEnabled = false;
    const openCart = () => {
        const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
        cartReturnEnabled = false;
        mobileCartButton.classList.add('cart-in-view');
        cartPanel.scrollIntoView({ behavior, block: 'start' });
        cartPanel.focus({ preventScroll: true });
        window.setTimeout(() => { cartReturnEnabled = true; }, behavior === 'smooth' ? 750 : 0);
    };
    [navCartButton, mobileCartButton].forEach((button) => {
        button.addEventListener('animationend', () => button.classList.remove('attention'));
        button.addEventListener('click', openCart);
    });
    window.addEventListener('scroll', () => {
        if (!cartReturnEnabled || !mobileCartButton.classList.contains('cart-in-view')) return;
        const cartBounds = cartPanel.getBoundingClientRect();
        if (cartBounds.bottom < 0 || cartBounds.top > window.innerHeight) {
            mobileCartButton.classList.remove('cart-in-view');
        }
    }, { passive: true });
    checkoutButton.addEventListener('click', startCheckout);
    orderStatusClose.addEventListener('click', dismissOrderStatus);
    orderStatusContinue.addEventListener('click', dismissOrderStatus);
    orderStatus.addEventListener('click', (event) => {
        if (event.target === orderStatus) dismissOrderStatus();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !orderStatus.hidden) dismissOrderStatus();
    });
    renderCatalog();
    renderCart();
    showOrderStatus();
})();
