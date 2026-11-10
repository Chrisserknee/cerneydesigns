'use strict';
(function (root) {
  const hasVideo = post => post.media.some(file => file.type.startsWith('video/'));
  const isArticle = post => !hasVideo(post);

  // CMS copy stays text. Only validated HTTPS addresses become links.
  function textSegments(text) {
    const segments = [];
    let cursor = 0;
    for (const match of text.matchAll(/https:\/\/[^\s<>"']+/gu)) {
      let url = match[0];
      while (/[.,;:!?]$/.test(url) || (url.endsWith(')') && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length)) url = url.slice(0, -1);
      try { if (new URL(url).protocol !== 'https:') continue; } catch { continue; }
      if (match.index > cursor) segments.push({text: text.slice(cursor, match.index)});
      segments.push({text: url, url});
      cursor = match.index + url.length;
    }
    if (cursor < text.length) segments.push({text: text.slice(cursor)});
    return segments;
  }

  // Article count is independent of the server's unfiltered pagination offset.
  async function articlePage(fetchPage, offset, isCurrent = () => true) {
    const visited = new Set();
    let nextOffset = offset;
    do {
      if (visited.has(nextOffset) || !isCurrent()) return {posts: [], nextOffset: null};
      visited.add(nextOffset);
      const data = await fetchPage(nextOffset);
      if (!isCurrent()) return {posts: [], nextOffset: null};
      const posts = data.posts.filter(isArticle);
      nextOffset = data.nextOffset;
      if (posts.length) return {posts, nextOffset};
    } while (nextOffset !== null);
    return {posts: [], nextOffset: null};
  }

  // Paired-report and original-post links, in the older one-line form and the
  // newer "Label:" plus line-break form. Returns {label, url} or null.
  const relatedPattern = /^(Watch the corresponding video report|Watch the full video report|Read the corresponding article|Read the accompanying article|Original TikTok publication):\s+(https:\/\/\S+)$/;
  function relatedLink(text) {
    const match = String(text).trim().match(relatedPattern);
    return match ? {label: match[1], url: match[2]} : null;
  }
  // Source attribution and paired links stay visible when long copy is folded.
  const keepVisible = text => relatedLink(text) !== null || /^Source:/.test(String(text).trim());

  // Only an explicitly dated editor's note (e.g. "Originally reported …",
  // "From our … report.", "Sponsored feature. …") gets the small note style.
  // A first paragraph of actual reporting stays at body size.
  const isEditorNote = text => /^(Originally (reported|published)\b|From our \w+ \d{1,2}, \d{4} report\b|Sponsored feature\.)/.test(String(text).trim());

  const api = {hasVideo, isArticle, textSegments, articlePage, relatedLink, keepVisible, isEditorNote};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NewsArticles = api;
})(typeof window === 'undefined' ? globalThis : window);
