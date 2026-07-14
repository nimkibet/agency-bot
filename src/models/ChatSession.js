const mongoose = require('mongoose');

const chatSessionSchema = new mongoose.Schema({
    jid: { type: String, required: true, unique: true },
    botMode: { type: String, enum: ['ai', 'human'], default: 'ai' },
    pausedUntil: { type: Date }
});

module.exports = mongoose.model('ChatSession', chatSessionSchema);
