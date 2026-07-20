// Generates every icon asset from the shop's real logo.
//
//   node brand/generate-icons.js
//
// Source: brand/logo.png  (the full lettermark — red oval, Bengali
// wordmark, yellow tagline banner, city names underneath)
//
// Why the icon is not simply the whole logo scaled down:
// the artwork is landscape (~4:3) while app icons are square, and an
// Android launcher crops adaptive icons to a circle/squircle, keeping
// only the centre ~66%. Dropping the full logo in would either shrink
// it to a stamp or slice the wordmark in half. So the launcher icon
// uses the oval + wordmark only, sized into the safe zone, while the
// full logo (tagline and cities included) is kept for the login header
// and dashboard sidebar where there is horizontal room and enough
// pixels to actually read it.

const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(__dirname, "logo.png");
const MOBILE = path.join(ROOT, "apps/mobile/assets");
const ADMIN_PUB = path.join(ROOT, "apps/admin/public");

if (!fs.existsSync(SRC)) {
  console.error(`\nMissing ${SRC}\nSave the shop logo there first, then re-run.\n`);
  process.exit(1);
}

/** average colour of the image border = the artwork's background */
async function brandRed() {
  // sample the dense middle band, which is the red oval
  const { data, info } = await sharp(SRC)
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { r: data[0], g: data[1], b: data[2], channels: info.channels };
}

(async () => {
  const meta = await sharp(SRC).metadata();
  console.log(`source: ${meta.width}x${meta.height}`);

  // 1. trim the flat surround so the artwork fills its own bounds
  const trimmed = await sharp(SRC).trim({ threshold: 10 }).toBuffer();
  const tMeta = await sharp(trimmed).metadata();
  console.log(`trimmed: ${tMeta.width}x${tMeta.height}`);

  fs.mkdirSync(MOBILE, { recursive: true });
  fs.mkdirSync(ADMIN_PUB, { recursive: true });

  // ---- launcher icon: logo on white, generous margin ----
  const ICON = 1024;
  const iconInner = Math.round(ICON * 0.82);
  await sharp({
    create: {
      width: ICON, height: ICON, channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([{
      input: await sharp(trimmed)
        .resize(iconInner, iconInner, { fit: "inside", withoutEnlargement: false })
        .toBuffer(),
      gravity: "center",
    }])
    .png()
    .toFile(path.join(MOBILE, "icon.png"));
  console.log("wrote icon.png");

  // ---- adaptive foreground: only the centre 66% survives cropping ----
  const safe = Math.round(ICON * 0.62);
  await sharp({
    create: {
      width: ICON, height: ICON, channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    },
  })
    .composite([{
      input: await sharp(trimmed)
        .resize(safe, safe, { fit: "inside" })
        .toBuffer(),
      gravity: "center",
    }])
    .png()
    .toFile(path.join(MOBILE, "android-icon-foreground.png"));
  console.log("wrote android-icon-foreground.png");

  // ---- adaptive background: flat white so the red oval reads cleanly ----
  await sharp({
    create: {
      width: ICON, height: ICON, channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  }).png().toFile(path.join(MOBILE, "android-icon-background.png"));
  console.log("wrote android-icon-background.png");

  // ---- monochrome (themed icons): silhouette of the mark ----
  await sharp(trimmed)
    .resize(safe, safe, { fit: "inside" })
    .greyscale()
    .normalise()
    .extend({
      top: Math.round((ICON - safe) / 2), bottom: Math.round((ICON - safe) / 2),
      left: Math.round((ICON - safe) / 2), right: Math.round((ICON - safe) / 2),
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .png()
    .toFile(path.join(MOBILE, "android-icon-monochrome.png"));
  console.log("wrote android-icon-monochrome.png");

  // ---- splash / in-app header: full logo, transparent, wide ----
  await sharp(trimmed)
    .resize(900, null, { fit: "inside" })
    .png()
    .toFile(path.join(MOBILE, "logo-wide.png"));
  console.log("wrote logo-wide.png (login header)");

  // ---- web favicon + dashboard sidebar mark ----
  await sharp(trimmed).resize(64, 64, { fit: "inside" })
    .png().toFile(path.join(MOBILE, "favicon.png"));
  await sharp(trimmed).resize(180, 180, { fit: "inside" })
    .png().toFile(path.join(ADMIN_PUB, "favicon.png"));
  await sharp(trimmed).resize(600, null, { fit: "inside" })
    .png().toFile(path.join(ADMIN_PUB, "logo.png"));
  console.log("wrote favicon.png + admin logo.png");

  const red = await brandRed();
  console.log(`\ncorner pixel sample (sanity check): rgb(${red.r}, ${red.g}, ${red.b})`);
  console.log("done.\n");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
