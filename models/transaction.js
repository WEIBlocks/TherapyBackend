import mongoose from "mongoose";

const transactionSchema = new mongoose.Schema({
	userWallet: {
		type: String,
		required: true,
	},
	transactionHash: {
		type: String,
		required: true,
	},
	solanaAmount: {
		type: Number,
		required: true,
	},
	tokenSent: {
		type: Number,
		required: true,
	},
	timeOfTransaction: {
		type: Number,
		required: true,
	},
	amountInUSD: {
		type: Number,
		required: true,
	},
	transactionStatus: {
		type: String,
		required: true,
	},
});

const TransactionMongo = mongoose.model("Transaction", transactionSchema);

export default TransactionMongo;
