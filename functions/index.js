// NEW AND CORRECTED CODE
exports.giftBux = functions.https.onCall(async (data, context) => {
    // 1. Check for authentication. Firebase does this for you!
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "You must be logged in to gift bux.");
    }
    const senderUid = context.auth.uid;

    // 2. Data comes directly from the 'data' object, not req.body.data
    const { recipientUid, amount } = data;

    // 3. The rest of your logic remains largely the same.
    //    Instead of res.status().send(), you just return an object for success.
    if (!recipientUid || typeof recipientUid !== 'string') {
        throw new functions.https.HttpsError("invalid-argument", "Invalid recipient.");
    }
    if (isNaN(amount) || !Number.isInteger(amount) || amount <= 0) {
        throw new functions.https.HttpsError("invalid-argument", "Invalid gift amount.");
    }
    if (senderUid === recipientUid) {
        throw new functions.https.HttpsError("invalid-argument", "You cannot gift to yourself.");
    }

    const senderRef = db.ref(`/users/${senderUid}/balance`);
    const recipientRef = db.ref(`/users/${recipientUid}/balance`);

    try {
        const transactionResult = await senderRef.transaction((currentBalance) => {
            if (currentBalance >= amount) {
                return currentBalance - amount;
            }
            return; // Abort
        });

        if (!transactionResult.committed) {
            throw new functions.https.HttpsError("aborted", "Insufficient funds to send gift.");
        }
        
        await recipientRef.transaction((currentBalance) => (currentBalance || 0) + amount);

        // 4. On success, return a JavaScript object. This will be the `result.data` on the client.
        return { message: `Successfully gifted ${amount.toLocaleString()} BUX!` };

    } catch (error) {
        // If it's already an HttpsError, rethrow it. Otherwise, log and throw a generic one.
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        console.error("Error in giftBux transaction:", error);
        throw new functions.https.HttpsError("internal", "An error occurred while trying to gift bux.");
    }
});
