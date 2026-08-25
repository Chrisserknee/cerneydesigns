(() => {
    'use strict';

    const loginView = document.getElementById('loginView');
    const loginForm = document.getElementById('loginForm');
    const loginMessage = document.getElementById('loginMessage');
    const password = document.getElementById('password');
    const dashboard = document.getElementById('dashboard');
    const signOutButton = document.getElementById('signOutButton');
    const refreshButton = document.getElementById('refreshButton');
    const lastUpdated = document.getElementById('lastUpdated');
    const summaryGrid = document.getElementById('summaryGrid');
    const inventoryForm = document.getElementById('inventoryForm');
    const inventoryRows = document.getElementById('inventoryRows');
    const inventoryStatus = document.getElementById('inventoryStatus');
    const inventoryMessage = document.getElementById('inventoryMessage');
    const saveInventoryButton = document.getElementById('saveInventoryButton');
    const ordersList = document.getElementById('ordersList');
    const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    const integer = new Intl.NumberFormat('en-US');
    let currentData = null;

    async function request(url, options = {}) {
        const response = await fetch(url, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json', ...(options.headers || {}) },
            ...options,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(body.error || 'Request failed.');
            error.status = response.status;
            throw error;
        }
        return body;
    }

    function showLogin(message = '') {
        dashboard.hidden = true;
        signOutButton.hidden = true;
        loginView.hidden = false;
        loginMessage.textContent = message;
        password.focus();
    }

    function showDashboard() {
        loginView.hidden = true;
        dashboard.hidden = false;
        signOutButton.hidden = false;
    }

    function summaryItem(label, value, tone = '') {
        const item = document.createElement('div');
        item.className = `summary-item${tone ? ` ${tone}` : ''}`;
        const valueElement = document.createElement('strong');
        valueElement.textContent = value;
        const labelElement = document.createElement('span');
        labelElement.textContent = label;
        item.append(valueElement, labelElement);
        return item;
    }

    function renderSummary(summary) {
        const net = summary.net > 0 ? money.format(summary.net / 100) : 'Calculating';
        summaryGrid.replaceChildren(
            summaryItem('Paid orders', integer.format(summary.orders)),
            summaryItem('Gross collected', money.format(summary.totalCollected / 100)),
            summaryItem('Stripe net', net, 'accent'),
            summaryItem('Bundles sold', integer.format(summary.bundleUnits)),
        );
    }

    function stockState(item) {
        if (!item.tracked) return '—';
        return integer.format(item.remaining);
    }

    function renderInventory(data) {
        const { inventory, summary } = data;
        inventoryStatus.textContent = inventory.fullyTracked ? 'Tracking active' : 'Needs stock count';
        inventoryStatus.classList.toggle('active', inventory.fullyTracked);
        inventoryRows.replaceChildren(...inventory.items.map((item) => {
            const row = document.createElement('tr');
            const productCell = document.createElement('th');
            productCell.scope = 'row';
            const image = new Image();
            image.src = item.image;
            image.alt = '';
            const identity = document.createElement('span');
            identity.textContent = item.name;
            productCell.append(image, identity);

            const direct = document.createElement('td');
            direct.dataset.label = 'Direct';
            direct.textContent = integer.format(item.directSold);
            const bundles = document.createElement('td');
            bundles.dataset.label = 'Bundles';
            bundles.textContent = integer.format(item.bundleSold);
            const used = document.createElement('td');
            used.dataset.label = 'Used';
            used.textContent = integer.format(item.totalUsed);
            const remaining = document.createElement('td');
            remaining.dataset.label = 'Remaining';
            remaining.className = item.tracked && item.remaining <= 5 ? 'low-stock' : '';
            remaining.textContent = stockState(item);

            const countCell = document.createElement('td');
            countCell.dataset.label = 'Count on hand';
            const input = document.createElement('input');
            input.type = 'number';
            input.name = item.sku;
            input.min = '0';
            input.max = '100000';
            input.step = '1';
            input.inputMode = 'numeric';
            input.required = true;
            input.value = item.remaining === null ? '' : String(item.remaining);
            input.setAttribute('aria-label', `${item.name} count on hand`);
            countCell.appendChild(input);
            row.append(productCell, direct, bundles, used, remaining, countCell);
            return row;
        }));
        if (summary.legacyUnspecified > 0) {
            inventoryMessage.textContent = `${summary.legacyUnspecified} older 2-inch sticker unit${summary.legacyUnspecified === 1 ? '' : 's'} did not include a color. They are listed separately and are not automatically assigned to a finish.`;
            inventoryMessage.classList.add('warning');
        } else {
            inventoryMessage.textContent = inventory.updatedAt
                ? `Last physical count saved ${new Date(inventory.updatedAt).toLocaleString()}.`
                : 'Enter all five physical counts to begin stock tracking.';
            inventoryMessage.classList.remove('warning');
        }
    }

    function renderOrders(orders) {
        if (!orders.length) {
            const empty = document.createElement('p');
            empty.className = 'empty-state';
            empty.textContent = 'No paid merchandise orders found.';
            ordersList.replaceChildren(empty);
            return;
        }
        ordersList.replaceChildren(...orders.map((order) => {
            const row = document.createElement('article');
            row.className = 'order-row';
            const date = document.createElement('time');
            date.dateTime = new Date(order.created * 1000).toISOString();
            date.textContent = new Date(order.created * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
            const details = document.createElement('p');
            details.textContent = order.items.join(' · ');
            const amount = document.createElement('strong');
            amount.textContent = money.format(order.amount / 100);
            if (order.refunded > 0) {
                const refund = document.createElement('small');
                refund.textContent = `${money.format(order.refunded / 100)} refunded`;
                amount.appendChild(refund);
            }
            row.append(date, details, amount);
            return row;
        }));
    }

    function render(data) {
        currentData = data;
        showDashboard();
        renderSummary(data.summary);
        renderInventory(data);
        renderOrders(data.recentOrders);
        lastUpdated.textContent = `Stripe synced ${new Date(data.generatedAt).toLocaleString()}`;
    }

    async function loadDashboard() {
        refreshButton.disabled = true;
        refreshButton.classList.add('loading');
        try {
            render(await request('/api/admin-store'));
        } catch (error) {
            if (error.status === 401) showLogin('Your session expired. Sign in again.');
            else lastUpdated.textContent = error.message;
        } finally {
            refreshButton.disabled = false;
            refreshButton.classList.remove('loading');
        }
    }

    loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submit = loginForm.querySelector('button[type="submit"]');
        submit.disabled = true;
        loginMessage.textContent = 'Signing in…';
        try {
            await request('/api/admin-auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: password.value }),
            });
            password.value = '';
            await loadDashboard();
        } catch (error) {
            loginMessage.textContent = error.message;
            password.select();
        } finally {
            submit.disabled = false;
        }
    });

    inventoryForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const inventory = {};
        for (const input of inventoryForm.querySelectorAll('input[type="number"]')) {
            inventory[input.name] = Number(input.value);
        }
        saveInventoryButton.disabled = true;
        inventoryMessage.textContent = 'Saving physical count…';
        inventoryMessage.classList.remove('warning');
        try {
            render(await request('/api/admin-store', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ inventory }),
            }));
            inventoryMessage.textContent = 'Inventory saved. The storefront availability is now updated.';
        } catch (error) {
            inventoryMessage.textContent = error.message;
            inventoryMessage.classList.add('warning');
        } finally {
            saveInventoryButton.disabled = false;
        }
    });

    refreshButton.addEventListener('click', loadDashboard);
    signOutButton.addEventListener('click', async () => {
        try {
            await request('/api/admin-auth', { method: 'DELETE' });
        } finally {
            currentData = null;
            showLogin('Signed out.');
        }
    });

    (async () => {
        try {
            const status = await request('/api/admin-auth');
            if (!status.configured) {
                showLogin('Administrator access is waiting for secure server configuration.');
                loginForm.querySelector('button[type="submit"]').disabled = true;
                return;
            }
            if (status.authenticated) await loadDashboard();
            else showLogin();
        } catch {
            showLogin('The administrator service is temporarily unavailable.');
        }
    })();
})();
