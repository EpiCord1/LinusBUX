const functions = require("firebase-functions");
const admin = require("firebase-admin");

// Use the standard initialization method. This is the most reliable way inside a Cloud Function.
admin.initializeApp();

const db = admin.database();

/**
 * Creates a gift code that can be redeemed by another user.
 */
exports.createGiftCode = functions.https.onCall(async (data, context) => {
    // Step 1: Log the start and check for authentication
    functions.logger.info("createGiftCode: Function started.", { auth: context.auth });
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "You must be logged in.");
    }

    try {
        // Step 2: Validate the amount from the client
        const amount = data.amount;
        if (!Number.isInteger(amount) || amount <= 0) {
            throw new functions.https.HttpsError("invalid-argument", "A valid amount is required.");
        }

        const uid = context.auth.uid;
        const userBalanceRef = db.ref(`/users/${uid}/balance`);
        
        // Step 3: Get the user's current balance securely from the server
        functions.logger.info(`createGiftCode: Checking balance for user ${uid}`);
        const userBalanceSnap = await userBalanceRef.once("value");
        if (!userBalanceSnap.exists() || userBalanceSnap.val() < amount) {
            throw new functions.https.HttpsError("failed-precondition", "Insufficient balance.");
        }

        // Step 4: Generate code and update database
        const code = "LBX-" + Math.random().toString(36).substring(2, 8).toUpperCase();
        functions.logger.info(`createGiftCode: Generated code ${code} for user ${uid}`);

        await db.ref(`/gift_codes/${code}`).set({
            amount: amount,
            creatorUid: uid,
        });

        await userBalanceRef.set(admin.database.ServerValue.increment(-amount));
        
        // Step 5: Log success and return to client
        functions.logger.info(`createGiftCode: Successfully created code ${code}`);
        return { code: code };

    } catch (error) {
        functions.logger.error("createGiftCode: An error occurred!", error);
        if (error instanceof functions.https.HttpsError) throw error;
        throw new functions.https.HttpsError("internal", "An unexpected error occurred.");
    }
});

/**
 * Redeems a gift code. This version is simplified to be more robust.
 */
exports.redeemGiftCode = functions.https.onCall(async (data, context) => {
    functions.logger.info("redeemGiftCode: Function started.", { auth: context.auth });
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "You must be logged in.");
    }
    
    try {
        const code = data.code ? data.code.trim().toUpperCase() : '';
        if (!code) {
             throw new functions.https.HttpsError("invalid-argument", "Please provide a code.");
        }

        const uid = context.auth.uid;
        const codeRef = db.ref(`/gift_codes/${code}`);

        // We use a transaction here because it's the only way to guarantee
        // that two people can't redeem the same code at the exact same time.
        const { committed, snapshot } = await codeRef.transaction(codeData => {
            if (codeData === null) {
                return; // Code doesn't exist, abort transaction
            }
            if (codeData.creatorUid === uid) {
                // Throwing an error inside a transaction aborts it.
                // We'll wrap this in a way the client can understand.
                return { error: "self-redeem" };
            }
            // If the code is valid, "delete" it by returning null.
            return null;
        });

        if (!committed) {
            // If the transaction aborted because the code didn't exist (was null)
            throw new functions.https.HttpsError("not-found", "Invalid or already used code.");
        }
        
        const redeemedData = snapshot.val();
        
        // Check for our custom error from inside the transaction
        if (redeemedData && redeemedData.error === "self-redeem") {
             throw new functions.https.HttpsError("failed-precondition", "You cannot redeem your own code.");
        }

        // If we get here, the code was valid and has now been deleted.
        const amount = redeemedData.amount;
        await db.ref(`/users/${uid}/balance`).set(admin.database.ServerValue.increment(amount));

        functions.logger.info(`redeemGiftCode: Successfully redeemed ${amount} for user ${uid}`);
        return { amount: amount };

    } catch (error) {
        functions.logger.error("redeemGiftCode: An error occurred!", error);
        if (error instanceof functions.https.HttpsError) throw error;
        throw new functions.https.HttpsError("internal", "An unexpected error occurred.");
    }
});

/**
 * Securely spins the gambling wheel.
 */
exports.spinTheWheel = functions.https.onCall(async (data, context) => {
    functions.logger.info("spinTheWheel: Function started.", { auth: context.auth });
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "You must be logged in.");
    }

    try {
        const bet = data.bet;
        if (!Number.isInteger(bet) || bet <= 0) {
            throw new functions.https.HttpsError("invalid-argument", "Invalid bet amount.");
        }

        const uid = context.auth.uid;
        const userBalanceRef = db.ref(`/users/${uid}/balance`);
        
        functions.logger.info(`spinTheWheel: Checking balance for user ${uid}`);
        const balanceSnap = await userBalanceRef.once("value");
        const currentBalance = balanceSnap.val();

        if (currentBalance < bet) {
            throw new functions.https.HttpsError("failed-precondition", "Insufficient balance.");
        }
        
        // Deduct the bet first
        await userBalanceRef.set(admin.database.ServerValue.increment(-bet));

        const segments = [
            { label: 'x3 BET', multiplier: 3 }, { label: 'LOSE BET', multiplier: 0 },
            { label: 'x1.5 BET', multiplier: 1.5 }, { label: 'BANKRUPT', multiplier: -1 },
            { label: 'x2 BET', multiplier: 2 }, { label: '÷3 BET', multiplier: 1/3 },
            { label: 'SAFE', multiplier: 1 }, { label: 'LOSE BET', multiplier: 0 }
        ];
        
        const winningIndex = Math.floor(Math.random() * segments.length);
        const winningSegment = segments[winningIndex];
        
        let message = "";
        let outcome = "neutral";
        let payout = 0;

        if (winningSegment.multiplier === -1) {
            // For BANKRUPT, the payout is the negative of the user's balance *after* the bet was placed.
            const balanceAfterBet = currentBalance - bet;
            payout = -balanceAfterBet;
            message = `BANKRUPT! You lost everything!`;
            outcome = "bankrupt";
        } else {
            payout = Math.floor(bet * winningSegment.multiplier);
             if (payout > bet) { message = `You won ${payout.toLocaleString()} BUX!`; outcome = "win"; } 
             else if (payout === bet) { message = `Safe! Your bet was returned.`; outcome = "neutral"; }
             else { message = `You lost your bet.`; outcome = "loss"; }
        }
        
        // Add the payout (which could be negative for bankrupt) to the balance.
        await userBalanceRef.set(admin.database.ServerValue.increment(payout));
        
        const segAngleDeg = 360 / segments.length;
        const finalRotation = (360 - (winningIndex * segAngleDeg)) - (segAngleDeg / 2);

        functions.logger.info(`spinTheWheel: Result for ${uid}: ${message}`);
        return { finalRotation, message, outcome };

    } catch (error) {
        functions.logger.error("spinTheWheel: An error occurred!", error);
        if (error instanceof functions.https.HttpsError) throw error;
        throw new functions.https.HttpsError("internal", "An unexpected error occurred.");
    }
});
