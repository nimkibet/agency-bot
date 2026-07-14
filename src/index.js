// backend/src/index.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5005;

// Middleware
app.use(cors({
    origin: ['https://whats-app-one-green.vercel.app', 'http://localhost:3000'],
    credentials: true
}));
app.use(express.json());

// In-Memory Session Manager for active Baileys sockets
// Key: tenantId, Value: { sock, status, pairingCode }
const activeSessions = new Map();

// --- MONGOOSE SCHEMAS ---
const TenantConfigSchema = new mongoose.Schema({
    tenantId: { type: String, required: true, unique: true },
    businessName: String,
    whatsappNumber: String,
    botStatus: { type: String, enum: ['connected', 'connecting', 'disconnected', 'paused'], default: 'disconnected' },
    engineMode: { type: String, enum: ['ai', 'deterministic'], default: 'ai' },
    aiPrompt: { type: String, default: 'You are a helpful business assistant.' },
    fallbackMessage: { type: String, default: 'We are currently busy. We will get back to you shortly.' }
});
// Avoid OverwriteModelError
const TenantConfig = mongoose.models.TenantConfig || mongoose.model('TenantConfig', TenantConfigSchema);

// --- MOCK BAILEYS INITIALIZATION TRIGGER ---
// Replace this mock with your actual @whiskeysockets/baileys connection logic
async function initializeBaileysSession(tenantId) {
    console.log(`Starting Baileys session engine for tenant: ${tenantId}`);
    
    // Set status to connecting initially
    activeSessions.set(tenantId, { status: 'connecting', pairingCode: null });
    await TenantConfig.findOneAndUpdate({ tenantId }, { botStatus: 'connecting' }, { upsert: true });

    // Simulate generation delay (In real code, hook into connection.update and creds.update)
    setTimeout(async () => {
        const mockPairingCode = Math.random().toString(36).substring(2, 10).toUpperCase();
        activeSessions.set(tenantId, { status: 'connecting', pairingCode: mockPairingCode });
    }, 2000);
}

// --- REST API ENDPOINTS ---

// 1. Get Tenant Status and Details
app.get('/api/sessions/status/:tenantId', async (req, res) => {
    try {
        const { tenantId } = req.params;
        let config = await TenantConfig.findOne({ tenantId });
        
        if (!config) {
            config = await TenantConfig.create({ tenantId, businessName: `Tenant ${tenantId}` });
        }

        const liveSession = activeSessions.get(tenantId);
        res.json({
            config,
            liveStatus: liveSession ? liveSession.status : config.botStatus,
            pairingCode: liveSession ? liveSession.pairingCode : null
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Initiate WhatsApp Connection Link
app.post('/api/sessions/initiate', async (req, res) => {
    try {
        const { tenantId } = req.body;
        if (!tenantId) return res.status(400).json({ error: 'Tenant ID is required' });

        await initializeBaileysSession(tenantId);
        res.json({ success: true, message: 'Session initialization triggered' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. Save AI Prompt Engine Configurations
app.post('/api/config/update-prompt', async (req, res) => {
    try {
        const { tenantId, engineMode, aiPrompt, fallbackMessage } = req.body;
        
        const updatedConfig = await TenantConfig.findOneAndUpdate(
            { tenantId },
            { engineMode, aiPrompt, fallbackMessage },
            { new: true, upsert: true }
        );

        res.json({ success: true, config: updatedConfig });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. Terminate / Stop Bot Session
app.post('/api/sessions/stop', async (req, res) => {
    try {
        const { tenantId } = req.body;
        
        if (activeSessions.has(tenantId)) {
            // In real code: activeSessions.get(tenantId).sock.logout();
            activeSessions.delete(tenantId);
        }

        await TenantConfig.findOneAndUpdate({ tenantId }, { botStatus: 'disconnected' });
        res.json({ success: true, message: 'Session stopped successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Database and Server Connect
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/agency-os')
    .then(() => {
        app.listen(PORT, () => console.log(`Agency API engine actively running on port ${PORT}`));
    })
    .catch(err => console.error('Database connection crash:', err));
