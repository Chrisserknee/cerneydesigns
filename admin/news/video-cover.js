/** A local cover frame keeps video-only publishing to one file selection. */
export async function videoCover(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  // WebKit may seek without decoding a detached video. Keep a tiny muted
  // player in the page until a frame has actually reached the compositor.
  video.setAttribute("aria-hidden", "true");
  video.style.cssText =
    "position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:.001;pointer-events:none";
  document.body.append(video);
  let timeout;
  let frame;
  let cancelled = false;
  try {
    await new Promise((resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Cover preview timed out")),
        15000,
      );
      video.onerror = () => reject(new Error("Cover preview unavailable"));
      video.onloadedmetadata = () => {
        if (!Number.isFinite(video.duration) || !video.videoWidth) {
          reject(new Error("Video metadata unavailable"));
          return;
        }
        video.currentTime = Math.min(2.5, video.duration / 2);
      };
      video.onseeked = () => {
        video.onseeked = null;
        void video
          .play()
          .then(() => {
            if (cancelled) return;
            if (video.requestVideoFrameCallback) {
              frame = video.requestVideoFrameCallback(resolve);
            } else {
              requestAnimationFrame(() => requestAnimationFrame(resolve));
            }
          })
          .catch(reject);
      };
      video.src = url;
    });
    video.pause();
    const scale = Math.min(
      1,
      1280 / Math.max(video.videoWidth, video.videoHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Cover preview unavailable");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const sample = document.createElement("canvas");
    sample.width = sample.height = 16;
    const sampleContext = sample.getContext("2d");
    if (!sampleContext) throw new Error("Cover preview unavailable");
    sampleContext.drawImage(canvas, 0, 0, 16, 16);
    const pixels = sampleContext.getImageData(0, 0, 16, 16).data;
    if (!pixels.some((value, index) => index % 4 !== 3 && value > 8)) {
      throw new Error("Cover frame is blank");
    }
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.78),
    );
    if (!blob) throw new Error("Cover preview unavailable");
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + "-cover.jpg", {
      type: "image/jpeg",
    });
  } finally {
    cancelled = true;
    clearTimeout(timeout);
    if (frame !== undefined) video.cancelVideoFrameCallback(frame);
    video.pause();
    video.onerror = video.onloadedmetadata = video.onseeked = null;
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}
