// Add this to your functions/index.js file

const { v4: uuidv4 } = require('uuid'); // Add this to the top with other requires

/**
 * Securely creates a redemption code.
 * Deducts the amount from the user's balance and stores a single-use code in the database.
 */
exports.createRedemptionCode = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Authentication required.");
    }

    const uid = context.auth.uid;
    const amount = Number(data.amount);

    if (isNaN(amount) || !Number.isInteger(amount) || amount <= 0) {
        throw new functions.https.HttpsError("invalid-argument", "Invalid code amount.");
    }

    const userBalanceRef = db.ref(`/users/${uid}/balance`);
    
    // Use a transaction to safely deduct the balance
    const transactionResult = await userBalanceRef.transaction((currentBalance) => {
        if (currentBalance === null || currentBalance < amount) {
            return; // Abort transaction
        }
        return currentBalance - amount;
    });

    if (!transactionResult.committed) {
        throw new functions.https.HttpsError("aborted", "Insufficient balance to create code.");
    }

    // Generate a unique, secure code
    const code = `LBX-${uuidv4().split('-')[0].toUpperCase()}`;
    const codeRef = db.ref(`/redemptionCodes/${code}`);

    // Store the code with its value and the creator's UID
    await codeRef.set({
        amount: amount,
        createdBy: uid,
        createdAt: admin.database.ServerValue.TIMESTAMP
    });

    return { message: `Code ${code} created for ${amount.toLocaleString()} BUX!`, code: code };
});


/**
 * Securely redeems a code.
 * Validates the code, transfers the balance, and deletes the code to prevent reuse.
 */
exports.redeemCode = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Authentication required.");
    }
    
    const uid = context.auth.uid;
    const code = data.code;

    if (!code || typeof code !== 'string') {
        throw new functions.https.HttpsError("invalid-argument", "Invalid code provided.");
    }

    const codeRef = db.ref(`/redemptionCodes/${code}`);
    const snapshot = await codeRef.once("value");

    if (!snapshot.exists()) {
        throw new functions.https.HttpsError("not-found", "This code is invalid or has already been used.");
    }

    const codeData = snapshot.val();
    const amount = codeData.amount;
    const userBalanceRef = db.ref(`/users/${uid}/balance`);

    // Atomically add balance to the user and delete the code
    await userBalanceRef.transaction(balance => (balance || 0) + amount);
    await codeRef.remove(); // Delete the code so it cannot be used again

    return { message: `Successfully redeemed ${amount.toLocaleString()} BUX!` };
});
