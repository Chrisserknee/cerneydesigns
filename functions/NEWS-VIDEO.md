# Adaptive news video

Original uploads and reporting remain unchanged. Public feed media gains dimensions and verified `variants` when derivatives are ready. `adaptive` is the HLS master; `q360`, `q720`, `q1080`, and `q2160` are fixed-quality playlists. Dimensions refer to the short edge, so vertical 1080p is 1080x1920 and vertical 4K is 2160x3840. No rendition is upscaled.

`newsMedia` checks current publication and the original's pinned generation before serving a playlist. Each rendition is an immutable, generation-pinned single fMP4 file with byte-range segments; Storage serves video bytes directly. Child playlists use 15-minute signed Storage URLs and no-store responses. No bucket ACL or tip access changes are required. Existing original URLs continue to work, including while processing fails or is pending.

`processNewsVideo` accepts only owner upload objects under `_news/v1/media/<uuid>` and its own `_news/v1/video-jobs/<uuid>/<generation>/<quality>.json` jobs. A source event probes the upload and queues one job per supported quality. Jobs use generation preconditions and a bounded lease with at most two processing attempts. Each output is checked for dimensions, full duration, audio track, playlist completeness and byte-range bounds, then uploaded with MD5 verification before adding it to the private rendition index. Processing is limited to two instances, one job per instance, 2 CPUs/4 GiB each, and 540 seconds per invocation.

Current processing supports SDR reports up to ten minutes and 4K. Unsupported HDR, longer reports, or exhausted jobs retain the playable original; do not label those originals as adaptive. Rendition indexes are separate from the publishing catalog, so publishing edits preserve derivatives and no notification is sent by processing. No changes are made to other tip or notification functions.

Tests: `node --test tests/news/*.test.js` and `node --test functions/*.test.js`.

Deploy only the changed functions: first `newsMedia,processNewsVideo`, verify live playlists and a private QA upload, then `newsApi` to expose the verified variants. Do not deploy the entire functions codebase for this change.
