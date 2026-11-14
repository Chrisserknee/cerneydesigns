'use strict';
const {createHash, createHmac} = require('node:crypto');
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const AUTHOR = /^[a-f0-9]{64}$/;
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const hash = value => createHash('sha256').update(value).digest('hex');
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail(400, 'Add valid text within the character limit.');
  return value.trim();
}
function createCommentsService({store, secret, now = Date.now}) {
  const authorId = token => {
    if (!/^[a-f0-9]{64}$/.test(token || '')) return null;
    return createHmac('sha256', secret()).update('comment-author:' + token).digest('hex');
  };
  async function mutate(key, change) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const old = await store.read(key);
      const next = change(old?.data);
      try { await store.write(key, next, old?.generation || 0); return next; }
      catch (error) { if (Number(error.code) !== 412 || attempt === 7) throw error; }
    }
  }
  const threadKey = id => 'threads/' + id + '.json';
  const thread = async id => (await store.read(threadKey(id)))?.data || {storyId: id, comments: []};
  const bans = async () => (await store.read('bans.json'))?.data || {authors: []};
  async function story(id) {
    if (!ID.test(id || '')) fail(400, 'Invalid report.');
    const post = (await store.catalog()).posts.find(p => p.id === id);
    if (!post || post.status !== 'published' || !Number.isFinite(Date.parse(post.publishAt)) || Date.parse(post.publishAt) > now() || !post.media?.some(m => m.type.startsWith('video/'))) fail(404, 'This video report is unavailable.');
    return post;
  }
  async function limit(key, max, interval) {
    await mutate('limits/' + hash(key) + '.json', old => {
      const record = old && old.until > now() ? old : {count: 0, until: now() + interval};
      if (record.count >= max) fail(429, 'Please wait a few minutes before trying again.');
      return {...record, count: record.count + 1};
    });
  }
  const publicComment = (c, mine) => ({id: c.id, authorId: c.authorId, displayName: c.displayName, text: c.text, createdAt: c.createdAt, status: c.status, mine: c.authorId === mine});
  async function handle(body, context = {}) {
    // Privileges and bearer credentials come only from the HTTP wrapper.
    const who = authorId(context.token);
    const op = body?.op;
    if (typeof op !== 'string') fail(400, 'Invalid request.');
    if (op.startsWith('admin-') && context.admin !== true) fail(401, 'Sign in as the administrator.');
    if (op === 'admin-list') {
      const catalog = await store.catalog();
      const rows = await store.listThreads();
      return {comments: rows.flatMap(row => row.comments.filter(c => ['pending', 'flagged'].includes(c.status)).map(c => ({...publicComment(c), storyId: row.storyId, storyTitle: catalog.posts.find(p => p.id === row.storyId)?.title || 'Unavailable report', reportReason: c.reportReason || ''}))).sort((a,b) => a.createdAt.localeCompare(b.createdAt)).slice(0,100)};
    }
    if (op === 'admin-moderate') {
      if (!ID.test(body.storyId || '') || !ID.test(body.commentId || '') || !['approve','remove','ban'].includes(body.action)) fail(400, 'Invalid moderation action.');
      const row = await thread(body.storyId);
      const selected = row.comments.find(c => c.id === body.commentId);
      if (!selected || selected.status === 'deleted') fail(404, 'Comment unavailable.');
      if (body.action === 'ban') await mutate('bans.json', old => ({authors: [...new Set([...(old?.authors || []), selected.authorId])].slice(-10000)}));
      await mutate(threadKey(body.storyId), old => ({...old, comments: old.comments.map(c => c.id !== body.commentId || c.status === 'deleted' ? c : {...c, status: body.action === 'approve' ? 'approved' : 'removed', moderatedAt: new Date(now()).toISOString()})}));
      return {ok: true};
    }
    if (op === 'delete-all') {
      if (!who) fail(401, 'Your commenting session is unavailable.');
      const author = (await store.read('authors/' + who + '.json'))?.data;
      for (const id of author?.stories || []) await mutate(threadKey(id), old => ({storyId: id, comments: (old?.comments || []).map(c => c.authorId === who ? {...c, text: '', displayName: '', status: 'deleted', reportReason: ''} : c)}));
      await mutate('authors/' + who + '.json', () => ({stories: [], blocked: []}));
      return {ok: true};
    }
    if (!['list','create','delete','report','block'].includes(op)) fail(400, 'Unknown request.');
    await story(body.storyId);
    if (op === 'list') {
      const offset = body.offset === undefined ? 0 : body.offset;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2000) fail(400, 'Invalid page.');
      const [row, banned, viewer] = await Promise.all([thread(body.storyId), bans(), who ? store.read('authors/' + who + '.json') : null]);
      const blocked = new Set([...(banned.authors || []), ...(viewer?.data.blocked || [])]);
      const visible = row.comments.filter(c => c.status === 'approved' && !blocked.has(c.authorId));
      const ordered = visible.slice().reverse();
      const pending = offset === 0 && who ? row.comments.filter(c => c.authorId === who && c.status === 'pending' && !blocked.has(who)).slice(-10).reverse() : [];
      return {comments: [...pending,...ordered.slice(offset, offset + 30)].map(c => publicComment(c, who)), count: visible.length, nextOffset: offset + 30 < ordered.length ? offset + 30 : null};
    }
    if (!who) fail(401, 'Your commenting session is unavailable.');
    if ((await bans()).authors.includes(who) && ['create','report'].includes(op)) fail(403, 'Commenting is unavailable for this viewer.');
    if (op === 'block') {
      if (!AUTHOR.test(body.authorId || '') || body.authorId === who) fail(400, 'Invalid viewer.');
      await mutate('authors/' + who + '.json', old => ({stories: old?.stories || [], blocked: [...new Set([...(old?.blocked || []), body.authorId])].slice(-200)}));
      return {ok: true};
    }
    if (!ID.test(body.commentId || '')) fail(400, 'Invalid comment.');
    if (op === 'create') {
      if (body.consent !== true) fail(400, 'Agree to the comment guidelines before posting.');
      const displayName = text(body.displayName, 36), content = text(body.text, 1000);
      if (displayName.length < 2 || /cerney|moderator|administrator|newsroom|https?:|www\./i.test(displayName)) fail(400, 'Choose a display name without a newsroom or moderator title.');
      const existing = (await thread(body.storyId)).comments.find(c => c.id === body.commentId);
      if (existing) { if (existing.authorId !== who) fail(409, 'Please try posting again.'); return {comment: publicComment(existing, who)}; }
      await limit('post-viewer:' + who, 6, 10 * 60 * 1000);
      await limit('post-network:' + context.clientKey, 30, 60 * 60 * 1000);
      await mutate('authors/' + who + '.json', old => {
        const stories = [...new Set([...(old?.stories || []), body.storyId])];
        if (stories.length > 300) fail(429, 'Comment history limit reached. Contact app support.');
        return {stories, blocked: old?.blocked || []};
      });
      const comment = {id: body.commentId, authorId: who, displayName, text: content, status: 'pending', createdAt: new Date(now()).toISOString()};
      const saved = await mutate(threadKey(body.storyId), old => {
        const row = old || {storyId: body.storyId, comments: []};
        const duplicate = row.comments.find(c => c.id === body.commentId);
        if (duplicate) { if (duplicate.authorId !== who) fail(409, 'Please try posting again.'); return row; }
        if (row.comments.length >= 2000) fail(429, 'Comments are full for this report.');
        return {...row, comments: [...row.comments, comment]};
      });
      return {comment: publicComment(saved.comments.find(c => c.id === body.commentId), who)};
    }
    if (op === 'report') await limit('report:' + who, 20, 86400000);
    await mutate(threadKey(body.storyId), old => {
      const selected = old?.comments.find(c => c.id === body.commentId);
      if (!selected) fail(404, 'Comment unavailable.');
      if (op === 'delete' && selected.authorId !== who) fail(403, 'You can only delete your own comments.');
      if (op === 'report' && selected.status !== 'approved') fail(404, 'Comment unavailable.');
      return {...old, comments: old.comments.map(c => c.id !== selected.id ? c : op === 'delete' ? {...c, text: '', displayName: '', status: 'deleted', reportReason: ''} : {...c, status: 'flagged', reportReason: text(body.reason, 200), reportedAt: new Date(now()).toISOString()})};
    });
    return {ok: true};
  }
  return {handle};
}
module.exports = {createCommentsService};
