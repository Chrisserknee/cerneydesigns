'use strict';
(() => {
  const byId = id => document.getElementById(id);
  const node = (tag, text, cls) => { const element = document.createElement(tag); element.textContent = text; if (cls) element.className = cls; return element; };
  let busy = false;
  async function api(body) {
    const response = await fetch('/api/spotlight', {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error || 'Unable to load Local Spotlight.'); error.status = response.status; throw error; }
    return result;
  }
  async function load() {
    if (busy) return;
    busy = true; byId('refresh').disabled = true; byId('message').textContent = 'Loading listings…';
    try {
      const data = await api({op:'admin-list'});
      byId('login').hidden = true; byId('list').replaceChildren();
      for (const listing of data.listings) {
        const profile = listing.profile || {};
        const card = node('article', '', 'listing');
        const label = listing.hidden ? 'Hidden' : listing.published ? 'Published' : 'Not published';
        card.append(node('span', label, 'status-pill'), node('h2', profile.businessName || 'Incomplete business profile'), node('p', [profile.category, profile.city].filter(Boolean).join(' · '), 'detail'), node('p', profile.description || 'Profile details are unavailable.'), node('p', 'Billing status: ' + listing.status, 'detail'));
        if (profile.website) { try { const url = new URL(profile.website); if(url.protocol === 'https:') {const link=node('a','Visit business website');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer sponsored';card.append(link);} } catch {} }
        const button = node('button', listing.hidden ? 'Show when eligible' : 'Hide listing', 'primary-button');
        button.type = 'button';
        button.addEventListener('click', async () => {
          button.disabled = true;
          try { await api({op:'admin-update',subscriptionId:listing.subscriptionId,hidden:!listing.hidden}); await load(); }
          catch(error) {byId('message').textContent=error.message;button.disabled=false;}
        });
        card.append(button);byId('list').append(card);
      }
      byId('message').textContent = data.listings.length ? `${data.listings.length} business listing${data.listings.length === 1 ? '' : 's'}.` : 'No paid Spotlight subscriptions yet.';
    } catch(error) {
      byId('message').textContent=error.message;byId('login').hidden=error.status!==401;
    } finally {busy=false;byId('refresh').disabled=false;}
  }
  byId('refresh').addEventListener('click', load);load();
})();
