(() => {
    'use strict';

    const catalog = Array.isArray(window.MERCH_CATALOG) ? window.MERCH_CATALOG : [];
    const productsById = new Map(catalog.map((product) => [product.id, product]));
    const storageKey = 'chris-cerney-merch-cart-v1';
    const cart = loadCart();

    const productGrid = document.getElementById('productGrid');
    const catalogCount = document.getElementById('catalogCount');
    const cartItems = document.getElementById('cartItems');
    const cartEmpty = document.getElementById('cartEmpty');
    const cartCount = document.getElementById('cartCount');
    const cartSubtotal = document.getElementById('cartSubtotal');
    const checkoutButton = document.getElementById('checkoutButton');
    const checkoutLabel = document.getElementById('checkoutLabel');
    const checkoutMessage = document.getElementById('checkoutMessage');

    const money = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
    });

    function loadCart() {
        try {
            const saved = JSON.parse(localStorage.getItem(storageKey));
            if (!saved || typeof saved !== 'object') return new Map();

            return new Map(Object.entries(saved)
                .filter(([id, quantity]) => productsById.has(id) && Number.isInteger(quantity) && quantity > 0)
                .map(([id, quantity]) => [id, Math.min(quantity, 10)]));
        } catch {
            return new Map();
        }
    }

    function saveCart() {
        localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(cart)));
    }

    function isPurchasable(product) {
        return product.available === true && Number.isInteger(product.price) && product.price > 0;
    }

    function createProductMedia(product, index) {
        const media = document.createElement('div');
        media.className = 'product-media';

        if (product.image) {
            const image = new Image();
            image.src = product.image;
            image.alt = product.imageAlt || product.name;
            image.loading = 'lazy';
            media.appendChild(image);
        } else {
            const number = document.createElement('span');
            number.className = 'product-placeholder-number';
            number.textContent = String(index + 1).padStart(2, '0');

            const label = document.createElement('span');
            label.className = 'product-placeholder-label';
            label.textContent = 'Artwork coming soon';

            media.append(number, label);
        }

        return media;
    }

    function createProductCard(product, index) {
        const card = document.createElement('article');
        card.className = 'product-card';

        const media = createProductMedia(product, index);
        const body = document.createElement('div');
        body.className = 'product-body';

        const status = document.createElement('span');
        status.className = `product-status${isPurchasable(product) ? ' available' : ''}`;
        status.textContent = isPurchasable(product) ? 'Available' : 'Coming soon';

        const title = document.createElement('h3');
        title.textContent = product.name;

        const description = document.createElement('p');
        description.textContent = product.description;

        const actionRow = document.createElement('div');
        actionRow.className = 'product-action-row';

        const price = document.createElement('strong');
        price.className = 'product-price';
        price.textContent = isPurchasable(product) ? money.format(product.price / 100) : 'Price coming soon';

        const addButton = document.createElement('button');
        addButton.type = 'button';
        addButton.className = 'add-button';
        addButton.textContent = isPurchasable(product) ? 'Add to cart' : 'Not yet available';
        addButton.disabled = !isPurchasable(product);
        addButton.addEventListener('click', () => addToCart(product.id));

        actionRow.append(price, addButton);
        body.append(status, title, description, actionRow);
        card.append(media, body);
        return card;
    }

    function renderCatalog() {
        productGrid.replaceChildren(...catalog.map(createProductCard));
        catalogCount.textContent = `${catalog.length} design${catalog.length === 1 ? '' : 's'}`;
    }

    function addToCart(id) {
        const product = productsById.get(id);
        if (!product || !isPurchasable(product)) return;

        cart.set(id, Math.min((cart.get(id) || 0) + 1, 10));
        saveCart();
        renderCart();
    }

    function changeQuantity(id, change) {
        const quantity = (cart.get(id) || 0) + change;
        if (quantity <= 0) {
            cart.delete(id);
        } else {
            cart.set(id, Math.min(quantity, 10));
        }
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

    function createCartItem([id, quantity]) {
        const product = productsById.get(id);
        const item = document.createElement('div');
        item.className = 'cart-item';

        const details = document.createElement('div');
        details.className = 'cart-item-details';

        const name = document.createElement('strong');
        name.textContent = product.name;

        const linePrice = document.createElement('span');
        linePrice.textContent = money.format((product.price * quantity) / 100);
        details.append(name, linePrice);

        const controls = document.createElement('div');
        controls.className = 'quantity-controls';
        const decrease = createQuantityButton('&minus;', `Decrease ${product.name} quantity`, () => changeQuantity(id, -1));
        decrease.innerHTML = '&minus;';

        const count = document.createElement('span');
        count.textContent = quantity;
        count.setAttribute('aria-label', `Quantity ${quantity}`);

        const increase = createQuantityButton('+', `Increase ${product.name} quantity`, () => changeQuantity(id, 1));
        increase.disabled = quantity >= 10;

        const remove = createQuantityButton('&times;', `Remove ${product.name} from cart`, () => {
            cart.delete(id);
            saveCart();
            renderCart();
        });
        remove.innerHTML = '&times;';
        remove.classList.add('remove-button');

        controls.append(decrease, count, increase, remove);
        item.append(details, controls);
        return item;
    }

    function validCartEntries() {
        return Array.from(cart.entries()).filter(([id]) => {
            const product = productsById.get(id);
            return product && isPurchasable(product);
        });
    }

    function renderCart() {
        const entries = validCartEntries();
        const itemCount = entries.reduce((sum, [, quantity]) => sum + quantity, 0);
        const subtotal = entries.reduce((sum, [id, quantity]) => {
            return sum + (productsById.get(id).price * quantity);
        }, 0);

        cartItems.replaceChildren(...entries.map(createCartItem));
        cartItems.hidden = entries.length === 0;
        cartEmpty.hidden = entries.length > 0;
        cartCount.textContent = itemCount;
        cartCount.setAttribute('aria-label', `${itemCount} item${itemCount === 1 ? '' : 's'} in cart`);
        cartSubtotal.textContent = money.format(subtotal / 100);
        checkoutButton.disabled = entries.length === 0;
    }

    async function startCheckout() {
        const items = validCartEntries().map(([id, quantity]) => ({ id, quantity }));
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

            if (!response.ok || !result.url) {
                throw new Error(result.code || 'CHECKOUT_UNAVAILABLE');
            }

            window.location.assign(result.url);
        } catch {
            checkoutMessage.textContent = 'Checkout is not open yet. Please check back soon.';
            checkoutButton.disabled = false;
            checkoutButton.classList.remove('loading');
            checkoutLabel.textContent = 'Checkout with Stripe';
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

    checkoutButton.addEventListener('click', startCheckout);
    renderCatalog();
    renderCart();
    showOrderStatus();
})();
