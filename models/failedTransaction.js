import mongoose from "mongoose";

const failedTransactionSchema = new mongoose.Schema({
	userWallet: {
		type: String,
		required: true,
	},
	transactionHash: {
		type: String,
		required: true,
	},
	signature: {
		type: String,
		required: true,
	},
	solanaAmount: {
		type: Number,
		required: true,
	},
	timeOfTransaction: {
		type: Date,
		default: Date.now,
	},
});

const FailedTransaction = mongoose.model(
	"FailedTransaction",
	failedTransactionSchema
);

export default FailedTransaction;
