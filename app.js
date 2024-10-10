import express from "express";
import axios from "axios";
import {
	Connection,
	PublicKey,
	Keypair,
	Transaction,
	SystemProgram,
	sendAndConfirmTransaction,
	LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
	TOKEN_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
	getAssociatedTokenAddress,
	getAccount,
	createAssociatedTokenAccountInstruction,
	createTransferInstruction,
	getMint,
} from "@solana/spl-token";
import bs58 from "bs58";
import pRetry from "p-retry";
import nacl from "tweetnacl";
import { configDotenv } from "dotenv";
import mongoose from "mongoose";
import TransactionMongo from "./models/transaction.js";
import FailedTransaction from "./models/failedTransaction.js";
import cron from "node-cron";
import cors from "cors";
configDotenv();

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const _rpc = `https://mainnet.helius-rpc.com/?api-key=1594af8d-9d2e-4bad-8feb-ff8678480d91`; //mainnet
const connection = new Connection(_rpc);
const tokenMintAddress = new PublicKey(
	"mX8c9EF1Sq7CAiBd9H3FQ6LUnKFqheWNSayVTi2rBrb"
);
const privateKey = process.env.SOLANA_PRIVATE_KEY;
const pkInBytes = bs58.decode(privateKey);
const feePayer = Keypair.fromSecretKey(pkInBytes);
const receiver = "2DG2dYw1r4bhHiaANYkKbQvsqz8PVmz5j2WqzUJANek4"; // change this to the receiver's wallet address
let solanaUsdPrice = 0;
async function getOrCreateAssociatedTokenAccount(
	connection,
	payer,
	mint,
	owner,
	allowOwnerOffCurve = false,
	commitment = "finalized",
	programId = TOKEN_PROGRAM_ID,
	associatedTokenProgramId = ASSOCIATED_TOKEN_PROGRAM_ID
) {
	// Ensure mint and owner are PublicKey instances
	if (!(mint instanceof PublicKey)) {
		mint = new PublicKey(mint);
	}
	if (!(owner instanceof PublicKey)) {
		owner = new PublicKey(owner);
	}

	const associatedToken = await getAssociatedTokenAddress(
		mint,
		owner,
		allowOwnerOffCurve,
		programId,
		associatedTokenProgramId
	);

	try {
		const account = await getAccount(
			connection,
			associatedToken,
			commitment,
			programId
		);
		return account;
	} catch (error) {
		console.log("No Associate account found, creating one");
		try {
			const transaction = new Transaction().add(
				createAssociatedTokenAccountInstruction(
					payer.publicKey, // Ensure payer is a Keypair and use its publicKey
					associatedToken,
					owner,
					mint,
					programId,
					associatedTokenProgramId
				)
			);
			const blockHash = await connection.getLatestBlockhash();
			transaction.feePayer = payer.publicKey;
			transaction.recentBlockhash = blockHash.blockhash;
			const signature = await sendAndConfirmTransaction(
				connection,
				transaction,
				[payer] // Use payer instead of feePayer
			);
			console.log("signature", signature);

			await connection.confirmTransaction({
				signature: signature,
				lastValidBlockHeight: blockHash.lastValidBlockHeight,
				blockhash: blockHash.blockhash,
			});
		} catch (error) {
			console.log("catch2", error);
		}

		// Now this should always succeed
		const account = await getAccount(
			connection,
			associatedToken,
			commitment,
			programId
		);

		return account;
	}
}
async function transferTokens(toPublicKey, transactionHash, signature) {
	let solanaAmount = 0;
	try {
		const fetchedTransaction = await fetchTransactionMetadata(transactionHash);
		const recieverBC =
			fetchedTransaction.transaction.message.accountKeys[1].toBase58();
		const senderBC =
			fetchedTransaction.transaction.message.accountKeys[0].toBase58();

		const transactionTime = fetchedTransaction.slot;
		if (
			recieverBC.toLowerCase() != receiver.toLowerCase() ||
			senderBC.toLowerCase() != toPublicKey.toBase58().toLowerCase()
		) {
			return "Invalid Transaction";
		}
		const totalAmount =
			fetchedTransaction.meta.preBalances[0] -
			fetchedTransaction.meta.postBalances[0];
		solanaAmount =
			Math.abs(totalAmount - fetchedTransaction.meta.fee) / LAMPORTS_PER_SOL;

		console.log(`Solana sent to ${receiver.toLowerCase()}:`, solanaAmount);
		// Get the current Solana price
		const solanaPriceResponse = await axios.get(
			"https://api.dexscreener.com/latest/dex/pairs/bsc/0x9f5a0ad81fe7fd5dfb84ee7a0cfb83967359bd90"
		);
		solanaUsdPrice = Number(solanaPriceResponse.data.pair.priceUsd);
		// Calculate the number of tokens to send
		const usdAmount = Number(solanaAmount) * Number(solanaUsdPrice);
		const tokensToSend = usdAmount / 0.0001;
		const tokenInLamports = (Number(tokensToSend) * 10 ** 8).toFixed(0);
		const toTokenAccount = await getOrCreateAssociatedTokenAccount(
			connection,
			feePayer,
			tokenMintAddress,
			toPublicKey
		);
		console.log("toTokenAccount", toTokenAccount.address.toBase58());

		const fromTokenAccount = await getOrCreateAssociatedTokenAccount(
			connection,
			feePayer,
			tokenMintAddress,
			feePayer.publicKey
		);
		console.log("fromTokenAccount", fromTokenAccount.address.toBase58());
		let Token_wallet_address = new PublicKey(fromTokenAccount.address);

		const info = await getAccount(connection, Token_wallet_address);
		const amount1 = Number(info.amount);
		// const mint = await getMint(connection, info.mint);
		const balance = amount1;
		console.log("balance", balance);
		if (Number(tokenInLamports) > balance) {
			return res.status(400).json({ message: "Insufficient balance" });
		}

		const transaction = new Transaction().add(
			createTransferInstruction(
				fromTokenAccount.address,
				toTokenAccount.address,
				feePayer.publicKey,
				Number(tokenInLamports),
				[],
				TOKEN_PROGRAM_ID
			)
		);

		const latestBlockHash = await connection.getLatestBlockhash();
		transaction.recentBlockhash = latestBlockHash.blockhash;
		transaction.feePayer = feePayer.publicKey;

		const signature = await pRetry(
			async () => {
				const sig = await sendAndConfirmTransaction(connection, transaction, [
					feePayer,
				]);
				await connection.confirmTransaction({
					signature: sig,
					lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
					blockhash: latestBlockHash.blockhash,
				});
				return sig;
			},
			{ retries: 10 }
		);

		const newTransaction = new TransactionMongo({
			userWallet: toPublicKey.toBase58(),
			transactionHash: transactionHash,
			solanaAmount: solanaAmount,
			tokenSent: tokensToSend,
			timeOfTransaction: transactionTime,
			amountInUSD: usdAmount,
			transactionStatus: "success",
		});

		await newTransaction.save();
		return signature;
	} catch (error) {
		const existingFailedTransaction = await FailedTransaction.findOne({
			transactionHash,
		});
		if (!existingFailedTransaction) {
			const failedTransaction = new FailedTransaction({
				userWallet: feePayer.publicKey.toBase58(),
				transactionHash: transactionHash,
				signature: signature,
				solanaAmount: solanaAmount,
				timeOfTransaction: new Date(),
			});

			await failedTransaction.save();
		}

		return "Failed Transaction";
	}
}
async function fetchTransactionMetadata(hash) {
	console.log("In meta data");
	const fetchedTransactionMetadata = await pRetry(
		async () => {
			console.log("In meta data Transaction");

			const transaction = await connection.getTransaction(hash);
			if (!transaction) {
				throw new Error("Transaction isn't confirmed yet");
			}
			return transaction;
		},
		{ retries: 10 }
	);
	return fetchedTransactionMetadata;
}
app.post("/send-tokens", async (req, res) => {
	try {
		const { userWallet, transactionHash, signature, message } = req.body;
		const existingTransaction = await TransactionMongo.findOne({
			transactionHash,
		});
		if (existingTransaction) {
			return res.status(400).json({ error: "Transaction already processed" });
		}
		const userPublicKey = new PublicKey(userWallet);
		const messageEcoded = new TextEncoder().encode(message);
		const uint8arraySignature = bs58.decode(signature);
		const isVerified = nacl.sign.detached.verify(
			messageEcoded,
			uint8arraySignature,
			userPublicKey.toBuffer()
		);
		console.log("isVerified", isVerified);
		if (!isVerified) {
			return res.status(400).json({ error: "Invalid Transaction" });
		}

		const hash = await transferTokens(
			userPublicKey,
			transactionHash,
			signature
		);
		if (hash == "Transaction not found") {
			return res.status(404).json({ message: "Transaction not found" });
		}
		if (hash == "Invalid Transaction") {
			return res.status(400).json({ message: "Invalid Transaction" });
		}
		res.status(200).json({ message: "Tokens sent successfully", hash });
	} catch (error) {
		console.error(error);
		res
			.status(500)
			.json({ message: "An error occurred", error: error.message });
	}
});

