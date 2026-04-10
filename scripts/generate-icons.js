/**
 * Generate PWA icons from SVG template.
 * Run: node scripts/generate-icons.js
 *
 * For production, replace these with professionally designed icons.
 * This script creates simple placeholder icons.
 */
const fs = require('fs');
const path = require('path');

const sizes = [72, 96, 128, 144, 152, 180, 192, 384, 512];

const iconDir = path.join(__dirname, '..', 'public', 'icons');
if (!fs.existsSync(iconDir)) {
  fs.mkdirSync(iconDir, { recursive: true });
}

// Create a simple SVG icon for each size
for (const size of sizes) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" fill="#1a1a2e"/>
  <text x="50%" y="42%" dominant-baseline="middle" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-weight="800" font-size="${Math.round(size * 0.22)}" fill="#e94560">push</text>
  <text x="50%" y="65%" dominant-baseline="middle" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-weight="800" font-size="${Math.round(size * 0.22)}" fill="#ffffff">IT</text>
</svg>`;

  fs.writeFileSync(path.join(iconDir, `icon-${size}.svg`), svg);
  console.log(`Generated icon-${size}.svg`);
}

// Also save as .png placeholder (actually SVG - for real PNGs use sharp or canvas)
console.log('\nNote: These are SVG placeholders.');
console.log('For production iOS icons, convert to PNG using:');
console.log('  - https://realfavicongenerator.net');
console.log('  - Or: npx sharp-cli resize --width 192 icon.svg icon-192.png');
console.log('\nFor now, copy SVGs as PNG placeholders:');

for (const size of sizes) {
  const svgPath = path.join(iconDir, `icon-${size}.svg`);
  const pngPath = path.join(iconDir, `icon-${size}.png`);
  // Copy SVG as a placeholder (browsers will handle SVG icons)
  fs.copyFileSync(svgPath, pngPath);
}

console.log('Done! Replace .png files with actual PNG images for production.');
