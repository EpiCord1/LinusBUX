const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.database();
const INITIAL_BALANCE = 100;

/**
 * Sets up a new user's profile and initial balance when they first sign up.
 * This function is triggered by the client after a successful sign-up.
 */
exports.newUserSetup = functions.https.onCall(async (data, context) => {
  // Ensure the user is authenticated.
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "You must be logged in to create a profile."
    );
  }

  const uid = context.auth.uid;
  const email = context.auth.token.email || null;
  const userRef = db.ref(`/users/${uid}`);

  const snapshot = await userRef.once("value");
  if (snapshot.exists()) {
    // This prevents overwriting existing users' data.
    throw new functions.https.HttpsError(
      "already-exists",
      "This user profile has already been set up."
    );
  }

  // Set the initial user data.
  await userRef.set({
    email: email,
    balance: INITIAL_BALANCE,
    createdAt: admin.database.ServerValue.TIMESTAMP,
  });

  return { message: "User profile created successfully.", balance: INITIAL_BALANCE };
});


/**
 * Securely handles the gambling wheel spin.
 * The client sends a bet, the server validates it, determines the outcome,
 * and updates the balance atomically.
 */
exports.spinGambleWheel = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Authentication required.");
    }

    const uid = context.auth.uid;
    const bet = Number(data.bet);

    if (isNaN(bet) || !Number.isInteger(bet) || bet <= 0) {
        throw new functions.https.HttpsError("invalid-argument", "Invalid bet amount.");
    }

    const userBalanceRef = db.ref(`/users/${uid}/balance`);

    // Use a transaction to safely read and write the balance.
    const transactionResult = await userBalanceRef.transaction((currentBalance) => {
        if (currentBalance === null) {
            // This case should ideally not happen for a logged-in user.
            return;
        }
        if (currentBalance < bet) {
            // Abort the transaction if funds are insufficient.
            return; 
        }
        // Deduct the bet amount immediately.
        return currentBalance - bet;
    });

    if (!transactionResult.committed) {
        throw new functions.https.HttpsError("aborted", "Insufficient balance to place bet.");
    }
    
    // Server-side definition of wheel segments and multipliers.
    const segments = [
        { multiplier: 3, message: `YOU WON ${(bet * 3).toLocaleString()} BUX!`, type: "success" },
        { multiplier: 0, message: `You lost your bet of ${bet.toLocaleString()} BUX.`, type: "error" },
        { multiplier: 1.5, message: `YOU WON ${(bet * 1.5).toLocaleString()} BUX!`, type: "success" },
        { multiplier: -1, message: "BANKRUPT! You lost it all!", type: "error" }, // Special case
        { multiplier: 2, message: `YOU WON ${(bet * 2).toLocaleString()} BUX!`, type: "success" },
        { multiplier: 1/3, message: `You got back ${Math.floor(bet * (1/3)).toLocaleString()} BUX.`, type: "info" },
        { multiplier: 1, message: `Safe! Your bet of ${bet.toLocaleString()} BUX was returned.`, type: "info" },
        { multiplier: 0, message: `You lost your bet of ${bet.toLocaleString()} BUX.`, type: "error" },
    ];

    // Securely determine the winning index on the server.
    const winningIndex = Math.floor(Math.random() * segments.length);
    const winningSegment = segments[winningIndex];
    
    let finalMessage = winningSegment.message;
    let finalType = winningSegment.type;

    // Handle payout logic
    if (winningSegment.multiplier === -1) { // Bankrupt
        await userBalanceRef.set(0);
    } else if (winningSegment.multiplier > 0) {
        const winnings = Math.floor(bet * winningSegment.multiplier);
        await userBalanceRef.transaction(balance => (balance || 0) + winnings);
    }
    
    // Return the result to the client for display purposes.
    return {
        winningIndex: winningIndex,
        message: finalMessage,
        outcomeType: finalType
    };
});

/**
 * Securely transfers funds from one user to another using a transaction.
 */
exports.giftBux = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Authentication required.");
    }

    const senderUid = context.auth.uid;
    const recipientUid = data.recipientUid;
    const amount = Number(data.amount);

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

    // Transaction on the sender's balance
    const transactionResult = await senderRef.transaction((currentBalance) => {
        if (currentBalance >= amount) {
            return currentBalance - amount;
        } else {
            return; // Abort
        }
    });

    if (!transactionResult.committed) {
        throw new functions.https.HttpsError("aborted", "Insufficient funds to send gift.");
    }
    
    // If sender transaction was successful, increment recipient's balance.
    await recipientRef.transaction((currentBalance) => {
        return (currentBalance || 0) + amount;
    });

    return { message: `Successfully gifted ${amount.toLocaleString()} BUX!` };
});

// A more complex, stateful game like Blackjack would be structured like this.
// This is a simplified example. A full implementation would be more extensive.
exports.playBlackjack = functions.https.onCall(async (data, context) => {
     if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Authentication required.");
    }
    const uid = context.auth.uid;
    const { action, bet } = data;
    const sessionRef = db.ref(`/game_sessions/blackjack/${uid}`);
    const balanceRef = db.ref(`/users/${uid}/balance`);
    
    // This is a placeholder for a full state machine.
    // In a real app, you would have functions for createDeck, calculateScore, etc., here on the server.
    // The server would read the session, apply the action, and write the new state back.
    if (action === "deal") {
        const betAmount = Number(bet);
        if (isNaN(betAmount) || betAmount <= 0) {
            throw new functions.https.HttpsError("invalid-argument", "Invalid bet.");
        }
        
        // Transaction to place the bet
        const tx = await balanceRef.transaction(bal => (bal >= betAmount) ? bal - betAmount : undefined);
        if (!tx.committed) throw new functions.https.HttpsError("aborted", "Insufficient balance.");

        // SERVER-SIDE LOGIC: Create deck, deal cards, etc.
        const newState = {
            status: "in-progress",
            playerHand: [{suit: '♥', rank: 
