// server.js

const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

const app = express();

// --- IMPORTANT: Service Account Configuration ---
// This should be stored as an environment variable, not hardcoded.
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.DATABASE_URL // Make sure this is also an environment variable
});

const db = admin.database();

// --- Middleware ---
app.use(cors()); // Allow requests from your frontend
app.use(express.json()); // Allow the server to parse JSON request bodies

// Authentication Middleware to protect all sensitive routes
const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(403).send('Unauthorized: No token provided.');
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken; // Add the decoded user info to the request object
    next();
  } catch (error) {
    console.error('Error while verifying Firebase ID token:', error);
    res.status(403).send('Unauthorized: Invalid token.');
  }
};

// Apply authentication middleware to all /api routes
app.use('/api', verifyFirebaseToken);


// --- API Routes ---

// --- Balance & Codes ---

app.post("/api/create-code", async (req, res) => {
  const uid = req.user.uid;
  const amount = Number(req.body.amount);

  if (!amount || amount <= 0 || !Number.isInteger(amount)) {
    return res.status(400).json({ error: "A valid, positive integer amount is required." });
  }

  const userBalanceRef = db.ref(`/users/${uid}/balance`);

  try {
    const result = await userBalanceRef.transaction(currentBalance => {
      if (currentBalance === null || currentBalance < amount) {
        return; // Abort transaction if balance is null or insufficient
      }
      return currentBalance - amount;
    });

    if (!result.committed) {
      return res.status(400).json({ error: "Insufficient balance." });
    }

    const code = "LBX-" + Math.random().toString(36).substring(2, 10).toUpperCase();
    await db.ref(`/codes/${code}`).set({ amount: amount, createdBy: uid, isUsed: false, createdAt: admin.database.ServerValue.TIMESTAMP });

    res.status(200).json({ code: code });
  } catch (error) {
    console.error("Error creating code:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

app.post("/api/redeem-code", async (req, res) => {
    const uid = req.user.uid;
    const code = req.body.code.trim().toUpperCase();
    const codeRef = db.ref(`/codes/${code}`);

    try {
        const codeSnapshot = await codeRef.once('value');
        const codeData = codeSnapshot.val();

        if (!codeData) {
            return res.status(404).json({ error: "Code does not exist." });
        }
        if (codeData.isUsed) {
            return res.status(400).json({ error: "This code has already been redeemed." });
        }
        if (codeData.createdBy === uid) {
             return res.status(400).json({ error: "You cannot redeem your own code." });
        }
        
        // Use a transaction to prevent race conditions (two people redeeming at once)
        const transactionResult = await codeRef.transaction(currentCode => {
            if (currentCode && !currentCode.isUsed) {
                currentCode.isUsed = true;
                currentCode.redeemedBy = uid;
                currentCode.redeemedAt = admin.database.ServerValue.TIMESTAMP;
                return currentCode;
            }
            return; // Abort if already used
        });

        if (!transactionResult.committed) {
             return res.status(400).json({ error: "Code could not be redeemed, it may have been used just now." });
        }
        
        const redeemedAmount = transactionResult.snapshot.val().amount;
        const userBalanceRef = db.ref(`/users/${uid}/balance`);
        await userBalanceRef.transaction(currentBalance => (currentBalance || 0) + redeemedAmount);

        res.status(200).json({ message: `Successfully redeemed ${redeemedAmount.toLocaleString()} BUX!` });

    } catch (error) {
        console.error("Error redeeming code:", error);
        res.status(500).json({ error: "Internal server error." });
    }
});

// --- Gambling Games ---

app.post("/api/spin-wheel", async (req, res) => {
    const uid = req.user.uid;
    const bet = Number(req.body.bet);

    if (!bet || bet <= 0 || !Number.isInteger(bet)) {
        return res.status(400).json({ error: "A valid, positive integer bet is required." });
    }

    const userBalanceRef = db.ref(`/users/${uid}/balance`);

    try {
        // Atomically deduct the bet amount first.
        const betTransaction = await userBalanceRef.transaction(currentBalance => {
            if (currentBalance === null || currentBalance < bet) return;
            return currentBalance - bet;
        });

        if (!betTransaction.committed) {
            return res.status(400).json({ error: "Insufficient balance for the bet." });
        }

        // --- Server-side outcome generation ---
        const segments = [
            { color: '#d81b60', label: 'x3 BET', multiplier: 3 },
            { color: '#e53935', label: 'LOSE BET', multiplier: 0 },
            { color: '#43a047', label: 'x1.5 BET', multiplier: 1.5 },
            { color: '#c2185b', label: 'BANKRUPT', multiplier: -1 }, // Special case
            { color: '#7e57c2', label: 'x2 BET', multiplier: 2 },
            { color: '#fb8c00', label: '÷3 BET', multiplier: 1/3 },
            { color: '#00acc1', label: 'SAFE', multiplier: 1 },
            { color: '#e53935', label: 'LOSE BET', multiplier: 0 }
        ];
        
        const winningIndex = Math.floor(Math.random() * segments.length);
        const winningSegment = segments[winningIndex];

        let message = "";

        if (winningSegment.multiplier === -1) { // Bankrupt case
            const totalLoss = betTransaction.snapshot.val() + bet; // The balance *before* this spin
            await db.ref(`/users/${uid}`).update({ balance: 0 });
            message = `BANKRUPT! You lost all ${totalLoss.toLocaleString()} BUX!`;

        } else if (winningSegment.multiplier > 0) {
            const winnings = Math.floor(bet * winningSegment.multiplier);
            await userBalanceRef.transaction(currentBalance => currentBalance + winnings);
            
            if(winningSegment.multiplier > 1) message = `YOU WON ${winnings.toLocaleString()} BUX!`;
            else if(winningSegment.multiplier === 1) message = `Safe! Your bet of ${bet.toLocaleString()} was returned.`;
            else message = `You got back ${winnings.toLocaleString()} BUX.`;

        } else { // Multiplier is 0
            message = `You lost your bet of ${bet.toLocaleString()} BUX.`;
        }
        
        const finalBalance = (await userBalanceRef.once('value')).val();

        res.status(200).json({ winningIndex, message, finalBalance });

    } catch (error) {
        console.error("Error spinning wheel:", error);
        // Attempt to refund the bet if the game logic failed after deduction
        await userBalanceRef.transaction(currentBalance => (currentBalance || 0) + bet);
        res.status(500).json({ error: "A server error occurred. Your bet has been refunded." });
    }
});


// Blackjack Logic
const createDeck = () => {
    const suits = ['♥', '♦', '♠', '♣'];
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (const suit of suits) {
        for (const rank of ranks) {
            deck.push({ suit, rank, value: getCardValue(rank) });
        }
    }
    return deck;
};

const shuffleDeck = (deck) => {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

const getCardValue = (rank) => {
    if (['J', 'Q', 'K'].includes(rank)) return 10;
    if (rank === 'A') return 11; // Ace value is handled by calculateScore
    return parseInt(rank);
};

const calculateScore = (hand) => {
    let score = hand.reduce((sum, card) => sum + card.value, 0);
    let numAces = hand.filter(card => card.rank === 'A').length;
    while (score > 21 && numAces > 0) {
        score -= 10;
        numAces--;
    }
    return score;
};


app.post('/api/blackjack/deal', async (req, res) => {
    const uid = req.user.uid;
    const bet = Number(req.body.bet);
    const gameRef = db.ref(`/blackjack_games/${uid}`);

    if (!bet || bet <= 0 || !Number.isInteger(bet)) {
        return res.status(400).json({ error: "A valid, positive integer bet is required." });
    }

    try {
        const balanceRef = db.ref(`/users/${uid}/balance`);
        const transaction = await balanceRef.transaction(balance => {
            if (balance < bet) return;
            return balance - bet;
        });

        if (!transaction.committed) {
            return res.status(400).json({ error: "Insufficient balance." });
        }

        const deck = shuffleDeck(createDeck());
        const playerHand = [deck.pop(), deck.pop()];
        const dealerHand = [deck.pop(), deck.pop()];

        const gameState = {
            deck,
            playerHand,
            dealerHand,
            bet,
            playerScore: calculateScore(playerHand),
            status: 'playing'
        };

        await gameRef.set(gameState);
        
        const clientState = {
            ...gameState,
            dealerHand: [dealerHand[0], { rank: '?', suit: '?', value: 0 }], // Hide second card
            deck: null // Don't send the deck to the client
        };

        res.status(200).json(clientState);
    } catch (error) {
        console.error("Blackjack Deal Error:", error);
        res.status(500).json({ error: "Server error starting game." });
    }
});

app.post('/api/blackjack/hit', async (req, res) => {
    const uid = req.user.uid;
    const gameRef = db.ref(`/blackjack_games/${uid}`);

    try {
        const transaction = await gameRef.transaction(game => {
            if (!game || game.status !== 'playing') return;
            game.playerHand.push(game.deck.pop());
            game.playerScore = calculateScore(game.playerHand);
            if (game.playerScore > 21) {
                game.status = 'busted';
            }
            return game;
        });

        if (!transaction.committed) {
            return res.status(400).json({ error: "No active game found or game is over." });
        }

        const gameState = transaction.snapshot.val();
        
        if (gameState.status === 'busted') {
            await gameRef.remove(); // Clean up finished game
            return res.status(200).json({ status: 'busted', message: 'You Busted!', playerHand: gameState.playerHand, playerScore: gameState.playerScore });
        }

        res.status(200).json({ playerHand: gameState.playerHand, playerScore: gameState.playerScore });

    } catch (error) {
        console.error("Blackjack Hit Error:", error);
        res.status(500).json({ error: "Server error during hit." });
    }
});


app.post('/api/blackjack/stand', async (req, res) => {
    const uid = req.user.uid;
    const gameRef = db.ref(`/blackjack_games/${uid}`);
    const balanceRef = db.ref(`/users/${uid}/balance`);

    try {
        const gameSnapshot = await gameRef.once('value');
        let game = gameSnapshot.val();

        if (!game || game.status !== 'playing') {
            return res.status(400).json({ error: "No active game to stand on." });
        }

        // Dealer's turn logic
        let dealerScore = calculateScore(game.dealerHand);
        while(dealerScore < 17) {
            game.dealerHand.push(game.deck.pop());
            dealerScore = calculateScore(game.dealerHand);
        }

        // Determine winner and calculate payout
        let message = '';
        let payout = 0;
        const playerScore = calculateScore(game.playerHand);

        if (playerScore > 21) { // This case is handled by /hit, but as a safeguard
            message = 'You Busted!';
            payout = 0;
        } else if (dealerScore > 21) {
            message = 'Dealer Busts! You Win!';
            payout = game.bet * 2;
        } else if (dealerScore < playerScore) {
            message = 'You Win!';
            payout = game.bet * 2;
        } else if (dealerScore > playerScore) {
            message = 'Dealer Wins!';
            payout = 0;
        } else {
            message = 'Push!';
            payout = game.bet;
        }

        if (payout > 0) {
            await balanceRef.transaction(balance => balance + payout);
        }

        await gameRef.remove(); // Clean up finished game

        res.status(200).json({
            status: 'finished',
            message,
            dealerHand: game.dealerHand,
            dealerScore
        });

    } catch (error) {
        console.error("Blackjack Stand Error:", error);
        res.status(500).json({ error: "Server error during stand." });
    }
});


// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
