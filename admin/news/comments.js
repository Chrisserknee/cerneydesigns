'use strict';
const queue = document.getElementById('queue'), message = document.getElementById('message'), refresh = document.getElementById('refresh');
async function api(body) {
  const response = await fetch('/api/news', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result = await response.json();
  document.getElementById('signin').hidden = response.status !== 401;
  if (!response.ok) throw new Error(result.error || 'Could not load comments.');
  return result;
}
function el(tag, value, className) { const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node; }
async function load() {
  refresh.disabled=true;message.textContent='Loading review queue…';
  try {
    const data=await api({op:'admin-comments-list'});
    queue.replaceChildren();
    message.textContent=data.comments.length ? `${data.comments.length} comments to review. Approve only comments that follow the guidelines.` : 'You’re caught up. No comments need review.';
    for (const comment of data.comments) {
      const card=el('article','','review-card');
      card.append(el('h2',comment.storyTitle),el('p',comment.status==='flagged' ? 'Reported · hidden pending review' : 'Pending · not public','review-status'),el('strong',comment.displayName),el('p',comment.text,'comment-text'),el('small',new Date(comment.createdAt).toLocaleString()));
      if(comment.reportReason)card.append(el('p',comment.reportReason));
      const actions=el('div','','review-actions');
      for (const [action,label] of [['approve','Approve'],['remove','Remove'],['ban','Block viewer & remove']]) {
        const button=el('button',label,action);button.type='button';
        button.addEventListener('click',async()=>{
          if(action==='ban'&&!window.confirm('Block this viewer from commenting and hide their comments?'))return;
          const buttons=[...card.querySelectorAll('button')];buttons.forEach(b=>{b.disabled=true;});
          try {await api({op:'admin-comments-moderate',storyId:comment.storyId,commentId:comment.id,action});await load();}
          catch(error){message.textContent=error.message;buttons.forEach(b=>{b.disabled=false;});}
        });actions.append(button);
      }
      card.append(actions);queue.append(card);
    }
  } catch(error){message.textContent=error.message;} finally{refresh.disabled=false;}
}
refresh.addEventListener('click',load);void load();
