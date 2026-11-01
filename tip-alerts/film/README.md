# Outreach film finish

The finish runs locally during image export. It uses no AI image service and does not modify the stored background photographs, story facts, receipt time, or source records.

`grain-v1.png` is a full-frame 1080 × 1920 monochrome procedural texture, with fine irregular grains and faint two-pixel clumping. It is intentionally not tiled. Rebuild exactly with `python3 scripts/build-story-film-assets.py` from the website root. Both the web and native app bundle this same texture and use a 0.50 soft-light blend before drawing type.

Halation is calculated from a quarter-resolution copy of the selected background. It adds a warmer, broader halo outside bright areas (three blur passes, radii 2/5/9 at quarter resolution, strength 0.88 and screen opacity 0.78). Uniform bright areas and dark areas receive no glow. Masks are cached for repeated exports. Charcoal shading, a gentle 30% edge vignette, faint six-pixel raster lines, and static corner marks add a restrained 1990s field-report finish. Text and the clock are drawn last and stay crisp. Existing drafts use the same renderer on reopening; no fact, timestamp, status, or source migration is required. Effects degrade to the existing readable layout if assets cannot load; font/texture requests have a ten-second limit.

Headline font: Barlow Semi Condensed Bold, bundled from the [Google Fonts repository](https://github.com/google/fonts/tree/main/ofl/barlowsemicondensed). License is retained in `../fonts/OFL.txt`. Font SHA-256: `5bd6757e459a110da81b44532f0f43058e2dab2401688abca84f2fdbde193cbb`.

These filters do not establish whether an existing background was AI-generated and do not promise any platform-label outcome.

The public font and film asset folders use long-lived caching. Use new filenames when changing binary content. Authenticated inbox HTML and data retain their existing no-store policy.

## Digital glass readout

The receipt clock uses custom beveled seven-segment polygons, broad and tight red bloom, a warm emissive core, fine deterministic phosphor irregularity, and restrained horizontal/vertical flare around the colon. These are ordinary compositing effects that simulate light scatter, not a physical lens simulation. The plate uses translucent smoked-glass gradients so the existing photo and grain remain visible. The clock meaning, original receipt, and fallback time labels are unchanged.

Digital labels use the locally bundled DSEG14 Classic Regular v0.46 font by keshikan, from the [official DSEG release](https://github.com/keshikan/DSEG/releases/tag/v0.46). Its unmodified font and SIL Open Font License are bundled in `../fonts/DSEG14Classic-Regular.ttf` and `../fonts/DSEG-LICENSE.txt`; the native app includes the same files. No external font request occurs in the app. Main story copy retains the readable Barlow treatment.
