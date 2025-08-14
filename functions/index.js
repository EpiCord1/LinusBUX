const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.database();

/**
 * Creates a gift code that can be redeemed by another user.
 */
exports.createGiftCode = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "You must be logged in to create a code.");
    }

    const amount = data.amount;
    if (!Number.isInteger(amount) || amount <= 0) {
        throw new functions.https.HttpsError("invalid-argument", "Invalid amount.");
    }

    const uid = context.auth.uid;
    const userBalanceRef = db.ref(`/users/${uid}/balance`);
    const codesRef = db.ref("/gift_codes");

    const userBalanceSnap = await userBalanceRef.once("value");
    if (userBalanceSnap.val() < amount) {
        throw new functions.https.HttpsError("failed-precondition", "Insufficient balance to create code.");
    }

    // Generate a unique, readable code
    const code = "LBX-" + Math.random().toString(36).substring(2, 8).toUpperCase();

    // Store the code with its value and creator
    await codesRef.child(code).set({
        amount: amount,
        creatorUid: uid,
    });

    // Deduct the amount from the user's balance
    await userBalanceRef.set(admin.database.ServerValue.increment(-amount));

    return { code: code };
});

/**
 * Redeems a gift code, adding the balance to the user and deleting the code.
 */
exports.redeemGiftCode = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "You must be logged in to redeem a code.");
    }

    const code = data.code.toUpperCase();
    const uid = context.auth.uid;
    const codeRef = db.ref(`/gift_codes/${code}`);

    // Use a transaction to safely redeem the code
    const result = await codeRef.transaction(codeData => {
        if (codeData === null) {
            // Code does not exist
            return; // Abort transaction
        }
        if (codeData.creatorUid === uid) {
            // User trying to redeem their own code
            throw new functions.https.HttpsError("failed-precondition", "You cannot redeem your own code.");
        }
        // If we got this far, the code is valid. "Remove" it by returning null.
        return null;
    });

    if (!result.committed) {
         // The transaction was aborted, likely because the code didn't exist
         throw new functions.https.HttpsError("not-found", "Invalid or already redeemed code.");
    }
    
    const redeemedCodeData = result.snapshot.val();
    const amount = redeemedCodeData.amount;

    // Add the balance to the redeeming user
    const userBalanceRef = db.ref(`/users/${uid}/balance`);
    await userBalanceRef.set(admin.database.ServerValue.increment(amount));

    return { amount: amount };
});


/**
 * Securely spins the gambling wheel.
 */
exports.spinTheWheel = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "You must be logged in.");
    }

    const bet = data.bet;
    if (!Number.isInteger(bet) || bet <= 0) {
        throw new functions.https.HttpsError("invalid-argument", "Invalid bet amount.");
    }

    const uid = context.auth.uid;
    const userBalanceRef = db.ref(`/users/${uid}/balance`);
    const balanceSnap = await userBalanceRef.once("value");
    const currentBalance = balanceSnap.val();

    if (currentBalance < bet) {
        throw new functions.https.HttpsError("failed-precondition", "Insufficient balance.");
    }
    
    // Deduct the initial bet first
    await userBalanceRef.set(currentBalance - bet);

    const segments = [
        { label: 'x3 BET', multiplier: 3 }, { label: 'LOSE BET', multiplier: 0 },
        { label: 'x1.5 BET', multiplier: 1.5 }, { label: 'BANKRUPT', multiplier: -1 },
        { label: 'x2 BET', multiplier: 2 }, { label: '÷3 BET', multiplier: 1/3 },
        { label: 'SAFE', multiplier: 1 }, { label: 'LOSE BET', multiplier: 0 }
    ];
    
    const winningIndex = Math.floor(Math.random() * segments.length);
    const winningSegment = segments[winningIndex];
    
    let payout = 0;
    let message = "";
    let outcome = "neutral";

    if (winningSegment.multiplier === -1) { // Bankrupt
        await db.ref(`/users/${uid}/balance`).set(0); // Set balance to 0
        message = `BANKRUPT! You lost everything!`;
        outcome = "bankrupt";
    } else {
        payout = Math.floor(bet * winningSegment.multiplier);
        await userBalanceRef.set(admin.database.ServerValue.increment(payout));
        
        if (payout > bet) {
            message = `You won ${payout.toLocaleString()} BUX on "${winningSegment.label}"!`;
            outcome = "win";
        } else if (payout < bet && payout > 0) {
             message = `You only got ${payout.toLocaleString()} BUX back.`;
             outcome = "neutral";
        } else if (payout === bet) {
            message = `Safe! Your bet was returned.`;
            outcome = "neutral";
        } else {
            message = `You lost your bet.`;
            outcome = "loss";
        }
    }
    
    const segAngleDeg = 360 / segments.length;
    const finalRotation = (360 - (winningIndex * segAngleDeg)) - (segAngleDeg / 2);

    return { finalRotation, message, outcome };
});

// NOTE: A full server-side Blackjack implementation is complex.
// This is a simplified example showing how to manage state.
// You would need to build out the full logic for deck creation, etc.
exports.dealBlackjack = functions.https.onCall(async (data, context) => {
    // ... Full logic to create a deck, deal hands, save to a new 'active_games' DB path ...
    // This is a placeholder for the logic.
    return {
        isGameOver: true,
        message: "Blackjack function is not fully implemented yet.",
        playerHand: { cards: [], score: 0 },
        dealerHand: { cards: [], score: 0 },
        canDouble: false,
    };
});
exports.hitBlackjack = functions.https.onCall(async (data, context) => { /* ... */ });
exports.standBlackjack = functions.https.onCall(async (data, context) => { /* ... */ });
