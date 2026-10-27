'use strict';

// Shared across inbox sections and overlapping requests in one instance.
// Coalesce only an identical storage generation; authorization stays uncached.
function createReadPool(limit = 16) {
    const pending = new Map(), queue = [];
    let active = 0;
    function drain() {
        while (active < limit && queue.length) {
            const {key, work, resolve, reject} = queue.shift();
            active++;
            const finish = (settle, value) => {
                pending.delete(key);
                active--;
                settle(value);
                drain();
            };
            Promise.resolve().then(work).then(value => finish(resolve,value), error => finish(reject,error));
        }
    }
    return function readOnce(key, work) {
        if (pending.has(key)) return pending.get(key);
        const promise = new Promise((resolve, reject) => queue.push({key, work, resolve, reject}));
        pending.set(key, promise);
        drain();
        return promise;
    };
}

module.exports = {createReadPool};
