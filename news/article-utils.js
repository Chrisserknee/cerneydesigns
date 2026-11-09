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

  const api = {hasVideo, isArticle, textSegments, articlePage};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NewsArticles = api;
})(typeof window === 'undefined' ? globalThis : window);