cron.schedule("*/10 * * * *", async () => {
	console.log("Running cron job");
	try {
		const failedTransactions = await FailedTransaction.find();
		for (const failedTransaction of failedTransactions) {
			try {
				const { userWallet, transactionHash, solanaAmount, signature } =
					failedTransaction;

				// Assuming transferTokens is a function that processes the transaction
				const userPublicKey = new PublicKey(userWallet);
				const hash = await transferTokens(
					userPublicKey,
					transactionHash,
					signature
				);
				if (hash == "Transaction not found") {
					return res.status(404).json({ message: "Transaction not found" });
				}
				if (hash == "Invalid Transaction") {
					return res.status(400).json({ message: "Invalid Transaction" });
				}

				const newTransaction = new TransactionMongo({
					userWallet: userWallet,
					transactionHash: hash,
					solanaAmount: solanaAmount,
					tokenSent: solanaAmount, // Assuming tokenSent is the same as solanaAmount
					timeOfTransaction: new Date(),
					amountInUSD: solanaAmount * solanaUsdPrice, // Assuming solanaUsdPrice is available
					transactionStatus: "success",
				});

				await newTransaction.save();
				await FailedTransaction.deleteOne({ _id: failedTransaction._id });

				console.log(
					`Successfully processed failed transaction: ${transactionHash}`
				);
			} catch (error) {
				console.error(
					`Error processing failed transaction: ${failedTransaction.transactionHash}`,
					error
				);
			}
		}
	} catch (error) {
		console.error("Error fetching failed transactions:", error);
	}
	console.log("Cron job completed");
});

app.get("/total-collected-amount", async (req, res) => {
	try {
		const transactions = await TransactionMongo.find();
		const totalAmountInUSD = transactions.reduce((sum, transaction) => {
			return sum + transaction.amountInUSD;
		}, 0);
		const totalTokenSent = transactions.reduce((sum, transaction) => {
			return sum + transaction.tokenSent;
		}, 0);
		res.status(200).json({
			total_amount_in_usd: totalAmountInUSD,
			total_token_sent: totalTokenSent,
		});
	} catch (error) {
		console.error("Error fetching transactions:", error);
		res
			.status(500)
			.json({ message: "An error occurred", error: error.message });
	}
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	mongoose
		.connect(`${process.env.MONGODB_URI}`, {
			useNewUrlParser: true,
			useUnifiedTopology: true,
		})
		.then(() => {
			console.log("Connected to MongoDB and using/created db TherapyDogCoin");
		})
		.catch((error) => {
			console.error("Error connecting to MongoDB:", error.message);
		});
	console.log(`Server is running on port ${PORT}`);
});
