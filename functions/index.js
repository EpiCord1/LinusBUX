const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { v4: uuidv4 } = require('uuid');

admin.initializeApp();
const db = admin.database();
const INITIAL_BALANCE = 100;

// This helper function is no longer needed with onCall functions.
// const getAuthenticatedUid = async (authorizationHeader) => { ... };

// --- CORRECTED onCall FUNCTIONS ---

exports.newUserSetup = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "You must be logged in to create a profile.");
    }
    const uid = context.auth.uid;
    const email = context.auth.token.email || null; // Email is available in the token context

    const userRef = db.ref(`/users/${uid}`);
    const snapshot = await userRef.once("value");

    if (snapshot.exists()) {
        // This is not an error, just means they already exist.
        // The client-side listener will pick up their balance.
        return { message: "User profile already exists." };
    }

    await userRef.set({
        email: email,
        balance: INITIAL_BALANCE,
        createdAt: admin.database.ServerValue.TIMESTAMP,
    });

    return { message: "User profile created successfully.", balance: INITIAL_BALANCE };
});

exports.spinGambleWheel = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "You must be logged in to gamble.");
    }
    const uid = context.auth.uid;
    const bet = Number(data.bet);

    if (isNaN(bet) || !Number.isInteger(bet) || bet <= 0) {
        throw new functions.https.HttpsError("invalid-argument", "Invalid bet amount.");
    }

    const userBalanceRef = db.ref(`/users/${uid}/balance`);
    const transactionResult = await userBalanceRef.transaction((currentBalance) => {
        if (currentBalance === null || currentBalance < bet) { return; } // Abort
        return currentBalance - bet;
    });

    if (!transactionResult.committed) {
        throw new functions.https.HttpsError("aborted", "Insufficient balance to place bet.");
    }

    const segments = [
        { multiplier: 3, message: `YOU WON ${(bet * 3).toLocaleString()} BUX!`, type: "success" },
        { multiplier: 0, message: `You lost your bet of ${bet.toLocaleString()} BUX.`, type: "error" },
        { multiplier: 1.5, message: `YOU WON ${(bet * 1.5).toLocaleString()} BUX!`, type: "success" },
        { multiplier: -1, message: "BANKRUPT! You lost it all!", type: "error" },
        { multiplier: 2, message: `YOU WON ${(bet * 2).toLocaleString()} BUX!`, type: "success" },
        { multiplier: 1/3, message: `You got back ${Math.floor(bet * (1/3)).toLocaleString()} BUX.`, type: "info" },
        { multiplier: 1, message: `Safe! Your bet of ${bet.toLocaleString()} BUX was returned.`, type: "info" },
        { multiplier: 0, message: `You lost your bet of ${bet.toLocaleString()} BUX.`, type: "error" },
    ];

    const winningIndex = Math.floor(Math.random() * segments.length);
    const winningSegment = segments[winningIndex];

    if (winningSegment.multiplier === -1) {
        await userBalanceRef.set(0);
    } else if (winningSegment.multiplier > 0) {
        const winnings = Math.floor(bet * winningSegment.multiplier);
        await userBalanceRef.transaction(balance => (balance || 0) + winnings);
    }

    // Return the result object
    return {
        winningIndex: winningIndex,
        message: winningSegment.message,
        outcomeType: winningSegment.type
    };
});

exports.giftBux = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "You must be logged in to gift bux.");
    }
    const senderUid = context.auth.uid;
    const { recipientUid, amount } = data;

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

    return { message: `Successfully gifted ${amount.toLocaleString()} BUX!` };
});

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
    const transactionResult = await userBalanceRef.transaction((currentBalance) => {
        if (currentBalance === null || currentBalance < amount) { return; }
        return currentBalance - amount;
    });

    if (!transactionResult.committed) {
        throw new functions.https.HttpsError("aborted", "Insufficient balance to create code.");
    }

    const code = `LBX-${uuidv4().split('-')[0].toUpperCase()}`;
    const codeRef = db.ref(`/redemptionCodes/${code}`);
    await codeRef.set({ amount: amount, createdBy: uid, createdAt: admin.database.ServerValue.TIMESTAMP });

    return { message: `Code ${code} created for ${amount.toLocaleString()} BUX!`, code: code };
});

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
    const codeSnapshot = await codeRef.once("value");

    if (!codeSnapshot.exists()) {
        throw new functions.https.HttpsError("not-found", "This code is invalid or has already been used.");
    }

    const codeData = codeSnapshot.val();
    const amount = codeData.amount;
    
    // Atomically update balance and remove the code
    const userBalanceRef = db.ref(`/users/${uid}/balance`);
    await userBalanceRef.transaction(balance => (balance || 0) + amount);
    await codeRef.remove();

    return { message: `Successfully redeemed ${amount.toLocaleString()} BUX!` };
});

// Note: The Blackjack function still needs to be implemented.
exports.playBlackjack = functions.https.onCall(async (data, context) => {
    // Check for auth
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "You must be logged in to play.");
    }
    // When you implement this, all game logic (shuffling, dealing, hitting) MUST be done here.
    // The server is the single source of truth for the game state.
    throw new functions.https.HttpsError("unimplemented", "Blackjack function not implemented yet.");
});
