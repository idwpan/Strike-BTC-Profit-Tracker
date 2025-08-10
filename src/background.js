// Background script: responds to messages from content scripts with the
// current BTC/USD price fetched from Coindesk.

// Attempt to load the webextension polyfill. In Firefox the CI manifest loads
// it for us, so calling importScripts there would throw and is safely ignored.
try {
  importScripts("vendor/browser-polyfill.js");
} catch {
  // Polyfill already available; no action needed.
}

// Coindesk endpoint for the latest BTC price.
const COINDESK_URL =
  "https://data-api.coindesk.com/spot/v1/latest/tick?market=kraken&instruments=BTC-USD&apply_mapping=true";

// Listen for messages sent from other parts of the extension (e.g. content
// scripts or popup).
browser.runtime.onMessage.addListener(async (message) => {
  // Only handle messages requesting the BTC price.
  if (message?.type !== "GET_BTC_PRICE") return;

  try {
    // Fetch the latest BTC price from Coindesk.
    const response = await fetch(COINDESK_URL);
    const data = await response.json();

    // Use optional chaining and fallback to null if missing.
    const price = data?.Data?.["BTC-USD"]?.PRICE ?? null;

    // Returning an object from an async onMessage listener sends it as the
    // response to the sender.
    return { price };
  } catch (error) {
    console.error("Failed to fetch BTC price from background:", error);
    return { error: true };
  }
});
