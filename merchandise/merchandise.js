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
    const checkoutButton = document.getElementById('checkoutButton');
    const checkoutLabel = document.getElementById('checkoutLabel');
    const checkoutMessage = document.getElementById('checkoutMessage');
    const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

    function saveCart() {
        localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(cart)));
    }

    function isPurchasable(product) {
        return product.available === true && Number.isInteger(product.price) && product.price > 0;
    }

    function createProductCard(product) {
        const selected = { variant: product.variants[0], showingReference: false };
        const card = document.createElement('article');
        card.className = 'product-card';

        const media = document.createElement('div');
        media.className = 'product-media';
        const image = new Image();
        image.src = selected.variant.image;
        image.alt = selected.variant.imageAlt;
        image.loading = 'lazy';
        media.appendChild(image);

        const body = document.createElement('div');
        body.className = 'product-body';
        const status = document.createElement('span');
        status.className = `product-status${isPurchasable(product) ? ' available' : ''}`;
        status.textContent = isPurchasable(product) ? 'Available' : 'Checkout setup';
        const title = document.createElement('h3');
        title.textContent = product.name;
        const description = document.createElement('p');
        description.textContent = product.description;

        const optionArea = document.createElement('div');
        optionArea.className = 'product-options';
        const optionHeading = document.createElement('div');
        optionHeading.className = 'option-heading';
        const optionLabel = document.createElement('span');
        optionLabel.textContent = product.variants.length > 1 ? 'Choose a finish' : 'Design';
        const optionName = document.createElement('strong');
        optionName.textContent = selected.variant.name;
        optionHeading.append(optionLabel, optionName);

        const controls = document.createElement('div');
        controls.className = 'product-controls';
        let referenceButton;

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
                const thumbnail = new Image();
                thumbnail.src = variant.image;
                thumbnail.alt = '';
                button.appendChild(thumbnail);
                button.addEventListener('click', () => {
                    selected.variant = variant;
                    selected.showingReference = false;
                    image.src = variant.image;
                    image.alt = variant.imageAlt;
                    optionName.textContent = variant.name;
                    variantList.querySelectorAll('.variant-button').forEach((candidate) => {
                        const isSelected = candidate === button;
                        candidate.classList.toggle('selected', isSelected);
                        candidate.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
                    });
                    referenceButton.classList.remove('active');
                    referenceButton.textContent = 'Size reference';
                });
                variantList.appendChild(button);
            });
            controls.appendChild(variantList);
        }

        referenceButton = document.createElement('button');
        referenceButton.type = 'button';
        referenceButton.className = 'reference-button';
        referenceButton.textContent = 'Size reference';
        referenceButton.addEventListener('click', () => {
            selected.showingReference = !selected.showingReference;
            image.src = selected.showingReference ? product.sizeReference : selected.variant.image;
            image.alt = selected.showingReference ? product.sizeReferenceAlt : selected.variant.imageAlt;
            referenceButton.classList.toggle('active', selected.showingReference);
            referenceButton.textContent = selected.showingReference ? 'Back to design' : 'Size reference';
        });
        controls.appendChild(referenceButton);
        optionArea.append(optionHeading, controls);

        const actionRow = document.createElement('div');
        actionRow.className = 'product-action-row';
        const price = document.createElement('strong');
        price.className = 'product-price';
        price.textContent = Number.isInteger(product.price) ? money.format(product.price / 100) : 'Price coming soon';
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
        actionRow.append(price, addButton);
        body.append(status, title, description, optionArea, actionRow);
        card.append(media, body);
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
        navCartButton.classList.remove('attention');
        window.requestAnimationFrame(() => navCartButton.classList.add('attention'));
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
        const remove = createQuantityButton('\u00d7', `Remove ${variant.name} from cart`, () => {
            cart.delete(key);
            saveCart();
            renderCart();
        });
        remove.classList.add('remove-button');
        controls.append(decrease, count, increase, remove);
        item.append(details, controls);
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
        navCartButton.setAttribute('aria-label', `View your cart, ${itemCount} item${itemCount === 1 ? '' : 's'}, ${money.format(subtotal / 100)}`);
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

    function showOrderStatus() {
        const status = new URLSearchParams(window.location.search).get('checkout');
        if (!['success', 'cancelled'].includes(status)) return;
        const section = document.getElementById('orderStatus');
        const kicker = document.getElementById('orderStatusKicker');
        const title = document.getElementById('orderStatusTitle');
        const body = document.getElementById('orderStatusBody');

        if (status === 'success') {
            cart.clear();
            saveCart();
            kicker.textContent = 'Thank you';
            title.textContent = 'Stripe is confirming your order.';
            body.textContent = 'Your receipt and final order details will be sent to the email used at checkout.';
            renderCart();
        } else {
            kicker.textContent = 'Checkout cancelled';
            title.textContent = 'Your cart is still here.';
            body.textContent = 'No payment was completed. You can return to checkout whenever you are ready.';
        }
        section.hidden = false;
    }

    navCartButton.addEventListener('animationend', () => navCartButton.classList.remove('attention'));
    navCartButton.addEventListener('click', () => {
        const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
        cartPanel.scrollIntoView({ behavior, block: 'start' });
        cartPanel.focus({ preventScroll: true });
    });
    checkoutButton.addEventListener('click', startCheckout);
    renderCatalog();
    renderCart();
    showOrderStatus();
})();
