---
title: Photo metadata
description: Photos you paste or drop into a note lose their GPS position, time, device and text metadata before they are stored.
---

A photo from a phone or a camera usually says **where** it was taken (GPS),
**when**, on **which device** (make, model, sometimes a serial number) and
sometimes **who** took it. If you share the note, export it or sync it,
that information goes with the photo.

Lumen removes it the moment you paste or drop a JPEG, PNG or WebP into a
note, before the image is stored in the vault or put inline:

- **Removed:** EXIF (GPS, date and time, camera, owner), XMP, IPTC,
  comments, and PNG text and time chunks.
- **Kept:** the pixels, exactly as they were (nothing is re-compressed), the
  colour profile, and the photo's orientation, so a portrait photo still
  stands upright.

GIF, SVG, HEIC and AVIF images are stored as they are.

**When a photo can't be read:** the cleaning fails closed. A JPEG, PNG or WebP
whose structure Lumen can't parse is re-drawn through the browser's canvas,
which keeps only the pixels. If that isn't possible either, the photo is not
added (you see a message), and an export or a published site leaves it out.
Anything stored after the image's end is removed too: a second image (MPF,
used by some phones for depth or a preview) or the video of a motion photo.

**On export too:** photos already in the vault (including ones added before
this cleaning existed) are inlined clean into PDF and HTML exports, and
photos inlined in the note as `data:` URLs are cleaned in every export.
Publish site and `lumen publish` copy photos clean. The file in the vault
itself is not changed.

To keep the metadata (for example, for your own photo archive): **Settings →
General →** "Keep photos' location, time and camera details". Importing a
settings file never turns this switch on by itself.
