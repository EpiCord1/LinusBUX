// In your functions/index.js file

const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

// OLD
// exports.giftBux = functions.https.onCall(async (data, context) => { ... });

// NEW: Chain the .region() method
exports.giftBux = functions.region('us-central1').https.onCall(async (data, context) => {
  // ... rest of your function code is exactly the same
  // 1. Authentication Check
  if (!context.auth) {
    throw new functions.https.HttpsError(
        "unauthenticated",
        "You must be logged in to send a gift.",
    );
  }
  // ... etc
});
