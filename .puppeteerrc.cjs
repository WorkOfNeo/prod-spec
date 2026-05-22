// Pin Puppeteer's Chromium download to a project-local cache.
// Puppeteer's default (~/.cache/puppeteer) can land outside the deploy
// artifact in some environments; keeping it under the project root
// guarantees the binary travels with the app.
// Docs: https://pptr.dev/guides/configuration
const { join } = require("path");

module.exports = {
  cacheDirectory: join(__dirname, ".cache", "puppeteer"),
};
