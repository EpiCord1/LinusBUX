const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { v4: uuidv4 } = require('uuid');

// NEW: Import and configure the CORS middleware
const cors = require("cors")({ origin: true });

admin.initializeApp();
const db = admin.database();
const INITIAL_BALANCE = 100;

// Helper function to verify Firebase ID token
const getAuthenticatedUid = async (authorizationHeader) => {
    if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
        throw new functions.https.HttpsError("unauthenticated", "Unauthorized");
    }
    const idToken = authorizationHeader.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        return decodedToken.uid;
    } catch (error) {
        throw new functions.https.HttpsError("unauthenticated", "Unauthorized");
    }
};


// --- UPDATED FUNCTIONS ---

exports.newUserSetup = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        try {
            const uid = await getAuthenticatedUid(req.headers.authorization);
            const userRef = db.ref(`/users/${uid}`);
            const snapshot = await userRef.once("value");

            if (snapshot.exists()) {
                throw new functions.https.HttpsError("already-exists", "This user profile has already been set up.");
            }

            // Note: We can't get the email from the token in this context without extra permissions.
            // It's better to have the client provide it or look it up. For now, we'll set it as null.
            await userRef.set({
                email: req.body.data.email || null, // Assuming client sends it
                balance: INITIAL_BALANCE,
                createdAt: admin.database.ServerValue.TIMESTAMP,
            });

            res.status(200).send({ data: { message: "User profile created successfully.", balance: INITIAL_BALANCE } });
        } catch (error) {
            console.error("Error in newUserSetup:", error);
            res.status(error.httpErrorCode ? error.httpErrorCode.status : 500).send({ error: { message: error.message } });
        }
    });
});


exports.spinGambleWheel = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        try {
            const uid = await getAuthenticatedUid(req.headers.authorization);
            const bet = Number(req.body.data.bet);

            if (isNaN(bet) || !Number.isInteger(bet) || bet <= 0) {
                throw new functions.https.HttpsError("invalid-argument", "Invalid bet amount.");
            }

            const userBalanceRef = db.ref(`/users/${uid}/balance`);
            const transactionResult = await userBalanceRef.transaction((currentBalance) => {
                if (currentBalance === null || currentBalance < bet) { return; }
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

            res.status(200).send({ data: {
                winningIndex: winningIndex,
                message: winningSegment.message,
                outcomeType: winningSegment.type
            }});

        } catch (error) {
            console.error("Error in spinGambleWheel:", error);
            res.status(error.httpErrorCode ? error.httpErrorCode.status : 500).send({ error: { message: error.message } });
        }
    });
});

exports.giftBux = functions.https.onRequest((req, res) => {
    // This function wraps our logic. It handles the OPTIONS request and adds CORS headers.
    cors(req, res, async () => {
        try {
            // Manually verify the user's token from the request headers
            const senderUid = await getAuthenticatedUid(req.headers.authorization);
            
            // The Firebase client SDK wraps the payload in a 'data' object
            const { recipientUid, amount } = req.body.data;

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

            // Send a successful response back to the client
            res.status(200).send({ data: { message: `Successfully gifted ${amount.toLocaleString()} BUX!` } });

        } catch (error) {
            console.error("Error in giftBux:", error);
            // Send an error response
            const status = error.httpErrorCode ? error.httpErrorCode.status : 500;
            res.status(status).send({ error: { message: error.message } });
        }
    });
});


// Note: The Blackjack function is complex and would also need this conversion.
// This is left as an exercise but would follow the exact same pattern as the functions above.
exports.playBlackjack = functions.https.onRequest((req, res) => {
     cors(req, res, async () => {
        // ... conversion logic here, using getAuthenticatedUid and req.body.data ...
        res.status(501).send({ error: { message: "Blackjack function not implemented for onRequest yet." } });
     });
});


exports.createRedemptionCode = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        try {
            const uid = await getAuthenticatedUid(req.headers.authorization);
            const amount = Number(req.body.data.amount);

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

            res.status(200).send({ data: { message: `Code ${code} created for ${amount.toLocaleString()} BUX!`, code: code } });
        } catch (error) {
            console.error("Error in createRedemptionCode:", error);
            res.status(error.httpErrorCode ? error.httpErrorCode.status : 500).send({ error: { message: error.message } });
        }
    });
});


exports.redeemCode = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        try {
            const uid = await getAuthenticatedUid(req.headers.authorization);
            const code = req.body.data.code;

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

            await userBalanceRef.transaction(balance => (balance || 0) + amount);
            await codeRef.remove();

            res.status(200).send({ data: { message: `Successfully redeemed ${amount.toLocaleString()} BUX!` } });
        } catch (error) {
            console.error("Error in redeemCode:", error);
            res.status(error.httpErrorCode ? error.httpErrorCode.status : 500).send({ error: { message: error.message } });
        }
    });
});
