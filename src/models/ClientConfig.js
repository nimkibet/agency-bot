const mongoose = require('mongoose');

const clientConfigSchema = new mongoose.Schema({
    botNumber: { type: String, required: true, unique: true },
    adminGroupId: { type: String },
    status: { type: String, enum: ['trial', 'active', 'suspended'], default: 'trial' },
    trialStartDate: { type: Date, default: Date.now },
    paymentConfirmed: { type: Boolean, default: false }
});

module.exports = mongoose.model('ClientConfig', clientConfigSchema);
