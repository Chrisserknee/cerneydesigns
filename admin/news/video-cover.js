/** A local cover frame keeps video-only publishing to one file selection. */
export async function videoCover(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  let timeout;
  try {
    await new Promise((resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Cover preview timed out")),
        10000,
      );
      video.onerror = () => reject(new Error("Cover preview unavailable"));
      video.onloadedmetadata = () => {
        if (!Number.isFinite(video.duration) || !video.videoWidth) {
          reject(new Error("Video metadata unavailable"));
          return;
        }
        video.currentTime = Math.min(2.5, video.duration / 2);
      };
      video.onseeked = resolve;
      video.src = url;
    });
    const scale = Math.min(
      1,
      1920 / Math.max(video.videoWidth, video.videoHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Cover preview unavailable");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    if (!blob) throw new Error("Cover preview unavailable");
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + "-cover.jpg", {
      type: "image/jpeg",
    });
  } finally {
    clearTimeout(timeout);
    video.onerror = video.onloadedmetadata = video.onseeked = null;
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
