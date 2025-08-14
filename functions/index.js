const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

// This is a "Callable Function", which means it can be called directly
// from your client-side code and automatically handles authentication.
exports.giftBux = functions.https.onCall(async (data, context) => {
  // 1. Authentication Check: Ensure the user is logged in.
  if (!context.auth) {
    throw new functions.https.HttpsError(
        "unauthenticated",
        "You must be logged in to send a gift.",
    );
  }

  // 2. Input Validation: Check for required data from the client.
  const senderUid = context.auth.uid;
  const {recipientUid, amount} = data;
  const parsedAmount = parseInt(amount, 10);

  if (!recipientUid || typeof recipientUid !== "string") {
    throw new functions.https.HttpsError(
        "invalid-argument",
        "A valid recipient ID must be provided.",
    );
  }

  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    throw new functions.https.HttpsError(
        "invalid-argument",
        "A valid, positive amount must be provided.",
    );
  }

  if (senderUid === recipientUid) {
    throw new functions.https.HttpsError(
        "invalid-argument",
        "You cannot send a gift to yourself.",
    );
  }


  // 3. Secure Transaction: Perform the transfer using admin privileges.
  const usersRef = admin.database().ref("/users");

  try {
    await usersRef.transaction((usersNode) => {
      // If the node doesn't exist, abort.
      if (usersNode === null) {
        return;
      }

      const senderNode = usersNode[senderUid];
      const recipientNode = usersNode[recipientUid];

      // If either user doesn't exist in the database, abort.
      if (!senderNode || !recipientNode) {
        // We throw an error inside the transaction to abort it.
        // This will be caught by the outer try/catch block.
        throw new Error("Sender or recipient not found.");
      }

      // Check if the sender has enough balance.
      if (senderNode.balance < parsedAmount) {
        // Abort the transaction by returning without modification.
        // The client will get a specific message for this case.
        return;
      }

      // Perform the transfer.
      usersNode[senderUid].balance -= parsedAmount;
      usersNode[recipientUid].balance += parsedAmount;

      return usersNode; // Commit the changes.
    });

    // If the transaction succeeds, return a success message.
    return {
      success: true,
      message: `Successfully gifted ${parsedAmount.toLocaleString()} BUX!`,
    };
  } catch (error) {
    // This catches errors from within the transaction (like user not found).
    console.error("Gifting transaction failed:", error);
    // If the error message is our custom one, use it.
    if (error.message === "Sender or recipient not found.") {
      throw new functions.https.HttpsError("not-found", error.message);
    }
    // For other errors, throw a generic error.
    throw new functions.https.HttpsError(
        "internal",
        "The gift could not be sent due to an internal error.",
    );
  }
});
