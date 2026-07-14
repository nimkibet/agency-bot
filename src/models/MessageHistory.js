const mongoose = require('mongoose');

const messageHistorySchema = new mongoose.Schema({
    jid: { type: String, required: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
});

messageHistorySchema.index({ jid: 1, timestamp: 1 });

module.exports = mongoose.model('MessageHistory', messageHistorySchema);
