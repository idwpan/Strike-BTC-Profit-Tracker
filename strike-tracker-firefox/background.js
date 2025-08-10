// Listen for messages sent from other parts of the extension (e.g. content scripts or popup)
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // Only handle messages requesting the BTC price
    if (message.type !== "GET_BTC_PRICE") return;

    // Define and immediately invoke an async function inside the listener
    // This avoids making the listener itself async (which breaks sendResponse in MV2)
    (async () => {
        try {
            // Make the API request to fetch the latest BTC price from Coindesk
            const res = await fetch("https://data-api.coindesk.com/spot/v1/latest/tick?market=kraken&instruments=BTC-USD&apply_mapping=true");

            // Parse the JSON response
            const data = await res.json();

            // Use optional chaining and fallback to null if missing
            const price = data?.Data?.["BTC-USD"]?.PRICE ?? null;

            // Send the price back to the original message sender
            sendResponse({ price });
        } catch (error) {
            // Log the error for debugging
            console.error("Failed to fetch BTC price from background:", error);

            // Respond with an error flag
            sendResponse({ error: true });
        }
    })();

    // Return true to tell the browser we’ll send a response asynchronously
    return true;
});
